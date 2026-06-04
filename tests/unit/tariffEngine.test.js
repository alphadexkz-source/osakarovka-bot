'use strict'

jest.mock('../../src/db/queries', () => ({
  getTariffs: jest.fn(),
}))
// logger пишет в файл — мокаем чтобы не создавать logs/ в тестах
jest.mock('../../src/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(),
  msg: jest.fn(), order: jest.fn(), driver: jest.fn(),
  initFileLogging: jest.fn(),
}))

const { norm, isNight, findTariff, getPrice } = require('../../src/modules/tariffEngine')
const q = require('../../src/db/queries')
const config = require('../../src/config')

// ─── norm() ──────────────────────────────────────────────────────

describe('norm()', () => {
  test('пустая строка → ""', () => expect(norm('')).toBe(''))
  test('null → ""', () => expect(norm(null)).toBe(''))
  test('undefined → ""', () => expect(norm(undefined)).toBe(''))

  test('lowercase', () => expect(norm('Алаш')).toBe('алаш'))

  test('ё → е', () => expect(norm('ёжик')).toBe('ежик'))

  test('казахские: қ→к ғ→г (не содержат оригинальных букв)', () => {
    const result = norm('Қарағанды')
    expect(result).not.toMatch(/[қғ]/)   // казахские убраны
    expect(result).toContain('к')        // қ → к
    expect(result).toContain('г')        // ғ → г
    expect(result).toMatch(/^[а-яёa-z0-9\s]+$/) // только допустимые символы
  })

  test('казахские: ұ→у ү→у ө→о ә→а і→и', () => {
    expect(norm('Сұнқар')).toBe('сункар')      // ұ→у, қ→к
    expect(norm('үй')).toBe('уй')              // ү→у, й остаётся
    expect(norm('өзен')).toBe('озен')          // ө→о
    expect(norm('Астана әкімі')).toBe('астана акими') // ә→а, і→и
    expect(norm('Осакарі')).toBe('осакари')    // і→и
  })

  test('спецсимволы → пробел', () => {
    expect(norm('ул. Алаш, 15')).toBe('ул алаш 15')
  })

  test('несколько пробелов → один', () => {
    expect(norm('ул  алаш   15')).toBe('ул алаш 15')
  })

  test('trim пробелов', () => {
    expect(norm('  алаш  ')).toBe('алаш')
  })

  test('цифры остаются', () => {
    expect(norm('Алаш 15')).toBe('алаш 15')
  })
})

// ─── isNight() ───────────────────────────────────────────────────

describe('isNight()', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  const setHour = (h) =>
    jest.setSystemTime(new Date(`2024-01-15T${String(h).padStart(2, '0')}:00:00`))

  test('23:00 → ночь', () => { setHour(23); expect(isNight()).toBe(true) })
  test('00:00 → ночь', () => { setHour(0);  expect(isNight()).toBe(true) })
  test('03:00 → ночь', () => { setHour(3);  expect(isNight()).toBe(true) })
  test('06:00 → ночь', () => { setHour(6);  expect(isNight()).toBe(true) })
  test('07:00 → день', () => { setHour(7);  expect(isNight()).toBe(false) })
  test('12:00 → день', () => { setHour(12); expect(isNight()).toBe(false) })
  test('18:00 → день', () => { setHour(18); expect(isNight()).toBe(false) })
  test('22:00 → день', () => { setHour(22); expect(isNight()).toBe(false) })
})

// ─── findTariff() ────────────────────────────────────────────────

describe('findTariff()', () => {
  const mockTariffs = [
    { id: 1, name: 'Темиртау', day_price: 15000, night_price: 30000, keywords: ['темиртау', 'темир тау'] },
    { id: 2, name: 'По посёлку', day_price: 500, night_price: 1000, keywords: ['алаш', 'советская', 'первомайская'] },
    { id: 3, name: 'Элеватор', day_price: 700, night_price: 1000, keywords: ['элеватор', 'луговая'] },
  ]

  beforeEach(() => q.getTariffs.mockResolvedValue(mockTariffs))

  test('находит по точному ключевому слову', async () => {
    const t = await findTariff('элеватор')
    expect(t.id).toBe(3)
  })

  test('находит при включённом тексте ("на элеватор")', async () => {
    const t = await findTariff('на элеватор')
    expect(t.id).toBe(3)
  })

  test('регистронезависимый поиск ("ТЕМИРТАУ")', async () => {
    const t = await findTariff('ТЕМИРТАУ')
    expect(t.id).toBe(1)
  })

  test('игнорирует спецсимволы — "ул. Алаш, 15"', async () => {
    const t = await findTariff('ул. Алаш, 15')
    expect(t.id).toBe(2)
  })

  test('возвращает null для неизвестного направления', async () => {
    const t = await findTariff('неизвестное место')
    expect(t).toBeNull()
  })

  test('возвращает null при пустой строке', async () => {
    const t = await findTariff('')
    expect(t).toBeNull()
  })

  test('возвращает первый совпавший тариф', async () => {
    // 'Луговая' → matches Элеватор
    const t = await findTariff('Луговая 5')
    expect(t.id).toBe(3)
  })

  test('казахские буквы в запросе нормализуются', async () => {
    // Сұнқар → сункар, но его нет в mock-тарифах → null
    const t = await findTariff('Сұнқар')
    expect(t).toBeNull()
  })
})

// ─── getPrice() ──────────────────────────────────────────────────

describe('getPrice()', () => {
  const mockTariffs = [
    { id: 1, name: 'Темиртау', day_price: 15000, night_price: 30000, keywords: ['темиртау'] },
    { id: 2, name: 'По посёлку', day_price: 500, night_price: null, keywords: ['алаш'] },
  ]

  beforeEach(() => {
    q.getTariffs.mockResolvedValue(mockTariffs)
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  const setHour = (h) =>
    jest.setSystemTime(new Date(`2024-01-15T${String(h).padStart(2, '0')}:00:00`))

  test('дневная цена днём', async () => {
    setHour(12)
    const r = await getPrice('темиртау')
    expect(r.price).toBe(15000)
    expect(r.isNight).toBe(false)
    expect(r.isCity).toBe(false)
    expect(r.tariff.id).toBe(1)
  })

  test('ночная цена ночью', async () => {
    setHour(23)
    const r = await getPrice('темиртау')
    expect(r.price).toBe(30000)
    expect(r.isNight).toBe(true)
  })

  test('когда night_price=null — дневная даже ночью', async () => {
    setHour(23)
    const r = await getPrice('алаш 5')
    expect(r.price).toBe(500) // fallback на day_price
  })

  test('CITY_PRICE для неизвестного направления', async () => {
    q.getTariffs.mockResolvedValueOnce([])
    setHour(12)
    const r = await getPrice('неизвестное место')
    expect(r.price).toBe(config.CITY_PRICE)
    expect(r.isCity).toBe(true)
    expect(r.tariff).toBeNull()
  })

  test('CITY_PRICE ночью для неизвестного направления', async () => {
    q.getTariffs.mockResolvedValueOnce([])
    setHour(2)
    const r = await getPrice('нигде')
    expect(r.price).toBe(config.CITY_PRICE)
    expect(r.isNight).toBe(true)
  })
})
