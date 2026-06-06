const db = require('../db/index')
const q = require('../db/queries')
const config = require('../config')
const notify = require('./notificationService')
const driverMgr = require('./driverManager')
const wa = require('../whatsapp/greenApi')
const log = require('../logger')

const acceptTimers = new Map()
const ratingTimers = new Map()

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
  clearTimer(ratingTimers, clientPhone)

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
  if (priceInfo.pickup_address)  orderData.pickup_address  = priceInfo.pickup_address
  if (priceInfo.is_intercity)    orderData.is_intercity    = true
  if (priceInfo.scheduled_time)  orderData.scheduled_time  = priceInfo.scheduled_time

  const order = await q.createOrder(orderData)

  // ── Предзаказ: уведомляем и ждём время ──────────────────────────────────────
  if (priceInfo.scheduled_time) {
    log.order('scheduled', { orderId: order.id, client: clientPhone, dest: destination, scheduledFor: priceInfo.scheduled_time })
    const label = priceInfo.scheduled_label || 'запланированное время'
    await notify.scheduledCreated(clientPhone, destination, label, priceInfo.price)
    await q.setSession(clientPhone, 'scheduled', { order_id: order.id, scheduled_label: label })
    return order
  }

  // ── Обычный заказ: ищем водителя сразу ─────────────────────────────────────
  log.order('create', { orderId: order.id, client: clientPhone, dest: destination, price: priceInfo.price, isFree })
  await notify.clientSearching(clientPhone, destination, priceInfo.price, isFree)
  await q.setSession(clientPhone, 'waiting_driver', { order_id: order.id })

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

// Запускает предзаказ в момент наступления времени (вызывается из timerService)
const startScheduled = async (orderId, clientPhone) => {
  // Атомарный переход: scheduled → searching (защита от двойного запуска)
  const r = await db.query(
    `UPDATE orders SET status='searching' WHERE id=$1 AND status='scheduled' RETURNING *`,
    [orderId]
  )
  if (!r.rows[0]) return // Уже обработан

  const order = r.rows[0]
  log.order('scheduled_start', { orderId, client: clientPhone, dest: order.destination })
  await notify.scheduledStarting(clientPhone, order.destination)
  await q.setSession(clientPhone, 'waiting_driver', { order_id: orderId })

  setTimeout(async () => {
    try {
      const fresh = await q.getOrder(orderId).catch(() => null)
      if (fresh?.status === 'searching') {
        await wa.sendText(clientPhone, '🔍 *Ещё ищем водителя...* Спасибо за терпение!')
      }
    } catch (e) { console.error('[startScheduled/3min]', e.message) }
  }, 3 * 60 * 1000)

  const mode = await q.getSetting('distribution_mode') || 'queue'
  if (mode === 'first') dispatch_first(order).catch(e => console.error('[startScheduled/first]', e.message))
  else dispatch_queue(orderId, [], 0).catch(e => console.error('[startScheduled/queue]', e.message))
}

const dispatch_queue = async (orderId, triedInit, circlesInit) => {
  let tried   = triedInit;
  let circles = circlesInit;

  while (true) {
    const order = await q.getOrder(orderId)
    if (!order || order.status !== 'searching') return

    // Внутренний цикл: пропускаем водителей с незавершённой регистрацией
    let driver = await driverMgr.getNextDriver(tried)
    while (driver && (!driver.full_name || !driver.car_plate)) {
      console.log(`[OrderEngine] Пропускаем незавершившего регистрацию: ${driver.phone}`)
      await q.moveDriverToEndOfQueue(driver.phone)
      tried = [...tried, driver.phone]
      driver = await driverMgr.getNextDriver(tried)
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
      // Новый круг
      await sleep(config.PAUSE_MS)
      tried = []
      circles++
      continue
    }

    // Найден подходящий водитель — отправляем заказ и ставим таймер
    await notify.driverNewOrder(driver.phone, order)
    await q.setSession(driver.phone, 'idle', { pending_order_id: order.id })
    await q.setDispatchState(orderId, driver.phone).catch(e => console.error('[orderEngine/setDispatchState]', e.message))

    const timer = setTimeout(async () => {
      try {
        acceptTimers.delete(orderId)
        await q.clearDispatchState(orderId).catch(() => {})
        // Проверяем статус — водитель мог уже принять заказ пока таймер срабатывал
        const currentOrder = await q.getOrder(orderId).catch(() => null)
        if (!currentOrder || currentOrder.status !== 'searching') return
        await penalizeSkip(driver.phone)
        await q.moveDriverToEndOfQueue(driver.phone)
        await sleep(config.PAUSE_MS)
        await dispatch_queue(orderId, [...tried, driver.phone], circles)
      } catch (e) { console.error('[orderEngine/accept_timer]', e.message) }
    }, config.ACCEPT_TIMEOUT_MS || 60000)

    acceptTimers.set(orderId, { timer, driverPhone: driver.phone })
    return
  }
}

