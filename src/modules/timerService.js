const cron = require('node-cron');
const { execFile } = require('child_process');
const fs   = require('fs');
const path = require('path');
const db = require('../db/index');
const q = require('../db/queries');
const notify = require('./notificationService');
const wa = require('../whatsapp/greenApi');
const config = require('../config');
// orderEngine импортируется здесь безопасно: timerService → orderEngine → нет timerService
const orderEngine = require('./orderEngine');
const driverMgr = require('./driverManager');

let _errLogSize = 0; // отслеживает рост errors.log

// ─── Мониторинг ──────────────────────────────────────────────

// Спайк ошибок: errors.log вырос >5 KB за 5 мин
const checkErrorSpike = async () => {
  const adminPhone = await q.getSetting('admin_phone').catch(() => null);
  if (!adminPhone) return;
  const logFile = path.join(__dirname, '../../logs/errors.log');
  try {
    const size = fs.statSync(logFile).size;
    const prev = _errLogSize;
    _errLogSize = size;
    if (prev > 0 && size - prev > 5 * 1024) {
      await wa.sendText(adminPhone,
        `⚠️ *Ошибки в боте!*\n\nЛог вырос на ${Math.round((size-prev)/1024)} KB за 5 мин.\n\n` +
        '`tail -50 ~/osakarovka-bot/logs/errors.log`'
      ).catch(() => {});
    }
  } catch {}
};

// Тишина: нет заказов >2 ч в рабочее время → возможная проблема с Green API
const checkSilence = async () => {
  const adminPhone = await q.getSetting('admin_phone').catch(() => null);
  if (!adminPhone) return;
  const r = await db.query(
    `SELECT COUNT(*) AS cnt FROM orders WHERE created_at > NOW() - INTERVAL '2 hours'`
  ).catch(() => null);
  if (!r) return;
  if (parseInt(r.rows[0]?.cnt || 0) === 0) {
    await wa.sendText(adminPhone,
      `🔕 *2 часа без заказов*\n\nВозможно клиенты не достигают бота.\nПроверьте Green API инстанс или WhatsApp соединение.`
    ).catch(() => {});
  }
};

// ─── Вспомогательные функции каждые 5 мин ────────────────────

const checkStuckOrders = async () => {
  const stuck = await db.query(
    `SELECT o.id FROM orders o
     WHERE o.status = 'searching'
       AND o.created_at < NOW() - INTERVAL '10 minutes'`
  ).then(r => r.rows).catch(() => []);
  for (const order of stuck) {
    // Используем orderEngine.cancel — чистит acceptTimers, уведомляет водителя, пишет лог
    await orderEngine.cancel(order.id, 'Нет водителей').catch(() => {});
  }
};

const checkInactiveDrivers = async () => {
  const inactive = await q.getInactiveDrivers(30).catch(() => []);
  for (const d of inactive) {
    await q.setDriverStatus(d.phone, 'offline');
    await notify.driverInactiveOffline(d.phone).catch(() => {});
  }
};

