require('dotenv').config();
const log = require('./logger');
log.initFileLogging(); // ПЕРВЫМ — патчит console.error/warn → logs/errors.log
const express = require('express');

const BOT_VERSION = '2.0.0'; // Stage 1+2+3+4 рефакторинг

process.on('uncaughtException', (err) => {
  log.error('uncaughtException', err);
  // Даём время записать лог перед выходом
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});
const { route }  = require('./handlers/router');
const { start: startTimers } = require('./modules/timerService');
const tgNotify = require('./modules/telegramNotify');
const config  = require('./config');
const db      = require('./db/index');
const wa      = require('./whatsapp/greenApi');
const { getRecentMessageIds, getSetting, setSetting } = require('./db/queries');

const app = express();
app.use(express.json({ limit: '100kb' }));

// ─── Rate limiting (в памяти, сбрасывается при рестарте) ──────
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
  if (rec.count >= RATE_LIMIT) return true; // уже заблокирован, не инкрементируем
  rec.count++;
  return rec.count >= RATE_LIMIT;
};

// Дедупликация сообщений — Green API иногда дублирует вебхуки
const processedMsgs = new Set();

const isDuplicate = (msgId) => {
  if (!msgId) return false;
  if (processedMsgs.has(msgId)) return true;
  processedMsgs.add(msgId);
  setTimeout(() => processedMsgs.delete(msgId), 60_000);
  // Async запись в БД для восстановления после рестарта (fire-and-forget)
  db.query('INSERT INTO message_dedup(msg_id) VALUES($1) ON CONFLICT DO NOTHING', [msgId])
    .catch(() => {});
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
  res.sendStatus(200); // отвечаем немедленно — Green API не ждёт

  try {
    const body = req.body;
    if (!body || typeof body !== 'object') return;

    // Проверяем secret token
    if (req.query.token !== config.WEBHOOK_SECRET) {
      console.warn('[Webhook] Отклонён — неверный token');
      return;
    }

    // Проверяем что вебхук от нашего инстанса Green API
    if (config.INSTANCE_ID &&
        body.instanceData?.idInstance &&
        String(body.instanceData.idInstance) !== String(config.INSTANCE_ID)) {
      console.warn('[Webhook] Отклонён — чужой инстанс:', body.instanceData.idInstance);
      return;
    }

    // Обрабатываем только входящие сообщения
    if (body.typeWebhook !== 'incomingMessageReceived') return;

    const sender = body.senderData?.sender;
    const phone  = sender?.replace('@c.us', '');
    if (!phone) return;

    // Игнорируем групповые чаты
    if (sender?.includes('@g.us') || phone.includes('-')) return;

    // Базовая валидация формата номера
    if (!/^\d{10,15}$/.test(phone)) return;

    // Дедупликация вебхуков (in-memory + DB)
    if (isDuplicate(body.idMessage)) return;

    // Rate limiting
    if (isRateLimited(phone)) {
      console.warn(`[RateLimit] ${phone} превысил лимит`);
      return;
    }

    await route(body);
  } catch (err) {
    log.error('webhook', err);
  }
});

// ─── Tender OAuth callback ────────────────────────────────────
app.get('/tender/callback', async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    const desc = error_description ? decodeURIComponent(error_description) : error;
    log.warn('tender_oauth_error', { error, error_description: desc });
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>❌ Ошибка авторизации</h2>
      <p style="color:#c00"><b>${error}</b></p>
      <p>${desc !== error ? desc : ''}</p>
      <p>Вернитесь в Telegram, нажмите 🏛 Тендеры → 🔑 Авторизоваться снова.</p></body></html>`);
  }
  if (!code) {
    return res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>❌ Код авторизации не получен</h2>
      <p>Попробуйте снова через Telegram.</p></body></html>`);
  }
  try {
    const tenders = require('../agent/tenders');
    await tenders.exchangeCode(code);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Авторизация успешна!</h2>
      <p>Вернитесь в Telegram и нажмите <b>🏛 Тендеры</b> снова.</p>
      <p style="color:gray">Вкладку можно закрыть.</p></body></html>`);
  } catch(e) {
    log.error('tender_exchange_error', e);
    res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>❌ Ошибка обмена кода</h2>
      <p style="color:#c00">${e.message}</p>
      <p>Вернитесь в Telegram и попробуйте снова.</p></body></html>`);
  }
});

// ─── Health check ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ service: 'еОсакаровка Сервис', status: 'running', time: new Date().toISOString() });
});

// Предзагрузка дедупликации из БД (восстановление после рестарта)
const preloadMessageDedup = async () => {
  try {
    const recentIds = await getRecentMessageIds(60);
    recentIds.forEach(id => {
      processedMsgs.add(id);
      setTimeout(() => processedMsgs.delete(id), 60_000);
    });
    if (recentIds.length) console.log(`[Dedup] Loaded ${recentIds.length} recent message IDs`);
  } catch (e) {
    console.error('[Dedup] Failed to preload message IDs:', e.message);
  }
};

