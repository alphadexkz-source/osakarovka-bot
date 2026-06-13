'use strict'
// Интеграция с 10b.kz MCP — госзакуп и самрук-казына
// OAuth 2.0 Authorization Code + PKCE + MCP JSON-RPC over HTTP

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
const crypto = require('crypto')
const { Pool } = require('pg')

const MCP_URL    = 'https://mcp.10b.kz/mcp'
const AUTH_URL   = 'https://mcp.10b.kz/mcp/authorize'
const TOKEN_URL  = 'https://mcp.10b.kz/mcp/token'
const CLIENT_ID  = process.env.TENDER_CLIENT_ID
const CLIENT_SECRET = process.env.TENDER_CLIENT_SECRET
const REDIRECT_URI  = process.env.TENDER_REDIRECT_URI || 'http://34.40.3.202:3000/tender/callback'

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  max: 2,
})

// ─── Settings DB helpers ─────────────────────────────────────
const getSetting = async (key) => {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key])
  return r.rows[0]?.value || null
}
const setSetting = async (key, value) => {
  await db.query(
    `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=$2`,
    [key, value]
  )
}

// ─── Token management ────────────────────────────────────────
const getAccessToken = async () => {
  const token = await getSetting('tender_access_token')
  if (!token) return null

  const expires = await getSetting('tender_token_expires')
  if (expires && Date.now() > Number(expires) - 60000) {
    const refresh = await getSetting('tender_refresh_token')
    if (!refresh) return null
    try { return await _refreshToken(refresh) } catch(_) { return null }
  }
  return token
}

const saveTokens = async (access, refresh, expiresIn = 3600) => {
  await Promise.all([
    setSetting('tender_access_token', access),
    setSetting('tender_refresh_token', refresh || ''),
    setSetting('tender_token_expires', String(Date.now() + expiresIn * 1000)),
  ])
}

const _refreshToken = async (refresh) => {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }).toString(),
    signal: AbortSignal.timeout(10000),
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error_description || d.error)
  await saveTokens(d.access_token, d.refresh_token, d.expires_in)
  return d.access_token
}

// ─── PKCE helpers ────────────────────────────────────────────
const generatePkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

// ─── OAuth flow ──────────────────────────────────────────────
const getAuthUrl = async () => {
  if (!CLIENT_ID) return null
  const { verifier, challenge } = generatePkce()
  // Сохраняем verifier в БД — нужен при обмене кода на токен
  await setSetting('tender_code_verifier', verifier)
  return `${AUTH_URL}?` + new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: 'mcp',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString()
}

const exchangeCode = async (code) => {
  const verifier = await getSetting('tender_code_verifier')
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  })
  if (verifier) body.append('code_verifier', verifier)
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(10000),
  })
  const d = await r.json()
  if (d.error) throw new Error(d.error_description || d.error)
  await saveTokens(d.access_token, d.refresh_token, d.expires_in)
  // Убираем использованный verifier
  await setSetting('tender_code_verifier', '')
  return true
}

const isAuthorized = async () => !!(await getAccessToken())

const revokeAuth = async () => {
  await Promise.all([
    setSetting('tender_access_token', ''),
    setSetting('tender_refresh_token', ''),
    setSetting('tender_token_expires', '0'),
  ])
}

// ─── MCP core ────────────────────────────────────────────────
const mcpPost = async (method, params, token) => {
  const r = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params: params || {}, id: Date.now() }),
    signal: AbortSignal.timeout(12000),
  })

  const ct = r.headers.get('content-type') || ''

  if (ct.includes('text/event-stream')) {
    // Читаем SSE: берём первый валидный результат, не ждём конца потока
    const text = await r.text()
    for (const block of text.split('\n\n')) {
      const dataLine = block.split('\n').find(l => l.startsWith('data: '))
      if (!dataLine) continue
      try {
        const parsed = JSON.parse(dataLine.slice(6))
        if (parsed.result !== undefined) return parsed.result
        if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error))
      } catch(e) { if (e.message !== 'Unexpected token') throw e }
    }
    return null
  }

  const data = await r.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return data.result
}

// ─── Public API ──────────────────────────────────────────────
const listTools = async () => {
  const token = await getAccessToken()
  if (!token) throw new Error('Нет токена. Нажмите 🔑 Авторизоваться')
  // initialize не требуется — 10b.kz работает без него
  const res = await mcpPost('tools/list', {}, token)
  return res?.tools || []
}

const callTool = async (toolName, args = {}) => {
  const token = await getAccessToken()
  if (!token) throw new Error('Нет токена. Нажмите 🔑 Авторизоваться')
  const res = await mcpPost('tools/call', { name: toolName, arguments: args }, token)
  if (!res) return '(пустой ответ)'
  if (Array.isArray(res.content)) {
    return res.content.map(c => c.text || c.data || JSON.stringify(c)).join('\n')
  }
  return typeof res === 'string' ? res : JSON.stringify(res, null, 2)
}

module.exports = { getAuthUrl, exchangeCode, isAuthorized, revokeAuth, listTools, callTool }
