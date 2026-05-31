const q         = require('../db/queries');
const config    = require('../config');
const notify    = require('./notificationService');
const driverMgr = require('./driverManager');
const wa        = require('../whatsapp/greenApi');

const acceptTimers = new Map();
const arriveTimers = new Map();
// FIX: защита от двойного нажатия
const creatingOrder = new Set();

const clearTimer = (map, key) => {
  const e = map.get(key);
  if (e) { clearTimeout(e.timer||e); map.delete(key); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── СОЗДАНИЕ ЗАКАЗА ──────────────────────────────────────────
const create = async (clientPhone, destination, priceInfo) => {
  // FIX 4: защита от двойного нажатия
  if (creatingOrder.has(clientPhone)) return null;
  creatingOrder.add(clientPhone);
  setTimeout(() => creatingOrder.delete(clientPhone), 5000);

  try {
    const client = await q.getUser(clientPhone);
    if (!client) return null;

    // Читаем настройки программ из БД (можно отключить/изменить в любой момент)
    const [
      referralEnabled,
      loyaltyEnabled,
      loyaltyEvery,
    ] = await Promise.all([
      q.getSetting('referral_enabled'),
      q.getSetting('loyalty_enabled'),
      q.getSetting('loyalty_every'),
    ]);

    const bonusTrips   = await q.getBonusTrips(clientPhone);
    const everyN       = parseInt(loyaltyEvery) || config.FREE_TRIP_EVERY;
    let isFree         = false;
    let freeReason     = null;

    // Приоритет 1: реферальный бонус (если программа включена)
    if (referralEnabled !== 'false' && bonusTrips > 0) {
      isFree     = true;
      freeReason = 'bonus';
      await q.useBonusTrip(clientPhone);
    }
    // Приоритет 2: программа лояльности (если включена)
    else if (loyaltyEnabled !== 'false' && (client.trip_count + 1) % everyN === 0) {
      isFree     = true;
      freeReason = 'loyalty';
    }

    const order = await q.createOrder({
      client_id: client.id, destination,
      price: priceInfo.price, tariff_id: priceInfo.tariff?.id||null, is_free: isFree,
    });

    await notify.clientSearching(clientPhone, destination, priceInfo.price, isFree, freeReason);
    await q.setSession(clientPhone, 'waiting_driver', { order_id: order.id });

    const mode = await q.getSetting('distribution_mode') || 'queue';
    if (mode === 'first') dispatch_first(order);
    else dispatch_queue(order.id, [], 0);

    return order;
  } finally {
    creatingOrder.delete(clientPhone);
  }
};

// ─── ОЧЕРЕДЬ ──────────────────────────────────────────────────
const dispatch_queue = async (orderId, tried, circles) => {
  const order = await q.getOrder(orderId);
  if (!order || order.status !== 'searching') return;

  const driver = await driverMgr.getNextDriver(tried);
  if (!driver) {
    const allOnline = await q.getOnlineDriversQueue();
    if (!allOnline.length || circles >= config.MAX_CIRCLES) {
      await q.updateOrder(orderId, { status:'cancelled', cancel_reason:'no_drivers', cancelled_at: new Date() });
      await notify.clientNoDrivers(order.client_phone);
      await q.clearSession(order.client_phone);
      return;
    }
    await sleep(config.PAUSE_MS);
    await dispatch_queue(orderId, [], circles + 1);
    return;
  }

  await notify.driverNewOrder(driver.phone, order);
  await q.setSession(driver.phone, 'idle', { pending_order_id: order.id });

  const timer = setTimeout(async () => {
    acceptTimers.delete(orderId);
    await notify.driverTimeout(driver.phone);
    await q.moveDriverToEndOfQueue(driver.phone);
    await sleep(config.PAUSE_MS);
    await dispatch_queue(orderId, [...tried, driver.phone], circles);
  }, config.ACCEPT_TIMEOUT_MS);

  acceptTimers.set(orderId, { timer, driverPhone: driver.phone });
};

// ─── ПЕРВЫЙ ПРИНЯЛ ────────────────────────────────────────────
const dispatch_first = async (order) => {
  const drivers = await driverMgr.getAllOnline();
  if (!drivers.length) {
    await q.updateOrder(order.id, { status:'cancelled', cancel_reason:'no_drivers', cancelled_at: new Date() });
    await notify.clientNoDrivers(order.client_phone);
    await q.clearSession(order.client_phone);
    return;
  }
  for (const d of drivers) {
    await notify.driverNewOrder(d.phone, order);
    await q.setSession(d.phone, 'idle', { pending_order_id: order.id });
    await sleep(200);
  }
  const timer = setTimeout(async () => {
    acceptTimers.delete(order.id);
    const fresh = await q.getOrder(order.id);
    if (fresh?.status === 'searching') {
      await q.updateOrder(order.id, { status:'cancelled', cancel_reason:'no_response', cancelled_at: new Date() });
      await notify.clientNoDrivers(order.client_phone);
      await q.clearSession(order.client_phone);
      for (const d of drivers) await wa.sendText(d.phone, '⏱ Время вышло — никто не принял заказ.');
    }
  }, config.ACCEPT_TIMEOUT_MS);
  acceptTimers.set(order.id, { timer, driverPhone: null });
};

// ─── ПРИНЯТЬ ──────────────────────────────────────────────────
const accept = async (orderId, driverPhone) => {
  clearTimer(acceptTimers, orderId);
  const order = await q.getOrder(orderId);
  if (!order || order.status !== 'searching') return { error: 'unavailable' };
  const driver = await q.getDriver(driverPhone);
  if (!driver) return { error: 'driver_not_found' };

  // FIX: атомарный UPDATE — защита от гонки в режиме "первый принял"
  const accepted = await q.atomicAcceptOrder(orderId, driver.id);
  if (!accepted) return { error: 'already_taken' }; // другой водитель успел первым
  await q.setDriverStatus(driverPhone, 'busy');

  const mode = await q.getSetting('distribution_mode') || 'queue';
  if (mode === 'first') {
    const all = await q.getOnlineDriversQueue();
    for (const d of all) if (d.phone !== driverPhone) await wa.sendText(d.phone, '✅ Заказ принят другим водителем.');
  }
  const updated = await q.getOrder(orderId);
  await notify.clientDriverFound(order.client_phone, driver);
  await notify.driverAccepted(driverPhone, updated);

  const t = setTimeout(async () => {
    arriveTimers.delete(orderId);
    await wa.sendText(driverPhone, '⚠️ Прошло 12 минут — клиент всё ещё ждёт.');
  }, config.ARRIVE_TIMEOUT_MS);
  arriveTimers.set(orderId, t);
  return { success: true };
};

// ─── ПРИБЫЛ ───────────────────────────────────────────────────
const arrived = async (orderId, driverPhone) => {
  clearTimer(arriveTimers, orderId);
  const order = await q.getOrder(orderId);
  if (!order) return { error: 'not_found' };
  // Гард: можно нажать "Прибыл" только из статуса accepted
  if (order.status !== 'accepted') return { error: 'wrong_status' };
  await q.updateOrder(orderId, { status:'arrived', arrived_at: new Date() });
  await notify.clientArrived(order.client_phone);
  await q.setSession(order.client_phone, 'in_trip', { order_id: orderId });
  await notify.driverTripStarted(driverPhone, order);
  await notify.clientInTrip(order.client_phone, order.destination);
  return { success: true };
};

// ─── ЗАВЕРШИТЬ ────────────────────────────────────────────────
const complete = async (orderId, driverPhone) => {
  const order  = await q.getOrder(orderId);
  if (!order) return { error: 'not_found' };
  // Гард: завершить можно только из arrived
  if (!['arrived', 'accepted'].includes(order.status)) return { error: 'wrong_status' };
  const driver = await q.getDriver(driverPhone);

  await q.updateOrder(orderId, { status:'completed', completed_at: new Date() });
  const newTripCount = await q.incrementTripCount(order.client_phone);

  // Активировать реферал если это первая поездка
  if (newTripCount === 1) {
    const client = await q.getUser(order.client_phone);
    if (client) {
      const refResult = await q.activateReferral(client.id);
      if (refResult?.referrerPhone) {
        // Уведомить реферера о начислении бонуса
        await wa.sendText(refResult.referrerPhone,
          `🎁 *Реферальный бонус!*

Ваш друг завершил первую поездку.
` +
          `Вам начислена *1 бесплатная поездка*! 🚖

` +
          `Используется автоматически при следующем заказе.`
        );
      }
    }
  }

  // FIX 3: передаём destination для кнопки «Повторить»
  await notify.clientCompleted(order.client_phone, order.price, order.is_free, order.destination);
  await q.setSession(order.client_phone, 'idle', {});

  const result = await driverMgr.afterTrip(driverPhone, driver?.id, order.is_free);
  if (result.offline) {
    await notify.driverBalanceEmpty(driverPhone);
  } else {
    await notify.driverBalanceLow(driverPhone, result.balance);
    const freeNote = order.is_free ? '\n🎁 Эта поездка — *бесплатная* (баланс не списан).' : '';
    const stats = await q.getDriverTodayStats(driver?.id);
    const bal   = result.balance >= 999999 ? '∞' : result.balance;
    const pos   = await q.getDriverQueuePosition(driverPhone);
    const cnt   = (await q.getOnlineDriversQueue()).length;
    await wa.sendText(driverPhone,
      `✅ Поездка завершена!${freeNote}\n\n` +
      `📊 *Статистика за сегодня:*\n` +
      `🚖 Поездок: *${stats?.completed || 0}*\n` +
      `💰 Заработано: *${Number(stats?.earned || 0).toLocaleString()} тг*\n` +
      `📦 Баланс: *${bal}*\n\n` +
      `🔢 Вы *${pos}-й* в очереди из *${cnt}* водителей\n` +
      `Ждём следующего заказа! 🚖`
    );
  }
  await q.clearSession(driverPhone);
  return { success: true };
};

// ─── ОТМЕНА ───────────────────────────────────────────────────
const cancel = async (orderId, reason = 'client') => {
  clearTimer(acceptTimers, orderId);
  clearTimer(arriveTimers, orderId);
  const order = await q.getOrder(orderId);
  if (!order) return;
  await q.updateOrder(orderId, { status:'cancelled', cancel_reason: reason, cancelled_at: new Date() });
  await notify.clientCancelled(order.client_phone);
  await q.clearSession(order.client_phone);
  if (order.driver_phone) {
    await q.setDriverStatus(order.driver_phone, 'online');
    await q.moveDriverToEndOfQueue(order.driver_phone);
    await wa.sendText(order.driver_phone, `❌ Заказ отменён.\nПричина: ${reason === 'client' ? 'клиент отменил' : reason}`);
    await q.clearSession(order.driver_phone);
  }
};

// ─── ЛОЖНЫЙ ВЫЗОВ ─────────────────────────────────────────────
const falseCall = async (orderId, driverPhone) => {
  const order = await q.getOrder(orderId);
  if (!order) return { error: 'not_found' };
  const driver = await q.getDriver(driverPhone);
  const client = await q.getUser(order.client_phone);
  await q.saveFalseCall(orderId, client.id, driver?.id, config.FALSE_CALL_PRICE);
  await q.updateOrder(orderId, { status:'cancelled', cancel_reason:'false_call', cancelled_at: new Date() });
  await q.setDriverStatus(driverPhone, 'online');
  await q.moveDriverToEndOfQueue(driverPhone);
  await q.clearSession(driverPhone);
  await q.clearSession(order.client_phone);
  const total = await q.getFalseCallCount(client.id);

  // Автоблокировка при 3+ ложных вызовах
  if (total >= 3) {
    await q.blacklistUser(order.client_phone, true);
    await wa.sendText(order.client_phone,
      `🚫 *Ваш аккаунт заблокирован.*\n\nПричина: 3 ложных вызова.\nОбратитесь к администратору.`
    );
    const adminPhone = await q.getSetting('admin_phone');
    if (adminPhone) await wa.sendText(adminPhone,
      `🚫 Клиент ${order.client_phone} *автоматически заблокирован* после ${total} ложных вызовов.`
    );
  } else {
    await notify.falseCallClient(order.client_phone, config.FALSE_CALL_PRICE, total);
  }

  await notify.falseCallDriver(driverPhone, config.FALSE_CALL_PRICE);
  const adminPhone = await q.getSetting('admin_phone');
  await notify.falseCallAdmin(adminPhone, order.client_phone, driver?.full_name, config.FALSE_CALL_PRICE);
  return { success: true };
};

// Обёртка — все публичные функции возвращают { error } при исключении
const safe = (fn) => async (...args) => {
  try {
    return await fn(...args);
  } catch (err) {
    console.error(`[orderEngine/${fn.name}]`, err.message);
    return { error: 'internal', message: err.message };
  }
};

module.exports = {
  create:    safe(create),
  accept:    safe(accept),
  arrived:   safe(arrived),
  complete:  safe(complete),
  cancel:    safe(cancel),
  falseCall: safe(falseCall),
};
