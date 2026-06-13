'use strict'

// ─── Mocks (must come before any require of the module under test) ─────────

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
  warn:           jest.fn(),
  error:          jest.fn(),
  info:           jest.fn(),
  msg:            jest.fn(),
  order:          jest.fn(),
  driver:         jest.fn(),
  initFileLogging: jest.fn(),
}))

// ─── Imports ──────────────────────────────────────────────────────

const orderEngine = require('../../src/modules/orderEngine')
const db          = require('../../src/db/index')
const q           = require('../../src/db/queries')
const notify      = require('../../src/modules/notificationService')
const driverMgr   = require('../../src/modules/driverManager')
const wa          = require('../../src/whatsapp/greenApi')
const config      = require('../../src/config')

// ─── Helpers ──────────────────────────────────────────────────────

const CLIENT_PHONE = '77001112233'
const DRIVER_PHONE = '77009998877'

const mockClient = { id: 1, phone: CLIENT_PHONE, trip_count: 9, is_blacklisted: false }
const mockDriver = { id: 10, phone: DRIVER_PHONE, full_name: 'Иван', car_plate: 'A123BC', order_balance: 5, rating: 4.5 }
const mockOrder  = { id: 100, client_id: 1, client_phone: CLIENT_PHONE, driver_phone: null, destination: 'Алаш 15', price: 500, status: 'searching', is_free: false }

// ─── create() ─────────────────────────────────────────────────────

describe('orderEngine.create()', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    q.getActiveOrderByClient.mockResolvedValue(null)
    q.getUser.mockResolvedValue(mockClient)
    q.getSetting.mockResolvedValue(null)       // loyalty_enabled=null, loyalty_every=null
    q.createOrder.mockResolvedValue({ ...mockOrder })
    q.setSession.mockResolvedValue(undefined)
    // dispatch_queue path: no online drivers → auto-cancel
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'searching' })
    driverMgr.getNextDriver.mockResolvedValue(null)
    q.getOnlineDriversQueue.mockResolvedValue([])
    q.getAllDrivers.mockResolvedValue([])
    q.updateOrder.mockResolvedValue(undefined)
    q.clearSession.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  test('возвращает null если клиент уже имеет активный заказ', async () => {
    q.getActiveOrderByClient.mockResolvedValue({ id: 99 })
    const result = await orderEngine.create(CLIENT_PHONE, 'Алаш 15', { price: 500 })
    expect(result).toBeNull()
    expect(q.createOrder).not.toHaveBeenCalled()
  })

  test('возвращает null если клиент не найден в БД', async () => {
    q.getUser.mockResolvedValue(null)
    const result = await orderEngine.create(CLIENT_PHONE, 'Алаш 15', { price: 500 })
    expect(result).toBeNull()
    expect(q.createOrder).not.toHaveBeenCalled()
  })

  test('создаёт заказ и уведомляет клиента при поиске водителя', async () => {
    const result = await orderEngine.create(CLIENT_PHONE, 'Алаш 15', { price: 500 })
    expect(q.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      client_id: mockClient.id,
      destination: 'Алаш 15',
      price: 500,
    }))
    expect(notify.clientSearching).toHaveBeenCalledWith(
      CLIENT_PHONE, 'Алаш 15', 500, false
    )
    expect(q.setSession).toHaveBeenCalledWith(CLIENT_PHONE, 'waiting_driver', { order_id: mockOrder.id })
    expect(result).toMatchObject({ id: 100 })
  })

  test('помечает поездку бесплатной при кратной поездке (trip_count+1 кратен FREE_TRIP_EVERY)', async () => {
    // trip_count=9 → следующая (10-я) — бесплатная при default FREE_TRIP_EVERY=10
    q.getSetting.mockImplementation((key) => {
      if (key === 'loyalty_enabled') return Promise.resolve('true')
      if (key === 'loyalty_every')   return Promise.resolve(null) // используем config default
      return Promise.resolve(null)
    })
    await orderEngine.create(CLIENT_PHONE, 'Алаш 15', { price: 500 })
    expect(q.createOrder).toHaveBeenCalledWith(expect.objectContaining({ is_free: true }))
  })

  test('поездка НЕ бесплатная если loyalty_enabled=false', async () => {
    q.getUser.mockResolvedValue({ ...mockClient, trip_count: 9 })
    q.getSetting.mockImplementation((key) => {
      if (key === 'loyalty_enabled') return Promise.resolve('false')
      return Promise.resolve(null)
    })
    await orderEngine.create(CLIENT_PHONE, 'Алаш 15', { price: 500 })
    expect(q.createOrder).toHaveBeenCalledWith(expect.objectContaining({ is_free: false }))
  })

  test('предзаказ: setSession → scheduled, уведомление scheduledCreated', async () => {
    const scheduledTime = new Date(Date.now() + 3600000) // через час
    q.createOrder.mockResolvedValue({ ...mockOrder, scheduled_time: scheduledTime })
    const result = await orderEngine.create(CLIENT_PHONE, 'Алаш 15', {
      price: 500,
      scheduled_time: scheduledTime,
      scheduled_label: 'завтра в 08:00',
    })
    expect(notify.scheduledCreated).toHaveBeenCalledWith(
      CLIENT_PHONE, 'Алаш 15', 'завтра в 08:00', 500
    )
    expect(q.setSession).toHaveBeenCalledWith(CLIENT_PHONE, 'scheduled', expect.objectContaining({ order_id: mockOrder.id }))
    expect(result).toMatchObject({ id: 100 })
  })

  test('intercity флаг передаётся в createOrder', async () => {
    await orderEngine.create(CLIENT_PHONE, 'Темиртау', {
      price: 15000,
      is_intercity: true,
      pickup_address: 'Алаш 5',
    })
    expect(q.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      is_intercity: true,
      pickup_address: 'Алаш 5',
    }))
  })
})

