'use strict'

// Основной LLM для чата (Айгуль): xAI Grok → Groq llama-3.3-70b → Cerebras
// Цепочка fallback на случай отсутствия кредитов / rate limit

const callXai = async ({ system, messages, maxTokens, temperature }) => {
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) throw new Error('XAI_API_KEY не задан')
  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'grok-3-mini',
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await res.json()
  if (data.error || data.code) throw new Error(data.error?.message || data.error || data.code)
  return data.choices?.[0]?.message?.content?.trim() || null
}

const callGroq = async ({ system, messages, maxTokens, temperature }) => {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('GROQ_API_KEY не задан')
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || data.error)
  return data.choices?.[0]?.message?.content?.trim() || null
}

const callCerebras = async ({ system, messages, maxTokens, temperature }) => {
  const apiKey = process.env.CEREBRAS_API_KEY
  if (!apiKey) throw new Error('CEREBRAS_API_KEY не задан')
  const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'llama-3.3-70b',
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || data.error)
  return data.choices?.[0]?.message?.content?.trim() || null
}

const callClaude = async ({ system, messages, maxTokens = 250, temperature = 0.8 }) => {
  const args = { system, messages, maxTokens, temperature }

  // 1. Пробуем xAI Grok (grok-3-mini — бесплатный tier)
  try {
    const r = await callXai(args)
    if (r) return r
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('[claudeApi] xAI:', e.message)
  }

  // 2. Fallback: Groq llama-3.3-70b
  try {
    const r = await callGroq(args)
    if (r) return r
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') console.warn('[claudeApi] Groq:', e.message)
  }

  // 3. Fallback: Cerebras
  try {
    const r = await callCerebras(args)
    if (r) return r
  } catch (e) {
    console.warn('[claudeApi] Cerebras:', e.message)
  }

  return null
}

module.exports = { callClaude, MODEL: 'grok-3-mini→groq-llama→cerebras' }
