'use strict'

// xAI Grok — основной AI для чата клиентов и водителей (заменил Claude Haiku)
// OpenAI-совместимый API, $25/мес кредитов с X Premium

const MODEL = 'grok-3'

const callClaude = async ({ system, messages, maxTokens = 250, temperature = 0.8 }) => {
  const apiKey = process.env.XAI_API_KEY
  if (!apiKey) throw new Error('XAI_API_KEY не задан')

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        ...messages,
      ],
    }),
    signal: AbortSignal.timeout(12000),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`xAI API ${res.status}: ${err.error?.message || res.statusText}`)
  }

  const data = await res.json()
  return data.choices?.[0]?.message?.content?.trim() || null
}

module.exports = { callClaude, MODEL }