const dispatch_first = async (order) => {
  order = await q.getOrder(order.id)
  if (!order) return
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
  if (!accepted) {
    log.warn('orderEngine', 'already_taken', { orderId, driver: driverPhone })
    await q.setSession(driverPhone, 'idle', {}).catch(() => {}) // чистим stale pending_order_id
    return { error: 'already_taken' }
  }

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

  // Предупредить водителя если у клиента есть долг
  const clientForDebt = await q.getUser(order.client_phone)
  if (clientForDebt?.debt_tg > 0) {
    await wa.sendText(driverPhone,
      `⚠️ *Внимание!* У клиента долг *${clientForDebt.debt_tg} тг*.\n` +
      (clientForDebt.debt_reason ? `Причина: ${clientForDebt.debt_reason}\n` : '') +
      `Попросите оплатить долг при поездке.`
    )
  }
  // arriveTimers убраны — timerService проверяет через getUnwarnedArrivals каждые 2 мин
  return { success: true }
}

const arrived = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order) return { error: 'not_found' }
  if (order.status !== 'accepted') return { error: 'wrong_status' }
  if (order.driver_phone && order.driver_phone !== driverPhone) {
    log.warn('orderEngine', 'arrived_wrong_driver', { orderId, driverPhone, assigned: order.driver_phone })
    return { error: 'not_your_order' }
  }
  const driver = await q.getDriver(driverPhone).catch(() => null)
  await q.updateOrder(orderId, { status: 'arrived', arrived_at: new Date() })
  await notify.clientArrived(order.client_phone, driver)
  await q.setSession(order.client_phone, 'in_trip', { order_id: orderId })
  await notify.driverTripStarted(driverPhone, order)
  await notify.clientInTrip(order.client_phone, order.destination)
  return { success: true }
}

