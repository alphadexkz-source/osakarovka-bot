'use strict'

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db/index', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
  end:       jest.fn(),
}))

jest.mock('../../src/db/queries', () => ({
  getActiveOrderByClient:  jest.fn(),
  getUser:                 jest.fn(),
  getSetting:              jest.fn(),
  createOrder:             jest.fn(),
  getOrder:                jest.fn(),
  updateOrder:             jest.fn(),
  setSession:              jest.fn(),
  clearSession:            jest.fn(),
  getSession:              jest.fn(),
  getDriver:               jest.fn(),
  atomicAcceptOrder:       jest.fn(),
  setDriverStatus:         jest.fn(),
  moveDriverToEndOfQueue:  jest.fn(),
  clearDispatchState:      jest.fn(),
  setDispatchState:        jest.fn(),
  getOnlineDriversQueue:   jest.fn(),
  getAllDrivers:            jest.fn(),
  getDriverTodayStats:     jest.fn(),
  getDriverQueuePosition:  jest.fn(),
  saveFalseCall:           jest.fn(),
  getFalseCallCount:       jest.fn(),
  blacklistUser:           jest.fn(),
  updateDriver:            jest.fn(),
}))

jest.mock('../../src/modules/notificationService', () => ({
  clientSearching:    jest.fn().mockResolvedValue(undefined),
  clientNoDrivers:    jest.fn().mockResolvedValue(undefined),
  clientDriverFound:  jest.fn().mockResolvedValue(undefined),
  clientCancelled:    jest.fn().mockResolvedValue(undefined),
  clientCompleted:    jest.fn().mockResolvedValue(undefined),
  clientArrived:      jest.fn().mockResolvedValue(undefined),
  clientInTrip:       jest.fn().mockResolvedValue(undefined),
  driverNewOrder:     jest.fn().mockResolvedValue(undefined),
  driverAccepted:     jest.fn().mockResolvedValue(undefined),
  driverTripStarted:  jest.fn().mockResolvedValue(undefined),
  driverBalanceLow:   jest.fn().mockResolvedValue(undefined),
  driverBalanceEmpty: jest.fn().mockResolvedValue(undefined),
  scheduledCreated:   jest.fn().mockResolvedValue(undefined),
  scheduledStarting:  jest.fn().mockResolvedValue(undefined),
  falseCallClient:    jest.fn().mockResolvedValue(undefined),
  falseCallDriver:    jest.fn().mockResolvedValue(undefined),
  falseCallAdmin:     jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../src/modules/driverManager', () => ({
  getNextDriver: jest.fn(),
  getAllOnline:   jest.fn(),
  afterTrip:     jest.fn(),
}))

