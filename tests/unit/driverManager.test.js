'use strict'

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db/queries', () => ({
  getDriver:              jest.fn(),
  setDriverStatus:        jest.fn(),
  moveDriverToEndOfQueue: jest.fn(),
  updateDriver:           jest.fn(),
  getOnlineDriversQueue:  jest.fn(),
  deductDriverBalance:    jest.fn(),
}))

jest.mock('../../src/logger', () => ({
  warn:            jest.fn(),
  error:           jest.fn(),
  info:            jest.fn(),
  msg:             jest.fn(),
  order:           jest.fn(),
  driver:          jest.fn(),
  initFileLogging: jest.fn(),
}))

// ─── Imports (requireActual — we test the real module) ────────────────────────

const driverMgr = require('../../src/modules/driverManager')
const q         = require('../../src/db/queries')
const config    = require('../../src/config')

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PHONE = '77001234567'

const makeDriver = (overrides = {}) => ({
  id: 1,
  phone: PHONE,
  full_name: 'Иван Иванов',
  status: 'online',
  order_balance: 10,
  rating: '5.0',
  skip_next: false,
  queue_position: 1,
  ...overrides,
})

beforeEach(() => {
  jest.clearAllMocks()
  q.setDriverStatus.mockResolvedValue(undefined)
  q.moveDriverToEndOfQueue.mockResolvedValue(undefined)
  q.updateDriver.mockResolvedValue(undefined)
})

// ─── goOnline() ───────────────────────────────────────────────────────────────

describe('driverManager.goOnline()', () => {
  test('успешный выход на линию → { success: true }', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, status: 'offline' }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ success: true })
    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'online')
    expect(q.moveDriverToEndOfQueue).toHaveBeenCalledWith(PHONE)
  })

  test('нулевой баланс → { error: "no_balance" }', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 0, status: 'offline' }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ error: 'no_balance' })
    expect(q.setDriverStatus).not.toHaveBeenCalled()
  })

  test('отрицательный баланс → { error: "no_balance" }', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: -1, status: 'offline' }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ error: 'no_balance' })
  })

  test('пробный период (order_balance = 999999) → успех, баланс не блокирует', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 999999, status: 'offline' }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ success: true })
    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'online')
  })

  test('заблокированный водитель → { error: "blocked" }', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ status: 'blocked', order_balance: 5 }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ error: 'blocked' })
    expect(q.setDriverStatus).not.toHaveBeenCalled()
  })

  test('водитель в поездке (busy) → { error: "in_trip" }', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ status: 'busy', order_balance: 5 }))
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ error: 'in_trip' })
  })

  test('водитель не зарегистрирован → { error: "not_registered" }', async () => {
    q.getDriver.mockResolvedValue(null)
    const result = await driverMgr.goOnline(PHONE)
    expect(result).toMatchObject({ error: 'not_registered' })
  })

  test('goOnline сбрасывает skip_next', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, status: 'offline', skip_next: true }))
    await driverMgr.goOnline(PHONE)
    expect(q.updateDriver).toHaveBeenCalledWith(PHONE, { skip_next: false })
  })
})

// ─── goOffline() ──────────────────────────────────────────────────────────────

describe('driverManager.goOffline()', () => {
  test('успешный уход с линии → { success: true }', async () => {
    const result = await driverMgr.goOffline(PHONE)
    expect(result).toEqual({ success: true })
    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'offline')
  })

  test('не запрашивает getDriver — без проверок', async () => {
    await driverMgr.goOffline(PHONE)
    expect(q.getDriver).not.toHaveBeenCalled()
  })
})

// ─── getNextDriver() ──────────────────────────────────────────────────────────

describe('driverManager.getNextDriver()', () => {
  test('возвращает первого доступного водителя', async () => {
    const d1 = makeDriver({ phone: '77001111111', queue_position: 1 })
    const d2 = makeDriver({ phone: '77002222222', queue_position: 2 })
    q.getOnlineDriversQueue.mockResolvedValue([d1, d2])

    const result = await driverMgr.getNextDriver([])
    expect(result.phone).toBe(d1.phone)
  })

  test('исключает телефоны из excludePhones', async () => {
    const d1 = makeDriver({ phone: '77001111111', queue_position: 1 })
    const d2 = makeDriver({ phone: '77002222222', queue_position: 2 })
    q.getOnlineDriversQueue.mockResolvedValue([d1, d2])

    const result = await driverMgr.getNextDriver([d1.phone])
    expect(result.phone).toBe(d2.phone)
  })

  test('пропускает водителя с skip_next=true и сбрасывает флаг', async () => {
    const d1 = makeDriver({ phone: '77001111111', queue_position: 1, skip_next: true })
    const d2 = makeDriver({ phone: '77002222222', queue_position: 2, skip_next: false })
    q.getOnlineDriversQueue.mockResolvedValue([d1, d2])

    const result = await driverMgr.getNextDriver([])
    expect(result.phone).toBe(d2.phone)
    expect(q.updateDriver).toHaveBeenCalledWith(d1.phone, { skip_next: false })
  })

  test('все skip_next=true → null', async () => {
    const d1 = makeDriver({ phone: '77001111111', skip_next: true })
    q.getOnlineDriversQueue.mockResolvedValue([d1])

    const result = await driverMgr.getNextDriver([])
    expect(result).toBeNull()
  })

  test('нет онлайн водителей → null', async () => {
    q.getOnlineDriversQueue.mockResolvedValue([])
    const result = await driverMgr.getNextDriver([])
    expect(result).toBeNull()
  })

  test('все водители в excludePhones → null', async () => {
    const d1 = makeDriver({ phone: '77001111111' })
    q.getOnlineDriversQueue.mockResolvedValue([d1])

    const result = await driverMgr.getNextDriver([d1.phone])
    expect(result).toBeNull()
  })
})