// ─── Восстановление после рестарта ────────────────────────────
async function recoverOnStartup() {
  try {
    // 1. Отменяем только зависшие заказы в статусе 'searching' (> 15 мин без водителя)
    // accepted/arrived НЕ отменяем — там уже есть водитель, поездка продолжается
    const stale = await db.query(
      `SELECT o.id, o.status, u.phone AS client_phone, du.phone AS driver_phone
       FROM orders o
       JOIN users u ON o.client_id = u.id
       LEFT JOIN drivers d ON o.driver_id = d.id
       LEFT JOIN users du ON d.user_id = du.id
       WHERE o.status = 'searching'
         AND o.created_at < NOW() - INTERVAL '15 minutes'`
    );
    if (stale.rows.length) {
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
    } else {
      console.log('✅ Зависших заказов нет');
    }

    // 2. Сбрасываем зависшие сессии водителей (driver_as_client, cancel_reason и др.)
    await db.query(
      `UPDATE sessions SET state='idle', ctx='{}'
       WHERE state IN ('driver_as_client','cancel_reason')
         AND updated_at < NOW() - INTERVAL '30 minutes'`
    );

    // 3. Водители со статусом busy без активного заказа → online
    await db.query(
      `UPDATE drivers SET status='online'
       WHERE status='busy'
         AND id NOT IN (
           SELECT DISTINCT driver_id FROM orders
           WHERE status IN ('accepted','arrived') AND driver_id IS NOT NULL
         )`
    );

    // 4. Чистим pending_order_id у водителей, чей заказ уже не в searching
    //    (заказ отменён/принят другим — водитель иначе застрянет с кнопкой «принял»)
    const stalePending = await db.query(
      `UPDATE sessions
       SET ctx = ctx - 'pending_order_id'
       WHERE ctx ? 'pending_order_id'
         AND NOT EXISTS (
           SELECT 1 FROM orders
           WHERE id = (ctx->>'pending_order_id')::int
             AND status = 'searching'
         )
       RETURNING phone`
    );
    if (stalePending.rows.length) {
      console.log(`✅ Очищено stale pending_order_id у ${stalePending.rows.length} водителей`);
    }

    // 5. Предзагрузка дедупликации сообщений из БД
    await preloadMessageDedup();

  } catch (err) {
    console.error('[Startup recovery]', err.message);
  }
}

// ─── Глобальный обработчик ошибок Express ────────────────────
// Должен быть последним middleware (4 параметра обязательны)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('express_error', err, { method: req.method, path: req.path });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal Server Error' });
});

const server = app.listen(config.PORT, async () => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚖  еОсакаровка Сервис Bot  v${BOT_VERSION}`);
  console.log(`${'='.repeat(50)}`);
  console.log(`🟢  Порт:             ${config.PORT}`);
  console.log(`📡  Green API:        ${config.INSTANCE_ID || 'не задан!'}`);
  console.log(`⏱   Таймаут заказа:  ${config.ACCEPT_TIMEOUT_MS / 1000} сек`);
  console.log(`🎯  Пауза водителей: ${config.PAUSE_MS / 1000} сек`);
  console.log(`🛡️   Rate limit:      ${RATE_LIMIT} сообщ/мин`);
  console.log(`${'='.repeat(50)}\n`);

  await recoverOnStartup();
  startTimers();
  setTimeout(() => tgNotify.onBotStarted(), 3000);

  // Уведомление админу о рестарте (cooldown 10 мин — защита от crash-loop спама)
  getSetting('admin_phone').then(async (adminPhone) => {
    if (!adminPhone) return;
    const lastNotif = await getSetting('last_restart_notif').catch(() => null);
    if (lastNotif && Date.now() - new Date(lastNotif).getTime() < 10 * 60 * 1000) return;
    await setSetting('last_restart_notif', new Date().toISOString());
    const t = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
    await wa.sendText(adminPhone,
      `🔄 *Бот перезапущен*\n\n⏰ ${t}\n📌 v${BOT_VERSION}\n\n✅ Работает нормально.`
    ).catch(() => {});
  }).catch(() => {});

  // Предупреждение если тарифов нет
  db.query('SELECT COUNT(*) AS cnt FROM tariffs WHERE is_active=TRUE').then(r => {
    const cnt = parseInt(r.rows[0]?.cnt || 0);
    if (cnt === 0) {
      console.warn('⚠️  ТАРИФЫ НЕ ДОБАВЛЕНЫ — все поездки будут по умолчанию ' + config.CITY_PRICE + ' тг!');
    } else {
      console.log(`✅ Тарифов в базе: ${cnt}`);
    }
  }).catch(() => {});

  // Показываем режим распределения
  db.query("SELECT value FROM settings WHERE key='distribution_mode'").then(r => {
    const mode = r.rows[0]?.value || 'queue';
    console.log(`📋 Режим распределения: ${mode === 'queue' ? 'Очередь' : 'Первый принял'}`);
  }).catch(() => {});
});

// ─── Graceful shutdown ────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`\n[${signal}] Завершение работы...`);
  server.close(async () => {
    console.log('HTTP сервер остановлен');
    await db.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
