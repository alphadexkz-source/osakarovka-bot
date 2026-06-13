'use strict'

// LLM цепочка для Айгуль (чат с клиентами):
// Groq (бесплатно, 30 RPM) → Gemini 2.5 Flash (бесплатно, 15 RPM) → LLM7.io (бесплатно, без ключа) → Claude Haiku (платно, последний резерв)

const PROVIDERS = {
  groq: {
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    getKey: () => process.env.GROQ_API_KEY,
    auth: (k) => `Bearer ${k}`,
    toBody: (model, maxTokens, temperature, messages) => ({ model, max_tokens: maxTokens, temperature, messages }),
    fromResp: (d) => d.choices?.[0]?.message?.content?.trim() || null,
  },
  gemini: {
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    model: 'gemini-2.5-flash',
    getKey: () => process.env.GEMINI_API_KEY,
    auth: (k) => `Bearer ${k}`,
    toBody: (model, maxTokens, temperature, messages) => ({ model, max_tokens: maxTokens, temperature, messages }),
    fromResp: (d) => d.choices?.[0]?.message?.content?.trim() || null,
  },
  llm7io: {
    url: 'https://api.llm7.io/v1/chat/completions',
    model: 'deepseek-v4-flash',
    getKey: () => 'no-key',
    auth: () => 'Bearer no-key',
    toBody: (model, maxTokens, temperature, messages) => ({ model, max_tokens: maxTokens, temperature, messages }),
    fromResp: (d) => d.choices?.[0]?.message?.content?.trim() || null,
  },
  haiku: {
    url: 'https://api.anthropic.com/v1/messages',
    model: 'claude-haiku-4-5-20251001',
    getKey: () => process.env.ANTHROPIC_API_KEY,
    headers: (k) => ({ 'Content-Type': 'application/json', 'x-api-key': k, 'anthropic-version': '2023-06-01' }),
    toBody: (model, maxTokens, temperature, system, messages) => ({ model, max_tokens: maxTokens, temperature, system, messages }),
    fromResp: (d) => d.content?.[0]?.text?.trim() || null,
    isAnthropic: true,
  },
}

const callProvider = async (name, { system, messages, maxTokens, temperature }) => {
  const p = PROVIDERS[name]
  const key = p.getKey()
  if (!key) throw new Error(`${name}: ключ не задан`)

  const headers = p.headers ? p.headers(key) : { 'Content-Type': 'application/json', 'Authorization': p.auth(key) }
  const body = p.isAnthropic
    ? p.toBody(p.model, maxTokens, temperature, system, messages)
    : p.toBody(p.model, maxTokens, temperature, [{ role: 'system', content: system }, ...messages])

  const res = await fetch(p.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json()
  if (data.error || data.code) throw new Error(data.error?.message || data.error?.type || data.code)
  const result = p.fromResp(data)
  if (!result) throw new Error(`${name}: пустой ответ`)
  return result
}

const callClaude = async ({ system, messages, maxTokens = 250, temperature = 0.8 }) => {
  const chain = ['groq', 'gemini', 'llm7io', 'haiku']
  for (const name of chain) {
    try {
      return await callProvider(name, { system, messages, maxTokens, temperature })
    } catch (e) {
      console.warn(`[claudeApi] ${name}: ${e.message}`)
    }
  }
  return null
}

// Для инструмента мониторинга — тестирует конкретного провайдера
const testProvider = async (name) => {
  const t = Date.now()
  try {
    const r = await callProvider(name, {
      system: 'Ты помощник.',
      messages: [{ role: 'user', content: 'ping' }],
      maxTokens: 10,
      temperature: 0.1,
    })
    return { ok: true, ms: Date.now() - t, response: r }
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: e.message }
  }
}

module.exports = { callClaude, testProvider, PROVIDERS, MODEL: 'groq→gemini→llm7io→haiku' }
