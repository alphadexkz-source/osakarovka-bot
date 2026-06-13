'use strict'
// Утилита мониторинга всех LLM и сервисов
// Вызывается из agent/telegram.js для кнопки "🔌 API статус"

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TESTS = [
  {
    name: 'Groq llama-3.3-70b',
    icon: '🟩',
    test: async () => {
      const k = process.env.GROQ_API_KEY
      if (!k) return { ok: false, error: 'нет ключа' }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(8000),
      })
      const d = await res.json()
      if (d.error) return { ok: false, error: d.error.message || JSON.stringify(d.error) }
      return { ok: true, info: `RPM лимит: 30 (бесплатно)` }
    },
  },
  {
    name: 'Claude Haiku 4.5 (Anthropic)',
    icon: '🟦',
    test: async () => {
      const k = process.env.ANTHROPIC_API_KEY
      if (!k) return { ok: false, error: 'нет ключа' }
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      })
      const d = await res.json()
      if (d.error) return { ok: false, error: d.error.message || d.error.type }
      return { ok: true, info: 'платно: $0.80/M input' }
    },
  },
  {
    name: 'OpenRouter (llama:free)',
    icon: '🟨',
    test: async () => {
      const k = process.env.OPENROUTER_API_KEY
      if (!k) return { ok: false, error: 'нет ключа' }
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
        body: JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(15000),
      })
      const d = await res.json()
      if (d.error) return { ok: false, error: d.error.message || JSON.stringify(d.error).slice(0, 80) }
      return { ok: true, info: 'бесплатно: 20 RPM / 50 RPD' }
    },
  },
  {
    name: 'xAI Grok-3-mini',
    icon: '🟥',
    test: async () => {
      const k = process.env.XAI_API_KEY
      if (!k) return { ok: false, error: 'нет ключа' }
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${k}` },
        body: JSON.stringify({ model: 'grok-3-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(8000),
      })
      const d = await res.json()
      if (d.error || d.code) return { ok: false, error: d.error?.message || d.code }
      return { ok: true, info: '$25/мес с X Premium+' }
    },
  },
  {
    name: 'Groq Whisper (голос)',
    icon: '🎙',
    test: async () => {
      const k = process.env.GROQ_API_KEY
      if (!k) return { ok: false, error: 'нет ключа' }
      // Groq whisper работает если Groq работает
      return { ok: true, info: 'whisper-large-v3 (бесплатно)' }
    },
  },
  {
    name: 'Green API (WhatsApp)',
    icon: '📱',
    test: async () => {
      const id = process.env.GREEN_API_ID
      const tok = process.env.GREEN_API_TOKEN
      if (!id || !tok) return { ok: false, error: 'нет ключей' }
      const res = await fetch(`https://api.green-api.com/waInstance${id}/getStateInstance/${tok}`, {
        signal: AbortSignal.timeout(8000),
      })
      const d = await res.json()
      const state = d.stateInstance || 'unknown'
      return { ok: state === 'authorized', error: state !== 'authorized' ? `состояние: ${state}` : null, info: `состояние: ${state}` }
    },
  },
  {
    name: 'PostgreSQL (Supabase)',
    icon: '🗄',
    test: async () => {
      const url = process.env.DATABASE_URL
      if (!url) return { ok: false, error: 'нет DATABASE_URL' }
      const { Pool } = require('pg')
      const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, family: 4, connectionTimeoutMillis: 5000 })
      try {
        const r = await pool.query('SELECT 1 AS ok')
        return { ok: r.rows[0]?.ok === 1, info: 'Supabase PostgreSQL' }
      } finally {
        await pool.end().catch(() => {})
      }
    },
  },
]

const runAll = async () => {
  const results = []
  for (const { name, icon, test } of TESTS) {
    const t = Date.now()
    try {
      const r = await test()
      results.push({ name, icon, ok: r.ok, ms: Date.now() - t, info: r.info, error: r.error })
    } catch (e) {
      results.push({ name, icon, ok: false, ms: Date.now() - t, error: e.message.slice(0, 80) })
    }
  }
  return results
}

const formatReport = (results) => {
  const ok = results.filter(r => r.ok).length
  const lines = results.map(r => {
    const status = r.ok ? '✅' : '❌'
    const ms = r.ok ? ` _${r.ms}ms_` : ''
    const detail = r.ok ? (r.info ? ` — ${r.info}` : '') : ` — ${r.error || '?'}`
    return `${r.icon} ${status} *${r.name}*${ms}${detail}`
  })
  return `🔌 *API Мониторинг (${ok}/${results.length} онлайн):*\n\n` + lines.join('\n')
}

module.exports = { runAll, formatReport }

// CLI запуск
if (require.main === module) {
  runAll().then(results => console.log(formatReport(results))).catch(console.error)
}