// ─── cancel() ─────────────────────────────────────────────────────

describe('orderEngine.cancel()', () => {
  beforeEach(() => {
    q.getOrder.mockResolvedValue({ ...mockOrder })
    q.updateOrder.mockResolvedValue(undefined)
    q.clearSession.mockResolvedValue(undefined)
    notify.clientCancelled.mockResolvedValue(undefined)
  })

  afterEach(() => jest.clearAllMocks())

  test('отменяет заказ в БД со статусом cancelled', async () => {
    await orderEngine.cancel(100, 'client')
    expect(q.updateOrder).toHaveBeenCalledWith(100, expect.objectContaining({
      status: 'cancelled',
      cancel_reason: 'client',
    }))
  })

  test('уведомляет клиента об отмене', async () => {
    await orderEngine.cancel(100, 'client')
    expect(notify.clientCancelled).toHaveBeenCalledWith(CLIENT_PHONE, '')
  })

  test('очищает сессию клиента', async () => {
    await orderEngine.cancel(100, 'client')
    expect(q.clearSession).toHaveBeenCalledWith(CLIENT_PHONE)
  })

  test('причина no_drivers → отображается читаемо', async () => {
    await orderEngine.cancel(100, 'no_drivers')
    expect(notify.clientCancelled).toHaveBeenCalledWith(CLIENT_PHONE, 'Свободных водителей не нашлось')
  })

  test('причина false_call → отображается читаемо', async () => {
    await orderEngine.cancel(100, 'false_call')
    expect(notify.clientCancelled).toHaveBeenCalledWith(CLIENT_PHONE, 'Ложный вызов')
  })

  test('если заказ не найден — ничего не делает', async () => {
    q.getOrder.mockResolvedValue(null)
    await orderEngine.cancel(999, 'client')
    expect(q.updateOrder).not.toHaveBeenCalled()
    expect(notify.clientCancelled).not.toHaveBeenCalled()
  })

  test('при наличии водителя — уведомляет водителя и переводит онлайн', async () => {
    q.getOrder.mockResolvedValue({ ...mockOrder, driver_phone: DRIVER_PHONE })
    q.setDriverStatus.mockResolvedValue(undefined)
    q.moveDriverToEndOfQueue.mockResolvedValue(undefined)
    await orderEngine.cancel(100, 'client')
    expect(q.setDriverStatus).toHaveBeenCalledWith(DRIVER_PHONE, 'online')
    expect(wa.sendText).toHaveBeenCalledWith(DRIVER_PHONE, expect.stringContaining('клиент отменил'))
    expect(q.clearSession).toHaveBeenCalledWith(DRIVER_PHONE)
  })
})

