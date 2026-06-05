'use strict'
const Groq = require('groq-sdk')
const { callClaude } = require('../lib/claudeApi')
const { getWeather, formatWeatherForGroq, formatWeatherBrief } = require('./weatherService')
const { SYSTEM_CONTEXT } = require('./prompts')

// Groq остаётся только для parseScheduleTime (простая задача, 8b модель)
let groq = null
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
  return groq
}

// Per-phone rate limit: не более 5 AI-вызовов в минуту
const _rateLimits = new Map()
const isRateLimited = (phone) => {
  if (!phone) return false
  const now = Date.now()
  const rec = _rateLimits.get(phone)
  if (!rec || now > rec.resetAt) {
    _rateLimits.set(phone, { count: 1, resetAt: now + 60_000 })
    return false
  }
  if (rec.count >= 5) return true
  rec.count++
  return false
}
// Очистка старых записей каждые 10 мин
setInterval(() => {
  const now = Date.now()
  for (const [phone, rec] of _rateLimits) {
    if (now > rec.resetAt) _rateLimits.delete(phone)
  }
}, 10 * 60_000).unref()

// ─── ОТВЕТ КЛИЕНТУ (Claude Haiku) ────────────────────────────
const getGroqReply = async (text, phone) => {
  if (isRateLimited(phone)) return null
  const lo = (text || '').toLowerCase().trim()
  if (!lo || lo.length < 2) return null

  try {
    const weather = await getWeather().catch(() => null)
    const weatherStr = formatWeatherForGroq(weather)
    const h = new Date(Date.now() + 5 * 3600_000).getUTCHours() // UTC+5 Almaty
    const tod = h >= 6 && h < 12 ? 'утро' : h >= 12 && h < 17 ? 'день' : h >= 17 && h < 22 ? 'вечер' : 'ночь'

    const system = SYSTEM_CONTEXT + `

Клиент написал тебе сообщение. Ответь как живой человек, коротко.

СЕЙЧАС: ${tod} в Осакаровке.${weatherStr ? '\nПОГОДА: ' + weatherStr : ''}

КАК ОТВЕЧАТЬ:
— Спрашивает цену/тариф → назови конкретно (500 тг по посёлку, ночью дороже)
— Спрашивает где что находится → ответь если знаешь из списка мест
— Хочет заказать → спроси куда ехать
— Жалуется → прими с пониманием, скажи что разберёмся
— Благодарит → ответь тепло
— Просто болтает → поддержи 1 фразой

ФОРМАТ:
— 1-2 предложения максимум, 1 эмодзи уместно
— Живой тон, не официальный, как человек из посёлка
— В конце (если уместно): "Куда едем?" или "Напишите адрес"
— ТОЛЬКО ${''/* будет подставлен язык */}нужный язык, НОЛЬ иностранных слов`

    return await callClaude({
      system,
      messages: [{ role: 'user', content: text }],
      maxTokens: 200,
      temperature: 0.8,
    })
  } catch (e) {
    console.error('[smartReply:client]', e.message)
    return null
  }
}

// ─── ОТВЕТ ВОДИТЕЛЮ (Claude Haiku) ───────────────────────────
const getGroqDriverReply = async (text, driverName, stats, extra, phone) => {
  if (isRateLimited(phone)) return null
  const lo = (text || '').toLowerCase().trim()
  if (!lo || lo.length < 2) return null

  try {
    const weather = await getWeather().catch(() => null)
    const weatherBrief = formatWeatherBrief(weather)
    const weatherImportant = formatWeatherForGroq(weather)
    const h = new Date(Date.now() + 5 * 3600_000).getUTCHours() // UTC+5
    const tod = h >= 6 && h < 12 ? 'утро' : h >= 12 && h < 17 ? 'день' : h >= 17 && h < 22 ? 'вечер' : 'ночь'
    const queueInfo = extra?.queuePos ? `Позиция в очереди: ${extra.queuePos}-й из ${extra.queueTotal}.` : ''
    const statsInfo = stats ? `Сегодня выполнил ${stats.completed || 0} поездок, заработал ${Number(stats.earned || 0).toLocaleString()} тг.` : ''
    const statusLabel = extra?.status === 'online' ? 'на линии' : extra?.status === 'busy' ? 'в поездке' : 'офлайн'

    const system = SYSTEM_CONTEXT + `

Ты общаешься с ВОДИТЕЛЕМ, не с клиентом.

ВОДИТЕЛЬ: ${driverName || 'водитель'} | Статус: ${statusLabel} | Время суток: ${tod}
${statsInfo}
${queueInfo}
${weatherBrief ? 'Погода: ' + weatherBrief + '.' : ''}

КАК ОБЩАТЬСЯ:
— По-братски, тепло, уважительно — как с коллегой
— 1-2 предложения максимум, 1 эмодзи
— На языке водителя — русский или казахский, НИКАКОГО английского
— Жалуется на усталость → поддержи, скажи что-то доброе
— Спрашивает про заработок → ответь конкретными цифрами из статистики
— Скучает без заказов → подбодри
${weatherImportant ? '— Погода важная (' + weatherImportant + ') — упомяни если актуально' : ''}`

    return await callClaude({
      system,
      messages: [{ role: 'user', content: text }],
      maxTokens: 180,
      temperature: 0.85,
    })
  } catch (e) {
    console.error('[smartReply:driver]', e.message)
    return null
  }
}

// ─── ПАРСИНГ ВРЕМЕНИ ПРЕДЗАКАЗА (Groq 8b — простая задача) ───
const parseScheduleTime = async (text) => {
  const lo = (text || '').toLowerCase().trim()
  if (['сейчас', 'немедленно', 'прямо сейчас', 'щас'].some(w => lo.includes(w))) return 'сейчас'
  if (/^\d{1,2}$/.test(lo)) return 'сегодня в ' + lo.padStart(2, '0') + ':00'
  if (/\d{1,2}:\d{2}/.test(lo)) return text.trim()
  try {
    const h = new Date(Date.now() + 5 * 3600_000).getUTCHours()
    const nowStr = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Извлеки время. Ответь ТОЛЬКО одной строкой: "сейчас", "сегодня в ЧЧ:ММ" или "завтра в ЧЧ:ММ".
Сейчас: ${nowStr}. Через час: ${String(h + 1).padStart(2, '0')}:00.
Примеры: "в 8" → сегодня в 08:00 | "завтра в 9" → завтра в 09:00 | "через час" → сегодня в ${String(h + 1).padStart(2, '0')}:00
Непонятно → сейчас. Только строку, без пояснений.`,
      }, { role: 'user', content: text }],
      model: 'llama-3.1-8b-instant',
      max_tokens: 20,
      temperature: 0,
    })
    return r.choices[0]?.message?.content?.trim() || text
  } catch (e) { return text }
}

module.exports = { getGroqReply, getGroqDriverReply, parseScheduleTime }
