const db = require('../db/index')
const q = require('../db/queries')
const config = require('../config')
const notify = require('./notificationService')
const driverMgr = require('./driverManager')
const wa = require('../whatsapp/greenApi')
const log = require('../logger')

const acceptTimers = new Map()

const clearTimer = (map, key) => { const e = map.get(key); if (e) { clearTimeout(e.timer || e); map.delete(key) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Снижаем рейтинг водителя при пропуске заказа
const penalizeSkip = async (driverPhone) => {
  try {
    await db.query(`
      UPDATE drivers SET
        rating = GREATEST(3.0, COALESCE(rating, 5.0) - 0.1)
      WHERE user_id = (SELECT id FROM users WHERE phone = $1)
    `, [driverPhone])
    await wa.sendText(driverPhone,
      '⏱ *Время вышло* — заказ передан следующему водителю.\n\n' +
      '📉 Рейтинг немного снизился из-за пропуска.\n' +
      '⚡ Старайтесь отвечать быстрее!'
    )
  } catch (e) { console.error('[penalizeSkip]', e.message) }
}

const create = async (clientPhone, destination, priceInfo) => {
  // Защита от дублей через БД вместо in-memory Set
  const existing = await q.getActiveOrderByClient(clientPhone)
  if (existing) {
    log.warn('orderEngine', 'duplicate_create_blocked', { client: clientPhone })
    return null
  }

  const client = await q.getUser(clientPhone)
  if (!client) return null

  const [loyaltyEnabled, loyaltyEvery] = await Promise.all([
    q.getSetting('loyalty_enabled'), q.getSetting('loyalty_every'),
  ])
  const everyN = parseInt(loyaltyEvery) || config.FREE_TRIP_EVERY
  let isFree = false
  if (loyaltyEnabled !== 'false' && (client.trip_count + 1) % everyN === 0) { isFree = true }

  const orderData = {
    client_id: client.id, destination,
    price: priceInfo.price, tariff_id: priceInfo.tariff?.id || null, is_free: isFree,
  }
  if (priceInfo.pickup_address) orderData.pickup_address = priceInfo.pickup_address
  if (priceInfo.is_intercity) orderData.is_intercity = true

  const order = await q.createOrder(orderData)
  log.order('create', { orderId: order.id, client: clientPhone, dest: destination, price: priceInfo.price, isFree })
  await notify.clientSearching(clientPhone, destination, priceInfo.price, isFree)
  await q.setSession(clientPhone, 'waiting_driver', { order_id: order.id })

  // Уведомление если ищем долго (3 мин)
  setTimeout(async () => {
    try {
      const fresh = await q.getOrder(order.id).catch(() => null)
      if (fresh?.status === 'searching') {
        await wa.sendText(clientPhone, '🔍 *Ещё ищем водителя...* Спасибо за терпение!\nКак только найдём — сразу сообщим! 🚖')
      }
    } catch (e) { console.error('[orderEngine/3min_reminder]', e.message) }
  }, 3 * 60 * 1000)

  const mode = await q.getSetting('distribution_mode') || 'queue'
  if (mode === 'first') dispatch_first(order).catch(e => console.error('[dispatch_first]', e.message))
  else dispatch_queue(order.id, [], 0).catch(e => console.error('[dispatch_queue]', e.message))
  return order
}

const dispatch_queue = async (orderId, tried, circles) => {
  const order = await q.getOrder(orderId)
  if (!order || order.status !== 'searching') return
  const driver = await driverMgr.getNextDriver(tried)

  // Пропускаем водителя с незавершённой регистрацией
  if (driver && (!driver.full_name || !driver.car_plate)) {
    console.log(`[OrderEngine] Пропускаем незавершившего регистрацию: ${driver.phone}`)
    await q.moveDriverToEndOfQueue(driver.phone)
    return dispatch_queue(orderId, [...tried, driver.phone], circles)
  }

  if (!driver) {
    const allOnline = await q.getOnlineDriversQueue()
    if (!allOnline.length || circles >= config.MAX_CIRCLES) {
      const orderSession = await q.getSession('order_' + orderId).catch(() => null)
      const alreadyNotified = orderSession?.ctx?.offline_notified
      if (!allOnline.length && circles === 0 && !alreadyNotified) {
        await q.setSession('order_' + orderId, 'searching', { offline_notified: true }).catch(() => {})
        const allDrivers = await q.getAllDrivers().catch(() => [])
        const offlineWithBalance = allDrivers.filter(d => d.status === 'offline' && d.order_balance > 0)
        for (const d of offlineWithBalance) {
          await wa.sendText(d.phone,
            '🚖 *Есть заказ!*\n\n📍 ' + order.destination + '\n💰 ' + order.price + ' тг\n\n' +
            'Выйдите на линию — напишите *"на линию"*!'
          ).catch(() => {})
          await sleep(300)
        }
        // Даём 2 минуты на выход водителей
        if (offlineWithBalance.length > 0) {
          console.log(`[OrderEngine] Нет онлайн водителей. Откладываем заказ ${orderId} на 2 минуты`)
          await q.setSession('order_' + orderId, 'searching', { offline_notified: true, resume_at: Date.now() + 120000 })
          return
        }
      }
      await q.updateOrder(orderId, { status: 'cancelled', cancel_reason: 'no_drivers', cancelled_at: new Date() })
      await notify.clientNoDrivers(order.client_phone)
      await q.clearSession(order.client_phone)
      return
    }
    await sleep(config.PAUSE_MS)
    await dispatch_queue(orderId, [], circles + 1)
    return
  }

  await notify.driverNewOrder(driver.phone, order)
  await q.setSession(driver.phone, 'idle', { pending_order_id: order.id })

  // Персистируем dispatch state в БД для восстановления после рестарта
  await q.setDispatchState(orderId, driver.phone).catch(e => console.error('[orderEngine/setDispatchState]', e.message))

  // Таймер 60 секунд — не принял → рейтинг падает → следующий
  const timer = setTimeout(async () => {
    try {
      acceptTimers.delete(orderId)
      await q.clearDispatchState(orderId).catch(() => {})
      await penalizeSkip(driver.phone)
      await q.moveDriverToEndOfQueue(driver.phone)
      await sleep(config.PAUSE_MS)
      await dispatch_queue(orderId, [...tried, driver.phone], circles)
    } catch (e) { console.error('[orderEngine/accept_timer]', e.message) }
  }, config.ACCEPT_TIMEOUT_MS || 60000)

  acceptTimers.set(orderId, { timer, driverPhone: driver.phone })
}

const dispatch_first = async (order) => {
  const drivers = await driverMgr.getAllOnline()
  if (!drivers.length) {
    await q.updateOrder(order.id, { status: 'cancelled', cancel_reason: 'no_drivers', cancelled_at: new Date() })
    await notify.clientNoDrivers(order.client_phone)
    await q.clearSession(order.client_phone)
    return
  }
  for (const d of drivers) {
    await notify.driverNewOrder(d.phone, order)
    await q.setSession(d.phone, 'idle', { pending_order_id: order.id })
    await sleep(200)
  }
  const timer = setTimeout(async () => {
    acceptTimers.delete(order.id)
    const fresh = await q.getOrder(order.id)
    if (fresh?.status === 'searching') {
      await q.updateOrder(order.id, { status: 'cancelled', cancel_reason: 'no_response', cancelled_at: new Date() })
      await notify.clientNoDrivers(order.client_phone)
      await q.clearSession(order.client_phone)
      for (const d of drivers) {
        await penalizeSkip(d.phone)
      }
    }
  }, config.ACCEPT_TIMEOUT_MS || 60000)
  acceptTimers.set(order.id, { timer, driverPhone: null })
}

const accept = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order || order.status !== 'searching') return { error: 'unavailable' }
  const driver = await q.getDriver(driverPhone)
  if (!driver) return { error: 'driver_not_found' }
  const accepted = await q.atomicAcceptOrder(orderId, driver.id)
  if (!accepted) { log.warn('orderEngine', 'already_taken', { orderId, driver: driverPhone }); return { error: 'already_taken' } }

  clearTimer(acceptTimers, orderId)
  // Снимаем dispatch state из БД после принятия
  await q.clearDispatchState(orderId).catch(() => {})
  log.order('accept', { orderId, driver: driverPhone })

  await q.setDriverStatus(driverPhone, 'busy')
  const mode = await q.getSetting('distribution_mode') || 'queue'
  if (mode === 'first') {
    const all = await q.getOnlineDriversQueue()
    for (const d of all) if (d.phone !== driverPhone) await wa.sendText(d.phone, 'Заказ принят другим водителем.')
  }
  const updated = await q.getOrder(orderId)
  await notify.clientDriverFound(order.client_phone, driver)
  await notify.driverAccepted(driverPhone, updated)
  // arriveTimers убраны — timerService проверяет через getUnwarnedArrivals каждые 2 мин
  return { success: true }
}