// ─── complete() ───────────────────────────────────────────────────

describe('orderEngine.complete()', () => {
  // txClient mock — имитирует pg Client с транзакцией
  let txClient

  beforeEach(() => {
    jest.useFakeTimers()
    txClient = {
      query:   jest.fn(),
      release: jest.fn(),
    }
    // BEGIN / UPDATE / UPDATE / COMMIT / ROLLBACK
    txClient.query.mockImplementation((sql) => {
      if (/^BEGIN/i.test(sql))    return Promise.resolve()
      if (/^COMMIT/i.test(sql))   return Promise.resolve()
      if (/^ROLLBACK/i.test(sql)) return Promise.resolve()
      // UPDATE orders RETURNING id
      if (/UPDATE orders/i.test(sql)) return Promise.resolve({ rows: [{ id: 100 }] })
      // UPDATE users trip_count
      if (/UPDATE users/i.test(sql)) return Promise.resolve({ rows: [] })
      // UPDATE drivers order_balance
      if (/UPDATE drivers/i.test(sql)) return Promise.resolve({ rows: [{ order_balance: 4 }] })
      return Promise.resolve({ rows: [] })
    })

    db.getClient.mockResolvedValue(txClient)

    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'arrived' })
    q.getDriver.mockResolvedValue({ ...mockDriver })
    q.getDriverTodayStats.mockResolvedValue({ completed: 3, earned: 1500 })
    q.getDriverQueuePosition.mockResolvedValue(1)
    q.getOnlineDriversQueue.mockResolvedValue([mockDriver])
    q.setDriverStatus.mockResolvedValue(undefined)
    q.moveDriverToEndOfQueue.mockResolvedValue(undefined)
    q.clearSession.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.updateDriver.mockResolvedValue(undefined)
    notify.clientCompleted.mockResolvedValue(undefined)
    notify.driverBalanceLow.mockResolvedValue(undefined)
    notify.driverBalanceEmpty.mockResolvedValue(undefined)
    wa.sendButtons.mockResolvedValue(undefined)
    wa.sendText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.clearAllMocks()
  })

  test('возвращает { success: true } при успешном завершении', async () => {
    const result = await orderEngine.complete(100, DRIVER_PHONE)
    expect(result).toEqual({ success: true })
  })

  test('возвращает ошибку если заказ не найден', async () => {
    q.getOrder.mockResolvedValue(null)
    const result = await orderEngine.complete(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'not_found' })
  })

  test('возвращает ошибку если заказ в неверном статусе', async () => {
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'searching' })
    const result = await orderEngine.complete(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'wrong_status' })
  })

  test('уведомляет клиента о завершении', async () => {
    await orderEngine.complete(100, DRIVER_PHONE)
    expect(notify.clientCompleted).toHaveBeenCalledWith(
      CLIENT_PHONE, mockOrder.price, mockOrder.is_free, mockOrder.destination
    )
  })

  test('переводит водителя онлайн после завершения (баланс > 0)', async () => {
    await orderEngine.complete(100, DRIVER_PHONE)
    expect(q.setDriverStatus).toHaveBeenCalledWith(DRIVER_PHONE, 'online')
    expect(q.moveDriverToEndOfQueue).toHaveBeenCalledWith(DRIVER_PHONE)
  })

  test('переводит водителя офлайн если баланс стал 0', async () => {
    txClient.query.mockImplementation((sql) => {
      if (/^BEGIN/i.test(sql))    return Promise.resolve()
      if (/^COMMIT/i.test(sql))   return Promise.resolve()
      if (/UPDATE orders/i.test(sql)) return Promise.resolve({ rows: [{ id: 100 }] })
      if (/UPDATE users/i.test(sql))  return Promise.resolve({ rows: [] })
      if (/UPDATE drivers/i.test(sql)) return Promise.resolve({ rows: [{ order_balance: 0 }] })
      return Promise.resolve({ rows: [] })
    })
    await orderEngine.complete(100, DRIVER_PHONE)
    expect(q.setDriverStatus).toHaveBeenCalledWith(DRIVER_PHONE, 'offline')
    expect(notify.driverBalanceEmpty).toHaveBeenCalledWith(DRIVER_PHONE)
  })

  test('транзакция откатывается при ошибке UPDATE', async () => {
    txClient.query.mockImplementation((sql) => {
      if (/^BEGIN/i.test(sql))    return Promise.resolve()
      if (/^ROLLBACK/i.test(sql)) return Promise.resolve()
      if (/UPDATE orders/i.test(sql)) return Promise.reject(new Error('DB error'))
      return Promise.resolve({ rows: [] })
    })
    await expect(orderEngine.complete(100, DRIVER_PHONE)).resolves.toMatchObject({ error: 'internal' })
    expect(txClient.query).toHaveBeenCalledWith('ROLLBACK')
  })

  test('FREE поездка — баланс водителя не меняется', async () => {
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'arrived', is_free: true })
    // UPDATE drivers НЕ должен вызываться при is_free=true
    await orderEngine.complete(100, DRIVER_PHONE)
    const driverUpdateCalls = txClient.query.mock.calls.filter(([sql]) =>
      typeof sql === 'string' && /UPDATE drivers/i.test(sql)
    )
    expect(driverUpdateCalls.length).toBe(0)
  })

  test('очищает сессию водителя после завершения', async () => {
    await orderEngine.complete(100, DRIVER_PHONE)
    expect(q.clearSession).toHaveBeenCalledWith(DRIVER_PHONE)
  })
})

