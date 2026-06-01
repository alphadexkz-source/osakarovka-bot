const cron = require('node-cron');
const q = require('../db/queries');
const notify = require('./notificationService');
const wa = require('../whatsapp/greenApi');

const start = () => {

  // Каждые 5 мин — проверяем зависшие заказы (не принятые > 60 сек)
  // Это делается в orderEngine при создании заказа через setTimeout
  // Здесь только чистка старых зависших заказов
  cron.schedule('*/5 * * * *', async () => {
    try {
      const db = require('../db/index');
      // Заказы в статусе searching больше 10 минут — отменяем
      const stuck = await db.query(
        `SELECT o.id, u.phone AS client_phone
         FROM orders o
         JOIN users u ON o.client_id = u.id
         WHERE o.status = 'searching'
         AND o.created_at < NOW() - INTERVAL '10 minutes'`
      ).then(r => r.rows).catch(() => []);
      for (const order of stuck) {
        await db.query(`UPDATE orders SET status='cancelled', cancel_reason='Нет водителей' WHERE id=$1`, [order.id]);
        await wa.sendText(order.client_phone, '😔 *К сожалению, свободных водителей не нашлось.*\n\nПопробуйте заказать через несколько минут. 🚖');
      }
    } catch(e) { console.error('[Timer/stuck_orders]', e.message); }
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
      const db = require('../db/index');
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
      const db = require('../db/index');
      const ordersR = await db.query(`SELECT COUNT(*) AS cnt FROM orders WHERE created_at > NOW() - INTERVAL '1 hour'`);
      const ordersCount = parseInt(ordersR.rows[0]?.cnt || 0);
      if (ordersCount >= 2) {
        const r = await db.query(`
          SELECT u.phone, d.full_name FROM drivers d
          JOIN users u ON d.user_id = u.id
          WHERE d.status = 'offline' AND d.order_balance > 0
        `);
        for (const d of r.rows) {
          await wa.sendText(d.phone, '🔥 *' + d.full_name + ', вечерний час пик!*\n\n📊 За последний час: *' + ordersCount + '* заказов.\n🚖 Выходите на линию — напишите *"на линию"*!');
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch(e) { console.error('[Timer/evening_rush]', e.message); }
  });

  // 12:00 — кто офлайн 3+ дней
  cron.schedule('0 12 * * *', async () => {
    try {
      const db = require('../db/index');
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
        await wa.sendText(d.phone, '👋 *' + d.full_name + '*, вас не было *' + days + ' дней!*\n\n🚖 Клиенты скучают — ждём вас!\nКогда будете готовы — напишите *"на линию"*. 😊');
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error('[Timer/longoffline]', e.message); }
  });

  // 22:00 — ежедневный итог водителям
  cron.schedule('0 22 * * *', async () => {
    try {
      const db = require('../db/index');
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
      const topLines = top.map((d,i) => `${i+1}. ${d.full_name} — ${d.trips} поезд. | ${Number(d.earned).toLocaleString()} тг`).join('\n');
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
      const db = require('../db/index');
      const usersCount = await db.query(`SELECT COUNT(*) AS cnt FROM users WHERE role='client'`).then(r => r.rows[0]?.cnt).catch(() => 0);
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
      const { execFile } = require('child_process');
      const path = require('path');
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
