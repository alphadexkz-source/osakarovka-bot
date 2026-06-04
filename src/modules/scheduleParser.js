'use strict'

const ALMATY_OFFSET = 5 * 60 * 60 * 1000 // UTC+5

// Паттерны для inline-детектирования в конце сообщения
const INLINE_PATTERNS = [
  // "завтра в 8", "завтра в 14:30", "ертен в 9" — в конце строки
  { re: /\s+(?:завтра|ертен)\s+в\s+(\d{1,2})(?::(\d{2}))?\s*$/i, tomorrow: true },
  // "в 8 утра", "в 14:30 вечером" — требует квалификатор времени чтобы избежать "в магазин"
  { re: /\s+в\s+(\d{1,2})(?::(\d{2}))?\s+(?:утра?|утром|вечера?|вечером|часов|час)\s*$/i, tomorrow: false },
]

/**
 * Пробует найти время в конце сообщения и извлечь чистый адрес.
 * Возвращает { cleanAddress, scheduledFor, label } или null.
 */
const detectInlineSchedule = (text) => {
  if (!text) return null

  for (const { re, tomorrow } of INLINE_PATTERNS) {
    const m = text.match(re)
    if (!m) continue

    const hours   = parseInt(m[1], 10)
    const minutes = parseInt(m[2] || '0', 10)
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) continue

    const cleanAddress = text.replace(m[0], '').trim()
    if (!cleanAddress || cleanAddress.length < 2) continue

    const scheduledFor = _buildDate(hours, minutes, tomorrow)
    if (!scheduledFor) continue

    return { cleanAddress, scheduledFor, label: formatScheduleLabel(scheduledFor) }
  }
  return null
}

/**
 * Конвертирует строку от Groq ("завтра в 08:00", "сегодня в 14:30") в Date (UTC).
 * Возвращает null для "сейчас" или при ошибке парсинга.
 */
const parseScheduleDate = (str) => {
  if (!str || str === 'сейчас') return null
  const m = str.match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const hours    = parseInt(m[1], 10)
  const minutes  = parseInt(m[2], 10)
  const tomorrow = /^завтра/.test(str.trim())
  return _buildDate(hours, minutes, tomorrow)
}

/**
 * Форматирует UTC Date в человекочитаемую метку в алматинском времени.
 * Например: "завтра в 08:00" или "сегодня в 14:30"
 */
const formatScheduleLabel = (date) => {
  if (!date) return 'сейчас'
  const almatyDate    = new Date(new Date(date).getTime() + ALMATY_OFFSET)
  const nowAlmaty     = new Date(Date.now() + ALMATY_OFFSET)
  const tomAlmaty     = new Date(nowAlmaty.getTime() + 86_400_000)

  const hh = String(almatyDate.getUTCHours()).padStart(2, '0')
  const mm = String(almatyDate.getUTCMinutes()).padStart(2, '0')
  const timeStr = `${hh}:${mm}`

  if (almatyDate.toDateString() === nowAlmaty.toDateString()) return `сегодня в ${timeStr}`
  if (almatyDate.toDateString() === tomAlmaty.toDateString())  return `завтра в ${timeStr}`
  const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
  return `${days[almatyDate.getUTCDay()]} в ${timeStr}`
}

/** Минут до запланированного времени (отрицательное — прошло). */
const minutesUntil = (date) => Math.round((new Date(date) - Date.now()) / 60_000)

// ─── Internal ────────────────────────────────────────────────────

const _buildDate = (hours, minutes, tomorrow) => {
  const nowAlmaty = new Date(Date.now() + ALMATY_OFFSET)
  const target    = new Date(nowAlmaty)
  target.setUTCHours(hours, minutes, 0, 0)

  if (tomorrow) target.setUTCDate(target.getUTCDate() + 1)
  else if (target <= nowAlmaty) target.setUTCDate(target.getUTCDate() + 1) // прошло сегодня → завтра

  // Не принимаем время дальше 7 дней
  if (target.getTime() - Date.now() > 7 * 86_400_000) return null

  return new Date(target.getTime() - ALMATY_OFFSET) // обратно в UTC
}

module.exports = { detectInlineSchedule, parseScheduleDate, formatScheduleLabel, minutesUntil }
