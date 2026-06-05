'use strict'

// Claude Haiku 4.5 — основной AI для чата клиентов и водителей
// Prompt caching: системный промпт кешируется 5 мин → экономия 90% токенов при повторных вызовах

const MODEL = 'claude-haiku-4-5-20251001'

const callClaude = async ({ system, messages, maxTokens = 250, temperature = 0.8 }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    }),
    signal: AbortSignal.timeout(12000),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Claude API ${res.status}: ${err.error?.message || res.statusText}`)
  }

  const data = await res.json()
  return data.content?.[0]?.text?.trim() || null
}

module.exports = { callClaude, MODEL }
