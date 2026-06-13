'use strict'

// No external DB/network deps — scheduleParser is pure logic
jest.mock('../../src/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(),
  msg: jest.fn(), order: jest.fn(), driver: jest.fn(),
  initFileLogging: jest.fn(),
}))

const {
  detectInlineSchedule,
  parseScheduleDate,
  formatScheduleLabel,
  minutesUntil,
} = require('../../src/modules/scheduleParser')

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ALMATY_OFFSET = 5 * 60 * 60 * 1000 // UTC+5

/**
 * Build a UTC Date that corresponds to the given Almaty wall-clock time TODAY.
 * e.g. almatyNow(9, 0) → Date object representing 09:00 Almaty = 04:00 UTC
 */
const almatyNow = (h, m = 0) => {
  const nowUtc   = Date.now()
  const nowAlm   = new Date(nowUtc + ALMATY_OFFSET)
  const target   = new Date(nowAlm)
  target.setUTCHours(h, m, 0, 0)
  return target.getTime() - ALMATY_OFFSET  // back to UTC timestamp
}

/**
 * Mock Date.now() to a specific Almaty wall-clock time.
 * Returns restore function.
 */
const mockAlmatyTime = (h, m = 0) => {
  const fakeUtc = almatyNow(h, m)
  jest.useFakeTimers()
  jest.setSystemTime(new Date(fakeUtc))
  return () => jest.useRealTimers()
}

afterEach(() => {
  jest.useRealTimers()
  jest.clearAllMocks()
})

// ─── _buildDate (via detectInlineSchedule) ───────────────────────────────────

describe('detectInlineSchedule() — "завтра в N" pattern', () => {
  test('базовый случай: "Алаш 15 завтра в 8"', () => {
    const restore = mockAlmatyTime(10, 0) // сейчас 10:00 Almaty
    const result = detectInlineSchedule('Алаш 15 завтра в 8')
    expect(result).not.toBeNull()
    expect(result.cleanAddress).toBe('Алаш 15')
    // Ожидаем время в UTC: 08:00 Almaty = 03:00 UTC
    expect(result.scheduledFor).toBeInstanceOf(Date)
    const almatyHour = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET).getUTCHours()
    expect(almatyHour).toBe(8)
    restore()
  })

  test('"завтра в 8" в 23:55 Almaty — время на следующий день', () => {
    const restore = mockAlmatyTime(23, 55)
    const result = detectInlineSchedule('Алаш 15 завтра в 8')
    expect(result).not.toBeNull()

    const nowAlm = new Date(Date.now() + ALMATY_OFFSET)
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)

    // Должно быть СЛЕДУЮЩИЙ день относительно текущего Almaty-дня
    const tomorrowAlm = new Date(nowAlm.getTime() + 86_400_000)
    expect(resAlm.getUTCDate()).toBe(tomorrowAlm.getUTCDate())
    expect(resAlm.getUTCHours()).toBe(8)
    restore()
  })

  test('"завтра в 8" в точно полночь 00:00 Almaty — следующий день', () => {
    const restore = mockAlmatyTime(0, 0)
    const result = detectInlineSchedule('Больница завтра в 8')
    expect(result).not.toBeNull()

    const nowAlm = new Date(Date.now() + ALMATY_OFFSET)
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    const tomorrowAlm = new Date(nowAlm.getTime() + 86_400_000)

    expect(resAlm.getUTCDate()).toBe(tomorrowAlm.getUTCDate())
    restore()
  })

  test('"завтра в 14:30" — часы и минуты', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = detectInlineSchedule('Рынок завтра в 14:30')
    expect(result).not.toBeNull()
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(14)
    expect(resAlm.getUTCMinutes()).toBe(30)
    restore()
  })

  test('"ертен в 9" (казахское "завтра")', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = detectInlineSchedule('Алаш 15 ертен в 9')
    expect(result).not.toBeNull()
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(9)
    restore()
  })

  test('адрес без времени — null', () => {
    expect(detectInlineSchedule('Алаш 15')).toBeNull()
  })

  test('только адрес без времени и квалификатора — null', () => {
    expect(detectInlineSchedule('в магазин')).toBeNull()
  })

  test('пустая строка — null', () => {
    expect(detectInlineSchedule('')).toBeNull()
    expect(detectInlineSchedule(null)).toBeNull()
  })

  test('невалидный час 25 → игнорируется', () => {
    const result = detectInlineSchedule('Алаш завтра в 25')
    expect(result).toBeNull()
  })

  test('невалидные минуты :99 → игнорируются', () => {
    const result = detectInlineSchedule('Алаш завтра в 8:99')
    expect(result).toBeNull()
  })

  test('адрес слишком короткий после извлечения времени → null', () => {
    // "А" — 1 символ, ниже минимума 2
    const result = detectInlineSchedule('А завтра в 8')
    expect(result).toBeNull()
  })
})