const warnInactiveDrivers = async () => {
  const r = await db.query(
    `SELECT u.phone, d.full_name FROM drivers d
     JOIN users u ON d.user_id = u.id
     WHERE d.status = 'online'
       AND d.last_activity < NOW() - make_interval(mins => $1)
       AND d.last_activity > NOW() - make_interval(mins => $2)`,
    [25, 28]
  ).then(r => r.rows).catch(() => []);
  for (const d of r) {
    await wa.sendText(d.phone,
      '⚠️ *' + d.full_name + '*, вы неактивны 25 минут.\n\n' +
      'Через *5 минут* автоматически уйдёте офлайн.\n\n' +
      'Напишите что-нибудь чтобы остаться на линии.'
    ).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
};

// ─── Возобновление диспетчеризации после ожидания офлайн-водителей ───────────

const checkWaitingDispatches = async () => {
  const r = await db.query(
    `SELECT phone, ctx FROM sessions
     WHERE phone LIKE 'order_%' AND state = 'searching'
       AND (ctx->>'resume_at') IS NOT NULL`
  ).then(r => r.rows).catch(() => [])

  for (const row of r) {
    const orderId = parseInt(row.phone.replace('order_', ''))
    const resumeAt = parseInt(row.ctx?.resume_at || 0)
    if (!resumeAt || Date.now() < resumeAt) continue

    // Сбрасываем resume_at, оставляем offline_notified=true чтобы не слать уведомления повторно
    await q.setSession('order_' + orderId, 'searching', { offline_notified: true }).catch(() => {})
    console.log(`[TimerService] Возобновляем диспетчеризацию заказа #${orderId}`)
    orderEngine.resumeDispatch(orderId).catch(e => console.error('[Timer/resume_dispatch]', e.message))
  }
}

// ─── Восстановление зависших диспетчеризаций после рестарта ──────────────────

// Заказы с dispatched_at < NOW() - ACCEPT_TIMEOUT_MS могли потерять таймер при рестарте.
// При рестарте timerService вызывает эту функцию один раз — разбирает зависшие.
const checkDispatchTimeouts = async () => {
  const timeoutMs = (config.ACCEPT_TIMEOUT_MS || 60000) + 10000 // +10s буфер
  const expired = await q.getExpiredDispatches(timeoutMs).catch(() => [])
  for (const order of expired) {
    try {
      const driverPhone = order.dispatched_to
      await q.clearDispatchState(order.id)
      if (driverPhone) {
        console.log(`[TimerService] Таймаут диспетчеризации: заказ #${order.id}, передаём следующему водителю`);
        await q.setSession(driverPhone, 'idle', {}).catch(() => {})
        orderEngine.resumeDispatch(order.id).catch(e => console.error('[Timer/resume_dispatch]', e.message))
      }
    } catch (e) { console.error('[Timer/dispatch_timeout]', e.message) }
  }
  return expired.length;
}

// ─── Предупреждение водителя и клиента при долгом движении к клиенту ─────────

const checkArriveWarnings = async () => {
  const warningMs = config.ARRIVE_TIMEOUT_MS || 12 * 60 * 1000
  const orders = await q.getUnwarnedArrivals(warningMs).catch(() => [])
  for (const order of orders) {
    try {
      await wa.sendText(order.driver_phone, '⏰ Прошло 12 минут — клиент всё ещё ждёт. Вы уже едете?')
        .catch(() => {})
      await wa.sendText(order.client_phone, '⏳ *Водитель немного задерживается*, но уже едет к вам.\nЕсли нужно — напишите водителю.')
        .catch(() => {})
      await q.setArriveWarned(order.id)
    } catch (e) { console.error('[Timer/arrive_warning]', e.message) }
  }
}

// ─── Восстановление перерывов водителей после рестарта ──────────────────

// Водители у которых break_until истёк пока бот был выключен — переводим обратно online.
const checkBreakTimers = async () => {
  const expired = await q.getExpiredBreaks().catch(() => [])
  for (const d of expired) {
    try {
      await q.clearBreakUntil(d.phone).catch(() => {})
      const driver = await q.getDriver(d.phone)
      if (driver?.status === 'offline') {
        const r = await driverMgr.goOnline(d.phone)
        if (r.success) {
          console.log(`[TimerService] Перерыв завершён: водитель ${d.phone} (${d.full_name}) → online`);
          const pos = await q.getDriverQueuePosition(d.phone)
          const cnt = (await q.getOnlineDriversQueue()).length
          await wa.sendText(d.phone,
            '🟢 *Перерыв закончился!*\n\nВы снова на линии — *' + pos + '-й* из *' + cnt + '* водителей. Удачных заказов! 🚖'
          )
        }
      }
    } catch (e) { console.error('[Timer/break_timer]', e.message) }
  }
  return expired.length;
}

// ─── Предзаказы ───────────────────────────────────────────────

const checkScheduledOrders = async () => {
  // 1. Напоминание за 30 мин до запланированного времени
  const soonOrders = await q.getScheduledOrdersSoon(30).catch(() => [])
  for (const order of soonOrders) {
    try {
      const { formatScheduleLabel } = require('./scheduleParser')
      const label = order.scheduled_time ? formatScheduleLabel(order.scheduled_time) : 'запланированное время'
      await wa.sendText(order.client_phone,
        '🔔 *Напоминание о предзаказе!*\n\n📍 *' + order.destination + '*\n⏰ ' + label + '\n\nЧерез 30 минут начнём поиск водителя.\nЧтобы отменить — напишите *отмена*.'
      ).catch(() => {})
      await db.query(`UPDATE orders SET scheduled_reminder_sent=true WHERE id=$1`, [order.id])
    } catch (e) { console.error('[Timer/sched_reminder]', e.message) }
  }

  // 2. Запуск диспетчеризации по наступлению времени
  const dueOrders = await q.getScheduledOrdersDue().catch(() => [])
  for (const order of dueOrders) {
    try {
      console.log(`[TimerService] Запуск предзаказа #${order.id} → ${order.destination}`)
      await orderEngine.startScheduled(order.id, order.client_phone)
    } catch (e) { console.error('[Timer/sched_start]', e.message) }
  }
}

// ─── Запуск всех крон-задач ───────────────────────────────────

const start = () => {
  console.log('[TimerService] Запуск...');

  // ─── Восстановление после рестарта (выполняется один раз при старте) ──────

  // 1. Зависшие диспетчеризации: водитель не ответил, таймер потерян при рестарте
  checkDispatchTimeouts()
    .then(n => { if (n > 0) console.log(`[TimerService] 🔧 Восстановлено диспетчеризаций: ${n}`); })
    .catch(e => console.error('[Timer/dispatch_startup]', e.message));

  // 2. Истёкшие перерывы: водитель был на паузе, бот перезапустился
  checkBreakTimers()
    .then(n => { if (n > 0) console.log(`[TimerService] 🔧 Завершено перерывов: ${n}`); })
    .catch(e => console.error('[Timer/break_startup]', e.message));

  console.log('[TimerService] Расписание активно');

  // Каждую минуту — проверка зависших диспетчеризаций + ожидающих + перерывов + предзаказов
  cron.schedule('*/1 * * * *', async () => {
    try { await checkDispatchTimeouts() } catch (e) { console.error('[Timer/dispatch_timeout]', e.message) }
    try { await checkWaitingDispatches() } catch (e) { console.error('[Timer/waiting_dispatches]', e.message) }
    try { await checkBreakTimers() } catch (e) { console.error('[Timer/break_timers]', e.message) }
    try { await checkScheduledOrders() } catch (e) { console.error('[Timer/scheduled_orders]', e.message) }
  })

  // Каждые 2 минуты — предупреждения о долгом ожидании прибытия
  cron.schedule('*/2 * * * *', async () => {
    try { await checkArriveWarnings(); } catch (e) { console.error('[Timer/arrive_warnings]', e.message); }
  })

  // Каждые 5 мин — основные задачи + мониторинг ошибок
  cron.schedule('*/5 * * * *', async () => {
    try { await checkStuckOrders(); }    catch(e) { console.error('[Timer/stuck_orders]', e.message); }
    try { await checkInactiveDrivers(); } catch(e) { console.error('[Timer/auto_offline]', e.message); }
    try { await warnInactiveDrivers(); }  catch(e) { console.error('[Timer/inactivity_warn]', e.message); }
    try { await q.cleanupMessageDedup(); } catch(e) {}
    try { await checkErrorSpike(); }      catch(e) { console.error('[Timer/error_spike]', e.message); }
  });

  // Каждые 2 ч в рабочее время (9-21) — нет заказов → проверить Green API
  cron.schedule('0 9,11,13,15,17,19,21 * * *', async () => {
    try { await checkSilence(); } catch(e) { console.error('[Timer/silence]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // Каждый час — уведомление водителям кто давно ждёт без заказов
  cron.schedule('0 * * * *', async () => {
    try {
      const waiting = await q.getLongWaitDrivers(60).catch(() => []);
      for (const d of waiting) {
        await notify.driverLongWait(d.phone);
      }
    } catch(e) { console.error('[Timer/longwait]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // Утро 9:00 — напоминание офлайн водителям
  cron.schedule('0 9 * * *', async () => {
    try {
      const r = await db.query(`
        SELECT u.phone, d.full_name, d.order_balance
        FROM drivers d
        JOIN users u ON d.user_id = u.id
        WHERE d.status = 'offline'
          AND d.last_activity > NOW() - INTERVAL '48 hours'
          AND d.order_balance > 0
      `);
      for (const d of r.rows) {
        await wa.sendText(d.phone,
          '☀️ *Доброе утро, ' + d.full_name + '!*\n\n🚖 Клиенты уже пишут — выходите на линию!\n\nНапишите *"на линию"* чтобы начать работу. 💪'
        );
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error('[Timer/morning_drivers]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // Вечер 17:00 — час пик
  cron.schedule('0 17 * * *', async () => {
    try {
      const ordersR = await db.query(
        `SELECT COUNT(*) AS cnt FROM orders WHERE created_at > NOW() - INTERVAL '1 hour'`
      );
      const ordersCount = parseInt(ordersR.rows[0]?.cnt || 0);
      if (ordersCount >= 2) {
        const r = await db.query(`
          SELECT u.phone, d.full_name FROM drivers d
          JOIN users u ON d.user_id = u.id
          WHERE d.status = 'offline' AND d.order_balance > 0
        `);
        for (const d of r.rows) {
          await wa.sendText(d.phone,
            '🔥 *' + d.full_name + ', вечерний час пик!*\n\n📊 За последний час: *' + ordersCount + '* заказов.\n🚖 Выходите на линию — напишите *"на линию"*!'
          );
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch(e) { console.error('[Timer/evening_rush]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // 12:00 — кто офлайн 3+ дней
  cron.schedule('0 12 * * *', async () => {
    try {
      const r = await db.query(`
        SELECT u.phone, d.full_name, d.last_activity
        FROM drivers d JOIN users u ON d.user_id = u.id
        WHERE d.status = 'offline'
          AND d.last_activity < NOW() - INTERVAL '3 days'
          AND d.last_activity > NOW() - INTERVAL '30 days'
          AND d.order_balance > 0
      `);
      for (const d of r.rows) {
        const days = Math.floor((Date.now() - new Date(d.last_activity)) / 86400000);
        await wa.sendText(d.phone,
          '👋 *' + d.full_name + '*, вас не было *' + days + ' дней!*\n\n🚖 Клиенты скучают — ждём вас!\nКогда будете готовы — напишите *"на линию"*. 😊'
        );
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error('[Timer/longoffline]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // 22:00 — ежедневный итог водителям
  cron.schedule('0 22 * * *', async () => {
    try {
      const drivers = await db.query(`
        SELECT u.phone, d.id, d.full_name, d.status
        FROM drivers d JOIN users u ON d.user_id = u.id
        WHERE d.last_activity > NOW() - INTERVAL '24 hours'
      `).then(r => r.rows).catch(() => []);
      for (const d of drivers) {
        const stats = await q.getDriverTodayStats(d.id).catch(() => null);
        if (stats && (stats.completed > 0 || stats.earned > 0)) {
          await wa.sendText(d.phone,
            '🌙 *Итоги дня, ' + d.full_name + '!*\n\n' +
            '🚖 Поездок: *' + (stats.completed||0) + '*\n' +
            '💰 Заработано: *' + Number(stats.earned||0).toLocaleString() + ' тг*\n\n' +
            '👏 Спасибо за работу! Отдыхайте. До завтра! 😴'
          );
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch(e) { console.error('[Timer/daily_summary]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // 08:00 — утренняя сводка админу
  cron.schedule('0 8 * * *', async () => {
    try {
      const adminPhone = await q.getSetting('admin_phone');
      if (!adminPhone) return;
      const stats = await q.getPeriodStats(1);
      const drivers = await q.getAllDrivers();
      const online = drivers.filter(d => ['online','busy'].includes(d.status)).length;
      await wa.sendText(adminPhone,
        '☀️ *Доброе утро! Итоги вчера:*\n\n' +
        '✅ Поездок: *' + stats.completed + '*\n' +
        '❌ Отменено: *' + stats.cancelled + '*\n' +
        '💰 Оборот: *' + Number(stats.revenue).toLocaleString() + ' тг*\n' +
        '👤 Клиентов: *' + stats.unique_clients + '*\n\n' +
        '🚗 Водителей сейчас: *' + online + '/' + drivers.length + '*'
      );
    } catch(e) { console.error('[Timer/morning_admin]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // Каждое воскресенье 20:00 — недельный отчёт админу
  cron.schedule('0 20 * * 0', async () => {
    try {
      const adminPhone = await q.getSetting('admin_phone');
      if (!adminPhone) return;
      const stats = await q.getPeriodStats(7);
      const top = await q.getTopDrivers(7);
      const topLines = top.map((d,i) =>
        `${i+1}. ${d.full_name} — ${d.trips} поезд. | ${Number(d.earned).toLocaleString()} тг`
      ).join('\n');
      await wa.sendText(adminPhone,
        '📊 *Итоги недели:*\n\n' +
        '✅ Поездок: *' + stats.completed + '*\n' +
        '❌ Отменено: *' + stats.cancelled + '*\n' +
        '💰 Оборот: *' + Number(stats.revenue).toLocaleString() + ' тг*\n' +
        '👥 Уникальных клиентов: *' + stats.unique_clients + '*\n\n' +
        '🏆 *Топ водителей:*\n' + (topLines || 'Нет данных')
      );
    } catch(e) { console.error('[Timer/weekly_admin]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // 1-е число каждого месяца 09:00 — месячный отчёт
  cron.schedule('0 9 1 * *', async () => {
    try {
      const adminPhone = await q.getSetting('admin_phone');
      if (!adminPhone) return;
      const stats = await q.getPeriodStats(30);
      const usersCount = await db.query(
        `SELECT COUNT(*) AS cnt FROM users WHERE role='client'`
      ).then(r => r.rows[0]?.cnt).catch(() => 0);
      await wa.sendText(adminPhone,
        '📅 *Итоги месяца:*\n\n' +
        '✅ Поездок: *' + stats.completed + '*\n' +
        '❌ Отменено: *' + stats.cancelled + '*\n' +
        '💰 Оборот: *' + Number(stats.revenue).toLocaleString() + ' тг*\n' +
        '👥 Активных клиентов: *' + stats.unique_clients + '*\n' +
        '👤 Всего клиентов в базе: *' + usersCount + '*\n\n' +
        '🚖 Средний доход/день: *' + Number(Math.round(stats.revenue/30)).toLocaleString() + ' тг*'
      );
    } catch(e) { console.error('[Timer/monthly_admin]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  // Каждый день в 04:00 — обновление базы адресов через 2GIS (1 категория в день)
  cron.schedule('0 4 * * *', async () => {
    try {
      const script = path.join(__dirname, '../../import_2gis_daily.js');
      if (!fs.existsSync(script)) return;
      execFile('node', [script], { timeout: 120000 }, (err, stdout) => {
        if (err) console.error('[Timer/2gis_daily]', err.message);
        else console.log('[Timer/2gis_daily]', stdout.slice(0, 200));
      });
    } catch(e) { console.error('[Timer/2gis_daily]', e.message); }
  }, { timezone: 'Asia/Almaty' });

  console.log('Timer service started');
};

module.exports = { start };