// ─── accept() ─────────────────────────────────────────────────────

describe('orderEngine.accept()', () => {
  beforeEach(() => {
    q.getOrder.mockResolvedValue({ ...mockOrder })
    q.getDriver.mockResolvedValue({ ...mockDriver })
    q.atomicAcceptOrder.mockResolvedValue(true)
    q.setDriverStatus.mockResolvedValue(undefined)
    q.clearDispatchState.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    q.getSetting.mockResolvedValue('queue')
    q.getOnlineDriversQueue.mockResolvedValue([])
    notify.clientDriverFound.mockResolvedValue(undefined)
    notify.driverAccepted.mockResolvedValue(undefined)
    q.getOrder
      .mockResolvedValueOnce({ ...mockOrder })   // первый вызов — проверка статуса
      .mockResolvedValueOnce({ ...mockOrder, status: 'accepted', driver_id: mockDriver.id }) // после принятия
  })

  afterEach(() => jest.clearAllMocks())

  test('успешное принятие → { success: true }', async () => {
    const result = await orderEngine.accept(100, DRIVER_PHONE)
    expect(result).toEqual({ success: true })
  })

  test('атомарный accept вызывается с orderId и driver.id', async () => {
    await orderEngine.accept(100, DRIVER_PHONE)
    expect(q.atomicAcceptOrder).toHaveBeenCalledWith(100, mockDriver.id)
  })

  test('уведомляет клиента о найденном водителе', async () => {
    await orderEngine.accept(100, DRIVER_PHONE)
    expect(notify.clientDriverFound).toHaveBeenCalledWith(
      CLIENT_PHONE,
      expect.objectContaining({ id: mockDriver.id })
    )
  })

  test('возвращает already_taken если atomicAccept вернул false', async () => {
    q.atomicAcceptOrder.mockResolvedValue(false)
    q.setSession.mockResolvedValue(undefined)
    const result = await orderEngine.accept(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'already_taken' })
  })

  test('возвращает unavailable если заказ не в статусе searching', async () => {
    q.getOrder.mockReset()
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'accepted' })
    const result = await orderEngine.accept(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'unavailable' })
  })

  test('возвращает driver_not_found если водитель не найден', async () => {
    q.getDriver.mockResolvedValue(null)
    const result = await orderEngine.accept(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'driver_not_found' })
  })
})

// ─── arrived() ────────────────────────────────────────────────────