// ─── afterTrip() ──────────────────────────────────────────────────────────────

describe('driverManager.afterTrip()', () => {
  const DRIVER_ID = 1

  test('обычная поездка: баланс списывается через deductDriverBalance', async () => {
    q.deductDriverBalance.mockResolvedValue(9) // было 10, стало 9
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 9 }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    expect(q.deductDriverBalance).toHaveBeenCalledWith(DRIVER_ID)
    expect(result).toMatchObject({ offline: false, balance: 9 })
  })

  test('бесплатная поездка (isFree=true): баланс НЕ меняется', async () => {
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 10 }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, true)

    expect(q.deductDriverBalance).not.toHaveBeenCalled()
    expect(result.balance).toBe(10)
    expect(result.offline).toBe(false)
  })

  test('баланс достиг 0: водитель уходит офлайн', async () => {
    q.deductDriverBalance.mockResolvedValue(0)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 0 }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'offline')
    expect(result).toMatchObject({ offline: true, balance: 0 })
  })

  test('deductDriverBalance возвращает undefined: водитель уходит офлайн', async () => {
    q.deductDriverBalance.mockResolvedValue(undefined)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 0 }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'offline')
    expect(result).toMatchObject({ offline: true })
  })

  test('нормальный баланс после поездки: водитель возвращается онлайн в очередь', async () => {
    q.deductDriverBalance.mockResolvedValue(5)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, rating: '5.0' }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    expect(q.setDriverStatus).toHaveBeenCalledWith(PHONE, 'online')
    expect(q.moveDriverToEndOfQueue).toHaveBeenCalledWith(PHONE)
    expect(result.offline).toBe(false)
  })

  test('низкий рейтинг после поездки: skip_next=true', async () => {
    q.deductDriverBalance.mockResolvedValue(5)
    // Rating below LOW_RATING (3.0)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, rating: '2.8' }))

    await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    expect(q.updateDriver).toHaveBeenCalledWith(PHONE, { skip_next: true })
  })

  test('нормальный рейтинг после поездки: skip_next НЕ устанавливается', async () => {
    q.deductDriverBalance.mockResolvedValue(5)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, rating: '4.5' }))

    await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    const skipCalls = q.updateDriver.mock.calls.filter(
      ([, upd]) => upd && upd.skip_next === true
    )
    expect(skipCalls).toHaveLength(0)
  })

  test('рейтинг ровно LOW_RATING (3.0): НЕ пенализируется (граница)', async () => {
    q.deductDriverBalance.mockResolvedValue(5)
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 5, rating: String(config.LOW_RATING) }))

    await driverMgr.afterTrip(PHONE, DRIVER_ID, false)

    const skipCalls = q.updateDriver.mock.calls.filter(
      ([, upd]) => upd && upd.skip_next === true
    )
    // Condition is < LOW_RATING, so exactly 3.0 should NOT set skip_next
    expect(skipCalls).toHaveLength(0)
  })

  test('пробный период (order_balance = 999999) не декрементируется', async () => {
    // In afterTrip isFree path: reads current balance and returns it unchanged
    q.getDriver.mockResolvedValue(makeDriver({ order_balance: 999999 }))

    const result = await driverMgr.afterTrip(PHONE, DRIVER_ID, true)

    expect(result.balance).toBe(999999)
    expect(result.offline).toBe(false)
    expect(q.deductDriverBalance).not.toHaveBeenCalled()
  })
})

// ─── formatList() ─────────────────────────────────────────────────────────────

describe('driverManager.formatList()', () => {
  test('пустой список → сообщение об отсутствии водителей', () => {
    const text = driverMgr.formatList([])
    expect(text).toMatch(/не зарегистрированы/i)
  })

  test('форматирует водителей с иконками статуса', () => {
    const drivers = [
      makeDriver({ full_name: 'Иван', status: 'online', rating: '4.5', order_balance: 7, car_make: 'Toyota', car_plate: 'A001BC' }),
    ]
    const text = driverMgr.formatList(drivers)
    expect(text).toContain('Иван')
    expect(text).toContain('🟢')
    expect(text).toContain('4.5')
    expect(text).toContain('Toyota')
  })

  test('водитель без имени → "Без имени"', () => {
    const drivers = [makeDriver({ full_name: null })]
    const text = driverMgr.formatList(drivers)
    expect(text).toContain('Без имени')
  })
})