jest.mock('../../src/whatsapp/greenApi', () => ({
  sendText:    jest.fn().mockResolvedValue(undefined),
  sendButtons: jest.fn().mockResolvedValue(undefined),
  sendImage:   jest.fn().mockResolvedValue(undefined),
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

// ─── Imports ─────────────────────────────────────────────────────────────────

const orderEngine = require('../../src/modules/orderEngine')
const q           = require('../../src/db/queries')
const notify      = require('../../src/modules/notificationService')
const wa          = require('../../src/whatsapp/greenApi')

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ORDER_ID   = 42
const DRIVER1_PHONE = '77001111111'
const DRIVER2_PHONE = '77002222222'
const CLIENT_PHONE  = '77009999999'

const makeOrder = (overrides = {}) => ({
  id: ORDER_ID,
  status: 'searching',
  client_phone: CLIENT_PHONE,
  driver_phone: null,
  driver_id: null,
  destination: 'Алаш 15',
  price: 500,
  is_free: false,
  ...overrides,
})

const makeDriver = (id, phone, overrides = {}) => ({
  id,
  phone,
  full_name: `Driver ${id}`,
  car_plate: `A${id}BC`,
  car_make: 'Toyota',
  car_color: 'Белый',
  order_balance: 10,
  rating: '5.0',
  skip_next: false,
  queue_position: id,
  ...overrides,
})

afterEach(() => {
  jest.clearAllMocks()
  jest.useRealTimers()
})

// ─── Race condition: two simultaneous accept() calls ─────────────────────────

describe('orderEngine.accept() — race condition', () => {
  test('первый вызов succeed, второй получает already_taken', async () => {
    const order   = makeOrder()
    const driver1 = makeDriver(1, DRIVER1_PHONE)
    const driver2 = makeDriver(2, DRIVER2_PHONE)

    // Both see the order as 'searching'
    q.getOrder.mockResolvedValue(order)

    // Driver lookup returns correct driver per call
    q.getDriver
      .mockResolvedValueOnce(driver1)  // driver1 call
      .mockResolvedValueOnce(driver2)  // driver2 call

    // atomicAcceptOrder: first wins (returns truthy row), second loses (returns falsy)
    q.atomicAcceptOrder
      .mockResolvedValueOnce({ ...order, status: 'accepted', driver_id: driver1.id })
      .mockResolvedValueOnce(null)

    q.setDriverStatus.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.getSetting.mockResolvedValue('queue')
    q.getOnlineDriversQueue.mockResolvedValue([])

    // Fire both accept calls concurrently — simulates race
    const [result1, result2] = await Promise.all([
      orderEngine.accept(ORDER_ID, DRIVER1_PHONE),
      orderEngine.accept(ORDER_ID, DRIVER2_PHONE),
    ])

    expect(result1).toEqual({ success: true })
    expect(result2).toMatchObject({ error: 'already_taken' })
  })

  test('только один водитель уведомляет клиента о найденном водителе', async () => {
    const order   = makeOrder()
    const driver1 = makeDriver(1, DRIVER1_PHONE)
    const driver2 = makeDriver(2, DRIVER2_PHONE)

    q.getOrder.mockResolvedValue(order)
    q.getDriver
      .mockResolvedValueOnce(driver1)
      .mockResolvedValueOnce(driver2)

    q.atomicAcceptOrder
      .mockResolvedValueOnce({ ...order, status: 'accepted', driver_id: driver1.id })
      .mockResolvedValueOnce(null)

    q.setDriverStatus.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.getSetting.mockResolvedValue('queue')
    q.getOnlineDriversQueue.mockResolvedValue([])

    await Promise.all([
      orderEngine.accept(ORDER_ID, DRIVER1_PHONE),
      orderEngine.accept(ORDER_ID, DRIVER2_PHONE),
    ])

    // clientDriverFound called exactly once (only winning driver)
    expect(notify.clientDriverFound).toHaveBeenCalledTimes(1)
    expect(notify.clientDriverFound).toHaveBeenCalledWith(
      CLIENT_PHONE,
      expect.objectContaining({ id: driver1.id })
    )
  })

  test('проигравший водитель: сессия сбрасывается в idle', async () => {
    const order   = makeOrder()
    const driver2 = makeDriver(2, DRIVER2_PHONE)

    q.getOrder.mockResolvedValue(order)
    q.getDriver.mockResolvedValue(driver2)
    q.atomicAcceptOrder.mockResolvedValue(null) // always loses

    q.setSession.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)

    await orderEngine.accept(ORDER_ID, DRIVER2_PHONE)

    // Losing driver's stale pending_order_id must be cleared
    expect(q.setSession).toHaveBeenCalledWith(DRIVER2_PHONE, 'idle', {})
  })

  test('проигравший водитель НЕ меняет статус на busy', async () => {
    const order   = makeOrder()
    const driver2 = makeDriver(2, DRIVER2_PHONE)

    q.getOrder.mockResolvedValue(order)
    q.getDriver.mockResolvedValue(driver2)
    q.atomicAcceptOrder.mockResolvedValue(null)
    q.setSession.mockResolvedValue(undefined)

    await orderEngine.accept(ORDER_ID, DRIVER2_PHONE)

    // setDriverStatus should NOT be called for the loser
    expect(q.setDriverStatus).not.toHaveBeenCalledWith(DRIVER2_PHONE, 'busy')
  })

  test('order not found → unavailable (не зависит от atomicAccept)', async () => {
    q.getOrder.mockResolvedValue(null)

    const result = await orderEngine.accept(ORDER_ID, DRIVER1_PHONE)
    expect(result).toMatchObject({ error: 'unavailable' })
    expect(q.atomicAcceptOrder).not.toHaveBeenCalled()
  })

  test('order already accepted → unavailable (статус не searching)', async () => {
    q.getOrder.mockResolvedValue(makeOrder({ status: 'accepted', driver_id: 99 }))

    const result = await orderEngine.accept(ORDER_ID, DRIVER1_PHONE)
    expect(result).toMatchObject({ error: 'unavailable' })
    expect(q.atomicAcceptOrder).not.toHaveBeenCalled()
  })

  test('driver not found → driver_not_found', async () => {
    q.getOrder.mockResolvedValue(makeOrder())
    q.getDriver.mockResolvedValue(null)

    const result = await orderEngine.accept(ORDER_ID, DRIVER1_PHONE)
    expect(result).toMatchObject({ error: 'driver_not_found' })
  })

  test('atomicAcceptOrder вызывается с (orderId, driver.id) — защита от двойного принятия', async () => {
    const driver1 = makeDriver(1, DRIVER1_PHONE)
    q.getOrder.mockResolvedValue(makeOrder())
    q.getDriver.mockResolvedValue(driver1)
    q.atomicAcceptOrder.mockResolvedValue({ ...makeOrder(), status: 'accepted', driver_id: 1 })
    q.setDriverStatus.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.getSetting.mockResolvedValue('queue')
    q.getOnlineDriversQueue.mockResolvedValue([])

    await orderEngine.accept(ORDER_ID, DRIVER1_PHONE)

    expect(q.atomicAcceptOrder).toHaveBeenCalledWith(ORDER_ID, driver1.id)
  })
})

// ─── Race condition: acceptTimers cleared on accept ───────────────────────────

describe('orderEngine — таймер принятия очищается при accept()', () => {
  test('после accept() 40-секундный таймер не вызывает penalizeSkip', async () => {
    jest.useFakeTimers()

    const driver1 = makeDriver(1, DRIVER1_PHONE)
    const order   = makeOrder()

    q.getOrder.mockResolvedValue(order)
    q.getDriver.mockResolvedValue(driver1)
    q.atomicAcceptOrder.mockResolvedValue({ ...order, status: 'accepted', driver_id: 1 })
    q.setDriverStatus.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.getSetting.mockResolvedValue('queue')
    q.getOnlineDriversQueue.mockResolvedValue([])

    // Accept the order — this should clear the internal acceptTimer
    await orderEngine.accept(ORDER_ID, DRIVER1_PHONE)

    // After accept, the timer callback should be a no-op if somehow fired
    // Advance past ACCEPT_TIMEOUT (40000ms) — getOrder returns accepted status
    q.getOrder.mockResolvedValue({ ...order, status: 'accepted' })
    await jest.advanceTimersByTimeAsync(45000)

    // penalizeSkip sends "Время вышло" — must NOT be called after legitimate accept
    const penaltyCalls = wa.sendText.mock.calls.filter(
      ([, msg]) => typeof msg === 'string' && msg.includes('Время вышло')
    )
    expect(penaltyCalls).toHaveLength(0)
  })
})