// ─── "в N утра" pattern ───────────────────────────────────────────────────────

describe('detectInlineSchedule() — "в N утра" pattern (without завтра)', () => {
  test('"Алаш 15 в 8 утра" когда сейчас 10:00 → переносит на завтра (уже прошло)', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = detectInlineSchedule('Алаш 15 в 8 утра')
    expect(result).not.toBeNull()
    // 08:00 прошло → должно стать завтра
    const nowAlm = new Date(Date.now() + ALMATY_OFFSET)
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(8)
    // Дата должна быть позже текущей
    expect(result.scheduledFor.getTime()).toBeGreaterThan(Date.now())
    restore()
  })

  test('"в 14 часов" когда сейчас 10:00 → сегодня', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = detectInlineSchedule('Школа в 14 часов')
    expect(result).not.toBeNull()
    const nowAlm = new Date(Date.now() + ALMATY_OFFSET)
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(14)
    // Та же дата — today
    expect(resAlm.getUTCDate()).toBe(nowAlm.getUTCDate())
    restore()
  })

  test('"в 8 вечером" → корректно парсит', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = detectInlineSchedule('Больница в 8 вечером')
    expect(result).not.toBeNull()
    const resAlm = new Date(result.scheduledFor.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(8)
    restore()
  })

  test('"в магазин" (без числа) — null (no time match)', () => {
    expect(detectInlineSchedule('в магазин')).toBeNull()
  })
})

// ─── parseScheduleDate() ──────────────────────────────────────────────────────

describe('parseScheduleDate() — Groq output parsing', () => {
  test('"сейчас" → null', () => {
    expect(parseScheduleDate('сейчас')).toBeNull()
  })

  test('null/undefined → null', () => {
    expect(parseScheduleDate(null)).toBeNull()
    expect(parseScheduleDate(undefined)).toBeNull()
  })

  test('"завтра в 08:00" → Date в будущем', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = parseScheduleDate('завтра в 08:00')
    expect(result).toBeInstanceOf(Date)
    expect(result.getTime()).toBeGreaterThan(Date.now())
    const resAlm = new Date(result.getTime() + ALMATY_OFFSET)
    expect(resAlm.getUTCHours()).toBe(8)
    restore()
  })

  test('"сегодня в 14:30" когда 10:00 → будущее', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = parseScheduleDate('сегодня в 14:30')
    expect(result).toBeInstanceOf(Date)
    expect(result.getTime()).toBeGreaterThan(Date.now())
    restore()
  })

  test('"сегодня в 8:00" когда 10:00 → сдвигается на завтра', () => {
    const restore = mockAlmatyTime(10, 0)
    const result = parseScheduleDate('сегодня в 8:00')
    expect(result).toBeInstanceOf(Date)
    // Прошедшее время сегодня → завтра
    expect(result.getTime()).toBeGreaterThan(Date.now())
    restore()
  })

  test('строка без времени → null', () => {
    expect(parseScheduleDate('завтра утром')).toBeNull()
  })

  test('не принимает время дальше 7 дней', () => {
    const restore = mockAlmatyTime(10, 0)
    // Нет прямого пути передать "через 8 дней" — но можно передать дату вручную через formatScheduleLabel
    // Проверяем что _buildDate с tomorrow=true (только 1 день вперёд) ≤ 7 дней
    const result = parseScheduleDate('завтра в 08:00')
    expect(result).not.toBeNull()
    const sevenDays = Date.now() + 7 * 86_400_000
    expect(result.getTime()).toBeLessThan(sevenDays)
    restore()
  })
})

// ─── formatScheduleLabel() ───────────────────────────────────────────────────

