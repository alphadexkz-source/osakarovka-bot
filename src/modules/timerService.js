const cron = require('node-cron');
const q = require('../db/queries');
const notify = require('./notificationService');
const wa = require('../whatsapp/greenApi');

const start = () => {

  // ── Каждые 5 мин — авто-офлайн неактивных водителей ────────
  cron.schedule('*/5 * * * *', async () => {
    try {
      const inactive = await q.getInactiveDrivers(30);
      for (const d of inactive) {
        await q.setDriverStatus(d.phone, 'offline');
        await notify.driverInactiveOffline(d.phone);
      }
    } catch(e) { console.error('[Timer/inactivity]', e.message); }
  });

  // ── Каждый час — уведомление водителям кто давно ждёт ──────
  cron.schedule('0 * * * *', async () => {
    try {
      const waiting = await q.getLongWaitDrivers(60);
      for (const d of waiting) {
        await notify.driverLongWait(d.phone);
      }
    } catch(e) { console.error('[Timer/longwait]', e.message); }
  });

  // ── Утро 9:00 — напоминание офлайн водителям ────────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      const db = require('../db/index');
      // Водители которые офлайн но активны (последняя активность < 48 часов)
      const r = await db.query(`
        SELECT u.phone, d.full_name, d.order_balance
        FROM drivers d
        JOIN users u ON d.user_id = u.id
        WHERE d.status = 'offline'
        AND d.last_activity > NOW() - INTERVAL '48 hours'
        AND d.order_balance > 0
      `);
      for (const d of r.rows) {
        const bal = d.order_balance >= 999999 ? '' : ` (баланс: ${d.order_balance})`;
        await wa.sendText(d.phone,
          `☀️ *Доброе утро, ${d.full_name}!*\n\n` +
          `🚖 Клиенты уже ждут — выходите на линию!${bal}\n\n` +
          `Напишите *"на линию"* чтобы начать работу 💪`
        );
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error('[Timer/morning_drivers]', e.message); }
  });

  // ── Вечер 17:00 — час пик, зовём офлайн водителей ──────────
  cron.schedule('0 17 * * *', async () => {
    try {
      const db = require('../db/index');
      // Смотрим сколько заказов за последний час
      const ordersR = await db.query(`
        SELECT COUNT(*) AS cnt FROM orders
        WHERE created_at > NOW() - INTERVAL '1 hour'
      `);
      const ordersCount = parseInt(ordersR.rows[0]?.cnt || 0);

      // Если есть активность — зовём водителей
      if (ordersCount >= 2) {
        const r = await db.query(`
          SELECT u.phone, d.full_name, d.order_balance
          FROM drivers d
          JOIN users u ON d.user_id = u.id
          WHERE d.status = 'offline'
          AND d.order_balance > 0
        `);
        for (const d of r.rows) {
          await wa.sendText(d.phone,
            `🌆 *${d.full_name}, вечерний час пик!*\n\n` +
            `📈 За последний час: *${ordersCount} заказов*\n` +
            `🚖 Клиенты ждут — выходите на линию!\n\n` +
            `Напишите *"на линию"* 👇`
          );
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch(e) { console.error('[Timer/evening_rush]', e.message); }
  });

  // ── Каждый день в 12:00 — проверка долго офлайн ─────────────
  cron.schedule('0 12 * * *', async () => {
    try {
      const db = require('../db/index');
      // Водители офлайн больше 3 дней
      const r = await db.query(`
        SELECT u.phone, d.full_name, d.last_activity
        FROM drivers d
        JOIN users u ON d.user_id = u.id
        WHERE d.status = 'offline'
        AND d.last_activity < NOW() - INTERVAL '3 days'
        AND d.last_activity > NOW() - INTERVAL '30 days'
        AND d.order_balance > 0
      `);
      for (const d of r.rows) {
        const days = Math.floor((Date.now() - new Date(d.last_activity)) / 86400000);
        await wa.sendText(d.phone,
          `👋 *${d.full_name}, вас не было ${days} дней!*\n\n` +
          `Всё хорошо? Клиенты скучают 😊\n\n` +
          `Когда будете готовы — напишите *"на линию"* 🚖`
        );
        await new Promise(r => setTimeout(r, 500));
      }
    } catch(e) { console.error('[Timer/longoffline]', e.message); }
  });

  // ── Каждый день в 08:00 — утренняя сводка админу ────────────
  cron.schedule('0 8 * * *', async () => {
    try {
      const adminPhone = await q.getSetting('admin_phone');
      if (!adminPhone) return;
      const stats   = await q.getPeriodStats(1);
      const drivers = await q.getAllDrivers();
      const online  = drivers.filter(d => ['online','busy'].includes(d.status)).length;
      await wa.sendText(adminPhone,
        `☀️ *Доброе утро! Итоги вчера:*\n\n` +
        `🚖 Поездок: *${stats.completed}*\n` +
        `❌ Отменено: *${stats.cancelled}*\n` +
        `💰 Оборот: *${Number(stats.revenue).toLocaleString()} тг*\n` +
        `👥 Уникальных клиентов: *${stats.unique_clients}*\n\n` +
        `👷 Водителей на линии сейчас: *${online}/${drivers.length}*`
      );
    } catch(e) { console.error('[Timer/morning_admin]', e.message); }
  });

  console.log('✅ Timer service started');
};

module.exports = { start };
