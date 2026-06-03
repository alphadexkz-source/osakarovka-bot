const cron = require('node-cron');
const { execFile } = require('child_process');
const path = require('path');
const db = require('../db/index');
const q = require('../db/queries');
const notify = require('./notificationService');
const wa = require('../whatsapp/greenApi');
const config = require('../config');
// orderEngine импортируется здесь безопасно: timerService → orderEngine → нет timerService
const orderEngine = require('./orderEngine');
const driverMgr = require('./driverManager');

// ─── Вспомогательные функции каждые 5 мин ────────────────────

const checkStuckOrders = async () => {
  const stuck = await db.query(
    `SELECT o.id, u.phone AS client_phone
     FROM orders o
     JOIN users u ON o.client_id = u.id
     WHERE o.status = 'searching'
       AND o.created_at < NOW() - INTERVAL '10 minutes'`
  ).then(r => r.rows).catch(() => []);
  for (const order of stuck) {
    await db.query(
      `UPDATE orders SET status='cancelled', cancel_reason='Нет водителей' WHERE id=$1`,
      [order.id]
    );
    await db.query(`UPDATE sessions SET state='idle', ctx='{}' WHERE phone=$1`, [order.client_phone]);
    await wa.sendText(order.client_phone,
      '😔 *К сожалению, свободных водителей не нашлось.*\n\nПопробуйте заказать через несколько минут. 🚖'
    );
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
        console.log(`[TimerService] Таймаут диспетчеризации: заказ #${order.id}, водитель ${driverPhone}`);
        await orderEngine.cancel(order.id, 'no_response').catch(() => {})
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

  // Каждую минуту — проверка зависших диспетчеризаций + истёкших перерывов
  cron.schedule('*/1 * * * *', async () => {
    try { await checkDispatchTimeouts() } catch (e) { console.error('[Timer/dispatch_timeout]', e.message) }
    try { await checkBreakTimers() } catch (e) { console.error('[Timer/break_timers]', e.message) }
  })

  // Каждые 2 минуты — предупреждения о долгом ожидании прибытия
  cron.schedule('*/2 * * * *', async () => {
    try { await checkArriveWarnings(); } catch (e) { console.error('[Timer/arrive_warnings]', e.message); }
  })

  // Каждые 5 мин — четыре задачи в одном расписании
  cron.schedule('*/5 * * * *', async () => {
    try { await checkStuckOrders(); }    catch(e) { console.error('[Timer/stuck_orders]', e.message); }
    try { await checkInactiveDrivers(); } catch(e) { console.error('[Timer/auto_offline]', e.message); }
    try { await warnInactiveDrivers(); }  catch(e) { console.error('[Timer/inactivity_warn]', e.message); }
    try { await q.cleanupMessageDedup(); } catch(e) {}
  });

  // Каждый час — уведомление водителям кто давно ждёт без заказов
  cron.schedule('0 * * * *', async () => {
    try {
      const waiting = await q.getLongWaitDrivers(60).catch(() => []);
      for (const d of waiting) {
        await notify.driverLongWait(d.phone);
      }
    } catch(e) { console.error('[Timer/longwait]', e.message); }
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

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
  });

  // Каждый день в 04:00 — обновление базы адресов через 2GIS (1 категория в день)
  cron.schedule('0 4 * * *', async () => {
    try {
      const script = path.join(__dirname, '../../import_2gis_daily.js');
      execFile('node', [script], { timeout: 120000 }, (err, stdout) => {
        if (err) console.error('[Timer/2gis_daily]', err.message);
        else console.log('[Timer/2gis_daily]', stdout.slice(0, 200));
      });
    } catch(e) { console.error('[Timer/2gis_daily]', e.message); }
  });

  console.log('Timer service started');
};

module.exports = { start };