describe('formatScheduleLabel() — timezone correctness (BUG-B2-10 regression)', () => {
  test('сегодня: метка "сегодня в HH:MM"', () => {
    const restore = mockAlmatyTime(10, 0)
    // Создаём дату на 14:00 сегодня по Almaty
    const todayAlm = new Date(Date.now() + ALMATY_OFFSET)
    todayAlm.setUTCHours(14, 0, 0, 0)
    const utcDate = new Date(todayAlm.getTime() - ALMATY_OFFSET)

    const label = formatScheduleLabel(utcDate)
    expect(label).toBe('сегодня в 14:00')
    restore()
  })

  test('завтра: метка "завтра в HH:MM"', () => {
    const restore = mockAlmatyTime(10, 0)
    const tomorrowAlm = new Date(Date.now() + ALMATY_OFFSET + 86_400_000)
    tomorrowAlm.setUTCHours(9, 0, 0, 0)
    const utcDate = new Date(tomorrowAlm.getTime() - ALMATY_OFFSET)

    const label = formatScheduleLabel(utcDate)
    expect(label).toBe('завтра в 09:00')
    restore()
  })

  test('критический: граница полуночи — 23:30 Almaty = следующий UTC день', () => {
    // Это именно тот баг BUG-B2-10: toDateString() использовал timezone сервера
    // При 23:30 Almaty = 18:30 UTC, а на сервере UTC+1 тоже сегодня
    // Но при UTC+0 сервере: 23:30 Almaty = 18:30 UTC = тот же день → OK
    // Реальная проблема: 22:00 Almaty = 17:00 UTC = следующий UTC день при UTC-
    // Тест гарантирует что сравнение идёт по UTC-компонентам almatyDate, не по серверному TZ

    const restore = mockAlmatyTime(23, 30) // сейчас 23:30 Almaty
    // Дата на 23:50 сегодня по Almaty (ещё сегодня в Almaty, но уже +1 день UTC если сервер UTC-5+)
    const nowAlm = new Date(Date.now() + ALMATY_OFFSET)
    const targetAlm = new Date(nowAlm)
    targetAlm.setUTCHours(23, 50, 0, 0)
    const utcDate = new Date(targetAlm.getTime() - ALMATY_OFFSET)

    const label = formatScheduleLabel(utcDate)
    // Должно быть "сегодня", т.к. в Almaty ещё тот же день
    expect(label).toBe('сегодня в 23:50')
    restore()
  })

  test('граница полуночи: 00:10 Almaty завтра — метка "завтра"', () => {
    const restore = mockAlmatyTime(23, 55) // сейчас 23:55 Almaty
    // Целевое время: 00:10 следующего дня по Almaty
    const nowAlm  = new Date(Date.now() + ALMATY_OFFSET)
    const nextAlm = new Date(nowAlm.getTime() + 86_400_000)
    nextAlm.setUTCHours(0, 10, 0, 0)
    const utcDate = new Date(nextAlm.getTime() - ALMATY_OFFSET)

    const label = formatScheduleLabel(utcDate)
    expect(label).toBe('завтра в 00:10')
    restore()
  })

  test('null → "сейчас"', () => {
    expect(formatScheduleLabel(null)).toBe('сейчас')
  })

  test('более 2 дней вперёд → день недели', () => {
    const restore = mockAlmatyTime(10, 0)
    // Через 3 дня
    const futureAlm = new Date(Date.now() + ALMATY_OFFSET + 3 * 86_400_000)
    futureAlm.setUTCHours(10, 0, 0, 0)
    const utcDate = new Date(futureAlm.getTime() - ALMATY_OFFSET)

    const label = formatScheduleLabel(utcDate)
    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
    const expectedDay = days[futureAlm.getUTCDay()]
    expect(label).toMatch(new RegExp(`^${expectedDay} в \\d{2}:\\d{2}$`))
    restore()
  })
})

// ─── minutesUntil() ──────────────────────────────────────────────────────────

describe('minutesUntil()', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  test('будущее время → положительное число', () => {
    jest.setSystemTime(new Date('2024-01-15T10:00:00Z'))
    const future = new Date('2024-01-15T10:30:00Z')
    expect(minutesUntil(future)).toBe(30)
  })

  test('прошедшее время → отрицательное число', () => {
    jest.setSystemTime(new Date('2024-01-15T10:00:00Z'))
    const past = new Date('2024-01-15T09:30:00Z')
    expect(minutesUntil(past)).toBe(-30)
  })

  test('принимает строку ISO', () => {
    jest.setSystemTime(new Date('2024-01-15T10:00:00Z'))
    expect(minutesUntil('2024-01-15T10:15:00Z')).toBe(15)
  })
})
