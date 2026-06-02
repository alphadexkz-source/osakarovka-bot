require('dotenv').config();
const express = require('express');

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack || err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason?.stack || reason);
});
const { route }  = require('./handlers/router');
const { start: startTimers } = require('./modules/timerService');
const config  = require('./config');
const db      = require('./db/index');
const wa      = require('./whatsapp/greenApi');

const app = express();
app.use(express.json({ limit: '5mb' }));

// ─── FIX: Rate limiting (простой, в памяти) ───────────────────
const requestCounts = new Map(); // phone → { count, resetAt }
const RATE_LIMIT    = 30;        // максимум сообщений
const RATE_WINDOW   = 60_000;    // за 60 секунд

const isRateLimited = (phone) => {
  const now = Date.now();
  const rec = requestCounts.get(phone);
  if (!rec || now > rec.resetAt) {
    requestCounts.set(phone, { count: 1, resetAt: now + RATE_WINDOW });
    return false;
  }
  rec.count++;
  if (rec.count > RATE_LIMIT) return true;
  return false;
};

// Очищаем счётчики каждые 5 минут
setInterval(() => {
  const now = Date.now();
  for (const [phone, rec] of requestCounts) {
    if (now > rec.resetAt) requestCounts.delete(phone);
  }
}, 300_000);

// ─── Webhook ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // всегда отвечаем быстро

  try {
    const body = req.body;
    if (!body || body.typeWebhook !== 'incomingMessageReceived') return;

    // Извлечь телефон для rate limiting
    const phone = body.senderData?.sender?.replace('@c.us', '');
    if (!phone) return;

    // FIX: Игнорируем групповые чаты
    if (body.senderData?.sender?.includes('@g.us')) return;
    if (phone.includes('@g.us') || phone.includes('-')) return;

    // FIX: Rate limiting
    if (isRateLimited(phone)) {
      console.warn(`[RateLimit] ${phone} превысил лимит`);
      return;
    }

    await route(body);
  } catch (err) {
    console.error('[Webhook]', err.message);
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get('/', async (req, res) => {
  try {
    const stats = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE role='client') AS clients,
         (SELECT COUNT(*) FROM users WHERE role='driver') AS drivers,
         (SELECT COUNT(*) FROM drivers WHERE status='online') AS online,
         (SELECT COUNT(*) FROM drivers WHERE status='busy') AS busy,
         (SELECT COUNT(*) FROM orders WHERE created_at::date=CURRENT_DATE AND status='completed') AS today_done,
         (SELECT COUNT(*) FROM orders WHERE created_at::date=CURRENT_DATE) AS today_total`
    );
    res.json({ service: 'еОсакаровка Сервис', status: 'running', time: new Date().toISOString(), stats: stats.rows[0] });
  } catch {
    res.json({ service: 'еОсакаровка Сервис', status: 'running' });
  }
});

// ─── Восстановление после рестарта ────────────────────────────
async function recoverOnStartup() {
  try {
    const stale = await db.query(
      `SELECT o.id, o.status, u.phone AS client_phone, du.phone AS driver_phone
       FROM orders o
       JOIN users u ON o.client_id = u.id
       LEFT JOIN drivers d ON o.driver_id = d.id
       LEFT JOIN users du ON d.user_id = du.id
       WHERE o.status IN ('searching','accepted','arrived')
         AND o.created_at < NOW() - INTERVAL '15 minutes'`
    );
    if (!stale.rows.length) { console.log('✅ Зависших заказов нет'); return; }
    console.log(`⚠️  Найдено ${stale.rows.length} зависших заказов — отменяю...`);
    for (const o of stale.rows) {
      await db.query(
        `UPDATE orders SET status='cancelled', cancel_reason='restart', cancelled_at=NOW() WHERE id=$1`, [o.id]
      );
      if (o.client_phone) {
        await wa.sendText(o.client_phone,
          `⚠️ Ваш заказ был отменён из-за перезапуска системы.\nСделайте новый заказ. 🚖`
        ).catch(() => {});
        await db.query(`UPDATE sessions SET state='idle', ctx='{}' WHERE phone=$1`, [o.client_phone]);
      }
      if (o.driver_phone) {
        await db.query(
          `UPDATE drivers SET status='online' WHERE user_id=(SELECT id FROM users WHERE phone=$1)`, [o.driver_phone]
        );
        await wa.sendText(o.driver_phone, `ℹ️ Система перезапущена. Активный заказ отменён. Вы снова в очереди.`).catch(() => {});
        await db.query(`UPDATE sessions SET state='idle', ctx='{}' WHERE phone=$1`, [o.driver_phone]);
      }
    }
    console.log('✅ Зависшие заказы отменены');
  } catch (err) {
    console.error('[Startup recovery]', err.message);
  }
}

app.listen(config.PORT, async () => {
  console.log(`\n🚖 еОсакаровка Сервис Bot`);
  console.log(`🟢 Порт: ${config.PORT}`);
  console.log(`🛡️  Rate limit: ${RATE_LIMIT} сообщений / 60 сек`);
  await recoverOnStartup();
  startTimers();
});