const complete = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId)
  if (!order) return { error: 'not_found' }
  if (!['arrived', 'accepted'].includes(order.status)) return { error: 'wrong_status' }
  if (order.driver_phone && order.driver_phone !== driverPhone) {
    log.warn('orderEngine', 'complete_wrong_driver', { orderId, driverPhone, assigned: order.driver_phone })
    return { error: 'not_your_order' }
  }
  const driver = await q.getDriver(driverPhone)

  // ── Атомарная транзакция: статус заказа + лояльность клиента + баланс водителя ──
  const txClient = await db.getClient()
  let newBalance
  try {
    await txClient.query('BEGIN')
    const commission = Math.round((order.price || 0) * 0.10)
    const updated = await txClient.query(
      `UPDATE orders SET status='completed', completed_at=NOW(), commission_tg=$2
       WHERE id=$1 AND status IN('arrived','accepted') RETURNING id`,
      [orderId, commission]
    )
    if (!updated.rows[0]) {
      await txClient.query('ROLLBACK')
      return { error: 'already_completed' }
    }
    await txClient.query(
      `UPDATE users SET trip_count=trip_count+1 WHERE phone=$1`,
      [order.client_phone]
    )
    if (!order.is_free) {
      const r = await txClient.query(
        `UPDATE drivers SET order_balance =
           CASE WHEN order_balance >= 999999 THEN order_balance
                WHEN order_balance > 0       THEN order_balance - 1
                ELSE 0 END
         WHERE id=$1 RETURNING order_balance`,
        [driver.id]
      )
      newBalance = r.rows[0]?.order_balance ?? 0
    } else {
      newBalance = driver?.order_balance ?? 1
    }
    await txClient.query('COMMIT')
  } catch (e) {
    await txClient.query('ROLLBACK')
    throw e
  } finally {
    txClient.release()
  }

  // ── После транзакции: логирование, уведомления, сессии, очередь ────────────
  log.order('complete', { orderId, driver: driverPhone, client: order.client_phone, price: order.price, isFree: order.is_free })
  await q.clearDebt(order.client_phone).catch(() => {})
  await notify.clientCompleted(order.client_phone, order.price, order.is_free, order.destination)
  const driverName = driver?.full_name || 'водитель'
  await q.setSession(order.client_phone, 'waiting_rating', { order_id: orderId, driver_id: driver?.id, driver_name: driverName })
  clearTimer(ratingTimers, order.client_phone)

  // Запрос оценки через 5 секунд (после прочтения прощания)
  const ratingTimer = setTimeout(async () => {
    ratingTimers.delete(order.client_phone)
    try {
      const sess = await q.getSession(order.client_phone).catch(() => null)
      if (sess?.state !== 'waiting_rating') return
      const ratingMsg =
        `⭐ *Оцените поездку!*\n\n` +
        `Как вам водитель *${driverName}*?\n\n` +
        `Напишите цифру:\n` +
        `*5* — 🤩 Отлично\n` +
        `*4* — 😊 Хорошо\n` +
        `*3* — 😐 Нормально\n` +
        `*2* — 😕 Так себе\n` +
        `*1* — 😞 Плохо`
      await wa.sendButtons(order.client_phone, ratingMsg, [
        { id: 'rating_5', text: '🤩 Отлично (5)' },
        { id: 'rating_3', text: '😐 Нормально (3)' },
        { id: 'rating_1', text: '😞 Плохо (1)' },
      ])
    } catch (e) { console.error('[orderEngine/rating_request]', e.message) }
  }, 5000)
  ratingTimers.set(order.client_phone, ratingTimer)

  if (newBalance === 0) {
    await q.setDriverStatus(driverPhone, 'offline')
    await notify.driverBalanceEmpty(driverPhone)
  } else if (order.is_intercity) {
    // Межгород: водитель не возвращается сразу — офлайн до ручного "на линию"
    await q.setDriverStatus(driverPhone, 'offline')
    const freeNote = order.is_free ? '\n🎁 Поездка бесплатная — баланс не списан.' : ''
    const stats = await q.getDriverTodayStats(driver?.id)
    const bal = newBalance >= 999999 ? '∞' : newBalance
    await wa.sendText(driverPhone,
      '✅ *Межгород завершён!*' + freeNote + '\n\n' +
      '📊 Сегодня: *' + (stats?.completed || 0) + '* поездок | *' + Number(stats?.earned || 0).toLocaleString() + ' тг*\n' +
      '📦 Баланс: *' + bal + '*\n\n' +
      '📍 Когда вернётесь в Осакаровку — напишите *на линию*.'
    )
  } else {
    await q.setDriverStatus(driverPhone, 'online')
    await q.moveDriverToEndOfQueue(driverPhone)
    if (driver && parseFloat(driver.rating) < config.LOW_RATING) {
      await q.updateDriver(driverPhone, { skip_next: true })
    }
    await notify.driverBalanceLow(driverPhone, newBalance)
    const freeNote = order.is_free ? '\n🎁 Поездка бесплатная — баланс не списан.' : ''
    const stats = await q.getDriverTodayStats(driver?.id)
    const bal = newBalance >= 999999 ? '∞' : newBalance
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
  if (order.driver_phone && order.driver_phone !== driverPhone) {
    log.warn('orderEngine', 'falseCall_wrong_driver', { orderId, driverPhone, assigned: order.driver_phone })
    return { error: 'not_your_order' }
  }
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
  const dateStr = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  await q.addDebt(order.client_phone, config.FALSE_CALL_PRICE, `Ложный вызов от ${dateStr}`)
  const adminPhone = await q.getSetting('admin_phone')

  if (total >= 5) {
    await q.blacklistUser(order.client_phone, true, `Систематические ложные вызовы (${total}+)`)
    await wa.sendText(order.client_phone,
      `🚫 *Ваш аккаунт заблокирован.*\nПричина: ${total} ложных вызовов.\n\nДолг: *${config.FALSE_CALL_PRICE} тг*.\nОбратитесь к администратору.`
    )
    if (adminPhone) await wa.sendText(adminPhone,
      `🚫 Клиент ${order.client_phone} *заблокирован навсегда*. Ложных вызовов: ${total}.`
    )
  } else if (total >= 3) {
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000)
    await q.tempBlockUser(order.client_phone, until, `${total} ложных вызова`)
    const untilStr = until.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
    await wa.sendText(order.client_phone,
      `⏸ *Временный блок на 24 часа.*\nПричина: ${total} ложных вызова.\n\nДолг: *${config.FALSE_CALL_PRICE} тг* — оплатите водителю при следующей поездке.\n\nРазблокировка: *${untilStr}*`
    )
    if (adminPhone) await wa.sendText(adminPhone,
      `⚠️ Клиент ${order.client_phone} заблокирован на 24ч (${total} ложных вызова).`
    )
  } else {
    await notify.falseCallClient(order.client_phone, config.FALSE_CALL_PRICE, total)
  }
  await notify.falseCallDriver(driverPhone, config.FALSE_CALL_PRICE)
  if (adminPhone) await notify.falseCallAdmin(adminPhone, order.client_phone, driver?.full_name, config.FALSE_CALL_PRICE)
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
  startScheduled: safe(startScheduled),
}