const arrived = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order) return { error: 'not_found' }
  if (order.status !== 'accepted') return { error: 'wrong_status' }
  await q.updateOrder(orderId, { status: 'arrived', arrived_at: new Date() })
  await notify.clientArrived(order.client_phone)
  await q.setSession(order.client_phone, 'in_trip', { order_id: orderId })
  await notify.driverTripStarted(driverPhone, order)
  await notify.clientInTrip(order.client_phone, order.destination)
  return { success: true }
}

const complete = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order) return { error: 'not_found' }
  if (!['arrived', 'accepted'].includes(order.status)) return { error: 'wrong_status' }
  const driver = await q.getDriver(driverPhone)
  await q.updateOrder(orderId, { status: 'completed', completed_at: new Date() })
  log.order('complete', { orderId, driver: driverPhone, client: order.client_phone, price: order.price, isFree: order.is_free })
  await q.incrementTripCount(order.client_phone)
  await notify.clientCompleted(order.client_phone, order.price, order.is_free, order.destination)
  await q.setSession(order.client_phone, 'idle', {})

  // Запрос оценки через 4 секунды (после прочтения прощания)
  setTimeout(async () => {
    try {
      const sess = await q.getSession(order.client_phone).catch(() => null)
      if (sess?.state === 'idle') {
        await wa.sendButtons(order.client_phone,
          '⭐ *Оцените поездку!*\n\nКак вам водитель *' + (driver?.full_name || 'водитель') + '*?',
          [
            { id: 'rating_5', text: '😊 Отлично' },
            { id: 'rating_3', text: '😐 Нормально' },
            { id: 'rating_1', text: '😞 Плохо' },
          ]
        )
        await q.setSession(order.client_phone, 'waiting_rating', {
          order_id: orderId, driver_id: driver?.id
        })
      }
    } catch (e) { console.error('[orderEngine/rating_request]', e.message) }
  }, 4000)

  const result = await driverMgr.afterTrip(driverPhone, driver?.id, order.is_free)
  if (result.offline) {
    await notify.driverBalanceEmpty(driverPhone)
  } else {
    await notify.driverBalanceLow(driverPhone, result.balance)
    const freeNote = order.is_free ? '\n🎁 Поездка бесплатная — баланс не списан.' : ''
    const stats = await q.getDriverTodayStats(driver?.id)
    const bal = result.balance >= 999999 ? '∞' : result.balance
    const pos = await q.getDriverQueuePosition(driverPhone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendText(driverPhone,
      '✅ *Поездка завершена!*' + freeNote + '\n\n' +
      '📊 Сегодня: *' + (stats?.completed || 0) + '* поездок | *' + Number(stats?.earned || 0).toLocaleString() + ' тг*\n' +
      '📦 Баланс: *' + bal + '*\n' +
      '📋 Очередь: *' + pos + ' из ' + cnt + '*'
    )
  }
  await q.clearSession(driverPhone)
  return { success: true }
}

