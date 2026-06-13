'use strict'

// LLM для чата с клиентами (Айгуль): Groq → Cerebras → xAI → OpenRouter
// Groq бесплатный, 30 RPM, llama-3.3-70b — отличное качество для чата

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
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
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
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return data.choices?.[0]?.message?.content?.trim() || null
}

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
    signal: AbortSignal.timeout(10000),
  })
  const data = await res.json()
  if (data.error || data.code) throw new Error(data.error?.message || data.code)
  return data.choices?.[0]?.message?.content?.trim() || null
}

const callOpenRouter = async ({ system, messages, maxTokens, temperature }) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY не задан')
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.3-70b-instruct:free',
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal: AbortSignal.timeout(12000),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return data.choices?.[0]?.message?.content?.trim() || null
}

// Цепочка: Groq (primary) → Cerebras → xAI → OpenRouter
const callClaude = async ({ system, messages, maxTokens = 250, temperature = 0.8 }) => {
  const args = { system, messages, maxTokens, temperature }
  const providers = [
    { name: 'Groq',       fn: callGroq       },
    { name: 'Cerebras',   fn: callCerebras   },
    { name: 'xAI',        fn: callXai        },
    { name: 'OpenRouter', fn: callOpenRouter },
  ]
  for (const { name, fn } of providers) {
    try {
      const r = await fn(args)
      if (r) return r
    } catch (e) {
      console.warn(`[claudeApi] ${name} ошибка: ${e.message}`)
    }
  }
  return null
}

module.exports = { callClaude, MODEL: 'groq-llama-3.3-70b' }