describe('orderEngine.arrived()', () => {
  beforeEach(() => {
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'accepted' })
    q.updateOrder.mockResolvedValue(undefined)
    q.setSession.mockResolvedValue(undefined)
    notify.clientArrived.mockResolvedValue(undefined)
    notify.driverTripStarted.mockResolvedValue(undefined)
    notify.clientInTrip.mockResolvedValue(undefined)
  })

  afterEach(() => jest.clearAllMocks())

  test('успешно → { success: true }', async () => {
    const result = await orderEngine.arrived(100, DRIVER_PHONE)
    expect(result).toEqual({ success: true })
  })

  test('обновляет статус заказа на arrived', async () => {
    await orderEngine.arrived(100, DRIVER_PHONE)
    expect(q.updateOrder).toHaveBeenCalledWith(100, expect.objectContaining({ status: 'arrived' }))
  })

  test('уведомляет клиента о прибытии', async () => {
    await orderEngine.arrived(100, DRIVER_PHONE)
    expect(notify.clientArrived).toHaveBeenCalledWith(CLIENT_PHONE)
  })

  test('wrong_status если заказ не в статусе accepted', async () => {
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'searching' })
    const result = await orderEngine.arrived(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'wrong_status' })
  })

  test('not_found если заказ не найден', async () => {
    q.getOrder.mockResolvedValue(null)
    const result = await orderEngine.arrived(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'not_found' })
  })
})

// ─── falseCall() ──────────────────────────────────────────────────

describe('orderEngine.falseCall()', () => {
  beforeEach(() => {
    q.getOrder.mockResolvedValue({ ...mockOrder, status: 'accepted', driver_phone: DRIVER_PHONE })
    q.getDriver.mockResolvedValue({ ...mockDriver })
    q.getUser.mockResolvedValue(mockClient)
    q.saveFalseCall.mockResolvedValue(undefined)
    q.updateOrder.mockResolvedValue(undefined)
    q.setDriverStatus.mockResolvedValue(undefined)
    q.moveDriverToEndOfQueue.mockResolvedValue(undefined)
    q.clearSession.mockResolvedValue(undefined)
    q.getFalseCallCount.mockResolvedValue(1)
    q.getSetting.mockResolvedValue(null)
    notify.falseCallClient.mockResolvedValue(undefined)
    notify.falseCallDriver.mockResolvedValue(undefined)
    notify.falseCallAdmin.mockResolvedValue(undefined)
  })

  afterEach(() => jest.clearAllMocks())

  test('успешно → { success: true }', async () => {
    const result = await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(result).toEqual({ success: true })
  })

  test('сохраняет ложный вызов с правильной ценой', async () => {
    await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(q.saveFalseCall).toHaveBeenCalledWith(100, mockClient.id, mockDriver.id, config.FALSE_CALL_PRICE)
  })

  test('уведомляет клиента и водителя о ложном вызове', async () => {
    await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(notify.falseCallClient).toHaveBeenCalledWith(CLIENT_PHONE, config.FALSE_CALL_PRICE, 1)
    expect(notify.falseCallDriver).toHaveBeenCalledWith(DRIVER_PHONE, config.FALSE_CALL_PRICE)
  })

  test('блокирует клиента после 3 ложных вызовов', async () => {
    q.getFalseCallCount.mockResolvedValue(3)
    q.blacklistUser.mockResolvedValue(undefined)
    await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(q.blacklistUser).toHaveBeenCalledWith(CLIENT_PHONE, true)
    expect(wa.sendText).toHaveBeenCalledWith(
      CLIENT_PHONE, expect.stringContaining('заблокирован')
    )
  })

  test('не блокирует клиента при 1-2 ложных вызовах', async () => {
    q.getFalseCallCount.mockResolvedValue(2)
    q.blacklistUser.mockResolvedValue(undefined)
    await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(q.blacklistUser).not.toHaveBeenCalled()
    expect(notify.falseCallClient).toHaveBeenCalled()
  })

  test('not_found если заказ не найден', async () => {
    q.getOrder.mockResolvedValue(null)
    const result = await orderEngine.falseCall(100, DRIVER_PHONE)
    expect(result).toMatchObject({ error: 'not_found' })
  })
})