const cancel = async (orderId, reason = 'client') => {
  clearTimer(acceptTimers, orderId)
  const order = await q.getOrder(orderId)
  if (!order) return
  await q.updateOrder(orderId, { status: 'cancelled', cancel_reason: reason, cancelled_at: new Date() })
  log.order('cancel', { orderId, reason })
  const cancelReasonMap = {
    'no_drivers': 'Свободных водителей не нашлось',
    'no_response': 'Водители не ответили',
    'false_call': 'Ложный вызов',
    'restart': 'Перезапуск системы',
    'Клиент не вышел': 'Водитель не дождался клиента',
    'Водитель не может доехать': 'Водитель не смог доехать',
  }
  const displayReason = cancelReasonMap[reason] || (reason && reason !== 'client' && reason !== 'Отменен клиентом' ? reason : '')
  await notify.clientCancelled(order.client_phone, displayReason)
  await q.clearSession(order.client_phone)
  if (order.driver_phone) {
    await q.setDriverStatus(order.driver_phone, 'online')
    await q.moveDriverToEndOfQueue(order.driver_phone)
    await wa.sendText(order.driver_phone, 'Заказ отменён.\nПричина: ' + (reason === 'client' ? 'клиент отменил' : reason))
    await q.clearSession(order.driver_phone)
  }
}

const falseCall = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order) return { error: 'not_found' }
  const driver = await q.getDriver(driverPhone)
  const client = await q.getUser(order.client_phone)
  if (!client) {
    console.error('[falseCall] client not found:', order.client_phone)
    await q.setDriverStatus(driverPhone, 'online')
    await q.moveDriverToEndOfQueue(driverPhone)
    await q.clearSession(driverPhone)
    return { error: 'client_not_found' }
  }
  await q.saveFalseCall(orderId, client.id, driver?.id, config.FALSE_CALL_PRICE)
  await q.updateOrder(orderId, { status: 'cancelled', cancel_reason: 'false_call', cancelled_at: new Date() })
  await q.setDriverStatus(driverPhone, 'online')
  await q.moveDriverToEndOfQueue(driverPhone)
  await q.clearSession(driverPhone)
  await q.clearSession(order.client_phone)
  const total = await q.getFalseCallCount(client.id)
  if (total >= 3) {
    await q.blacklistUser(order.client_phone, true)
    await wa.sendText(order.client_phone, 'Ваш аккаунт заблокирован.\nПричина: 3 ложных вызова.\nОбратитесь к администратору.')
    const adminPhone = await q.getSetting('admin_phone')
    if (adminPhone) await wa.sendText(adminPhone, 'Клиент ' + order.client_phone + ' заблокирован после ' + total + ' ложных вызовов.')
  } else {
    await notify.falseCallClient(order.client_phone, config.FALSE_CALL_PRICE, total)
  }
  await notify.falseCallDriver(driverPhone, config.FALSE_CALL_PRICE)
  const adminPhone = await q.getSetting('admin_phone')
  await notify.falseCallAdmin(adminPhone, order.client_phone, driver?.full_name, config.FALSE_CALL_PRICE)
  return { success: true }
}

const resumeDispatch = async (orderId) => {
  const order = await q.getOrder(orderId)
  if (!order || order.status !== 'searching') return
  await dispatch_queue(orderId, [], 0)
}

// Ручной пропуск водителем — отменяем таймер (без штрафа) и сразу передаём следующему
const skipOrder = async (orderId, driverPhone) => {
  clearTimer(acceptTimers, orderId)
  await q.clearDispatchState(orderId).catch(() => {})
  await q.setSession(driverPhone, 'idle', {})
  await q.moveDriverToEndOfQueue(driverPhone)
  await sleep(config.PAUSE_MS)
  dispatch_queue(orderId, [driverPhone], 0).catch(e => console.error('[skipOrder]', e.message))
}

const safe = (fn) => async (...args) => {
  try { return await fn(...args) }
  catch (err) { console.error('[orderEngine/' + fn.name + ']', err.message); return { error: 'internal', message: err.message } }
}

module.exports = {
  create: safe(create),
  accept: safe(accept),
  arrived: safe(arrived),
  complete: safe(complete),
  cancel: safe(cancel),
  falseCall: safe(falseCall),
  resumeDispatch: safe(resumeDispatch),
  skipOrder: safe(skipOrder),
}
