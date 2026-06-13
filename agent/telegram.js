'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot = require('node-telegram-bot-api')
const { monitorBot, analyze, freeChat } = require('./hermes')
const tenders = require('./tenders')
const tools  = require('./tools')
const memory = require('./memory')
const q      = require('../src/db/queries')
const notify = require('../src/modules/notificationService')

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) { console.error('TELEGRAM_BOT_TOKEN не задан'); process.exit(1) }

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID ? Number(process.env.TELEGRAM_ADMIN_ID) : null
const bot  = new TelegramBot(token, { polling: true })
const conv = new Map() // chatId → { step, data, ... }

const isAdmin = (id) => !ADMIN_ID || id === ADMIN_ID

// ── helpers ────────────────────────────────────────────────────
const send = (cid, text, extra = {}) =>
  bot.sendMessage(cid, text, { parse_mode: 'Markdown', ...extra })
    .catch(() => bot.sendMessage(cid, text.replace(/[*_`[\]]/g, ''), extra))

const edit = (cid, mid, text, extra = {}) =>
  bot.editMessageText(text, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', ...extra })
    .catch(() => {})

const db = (sql, params = []) => tools.queryDB(sql, params)

// ── keyboards ──────────────────────────────────────────────────
const MAIN = { reply_markup: { inline_keyboard: [
  [{ text: '📊 Статистика',      callback_data: 'stats_today'        },
   { text: '🚖 Заказы',          callback_data: 'menu_orders'        }],
  [{ text: '👥 Водители',        callback_data: 'menu_drivers'       },
   { text: '📋 Тарифы',          callback_data: 'menu_tariffs'       }],
  [{ text: '🔍 Клиент',          callback_data: 'client_start'       },
   { text: '💰 Финансы',         callback_data: 'menu_finance'       }],
  [{ text: '📢 Рассылка',        callback_data: 'menu_broadcast'     },
   { text: '🚫 Ч/список + Долги',callback_data: 'blacklist'          }],
  [{ text: '💸 Должники',        callback_data: 'debtors'            },
   { text: '📊 Пик. часы',       callback_data: 'peak_hours'         }],
  [{ text: '🚖 Ручной заказ',    callback_data: 'manual_order_start' },
   { text: '⚙️ Настройки',       callback_data: 'menu_settings'      }],
  [{ text: '⚡ Быстро',          callback_data: 'menu_quick'         },
   { text: '🤖 Монит./Деплой',   callback_data: 'menu_monitor'       }],
  [{ text: '📝 Задачи',          callback_data: 'menu_tasks'         },
   { text: '💬 Спросить агента', callback_data: 'ask_start'          }],
  [{ text: '🧠 ИИ Ассистент',   callback_data: 'free_chat_start'    },
   { text: '🏛 Тендеры',        callback_data: 'tender_menu'        }],
]}}

const BACK  = { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'main' }]] }}
const CONFIRM = (yes, no) => ({ reply_markup: { inline_keyboard: [
  [{ text: '✅ Да', callback_data: yes }, { text: '❌ Отмена', callback_data: no }]
]}})

const KB = (...rows) => ({ reply_markup: { inline_keyboard: rows } })

// ── formatters ─────────────────────────────────────────────────
const fmtTariffs = (list) => list.map((t, i) =>
  `*${i+1}.* ${t.name} — ${t.day_price} тг${t.night_price ? ` / ночь ${t.night_price} тг` : ''}\n   🔑 ${(t.keywords||[]).slice(0,5).join(', ')}`
).join('\n\n')

const fmtDrivers = (list) => list.slice(0, 20).map(d =>
  `${d.status==='online'?'🟢':d.status==='busy'?'🟡':'⚫'} *${d.full_name}* ⭐${Number(d.rating||5).toFixed(1)} | ${d.order_balance} | ${d.phone}`
).join('\n')

const STATUS_ICON = { searching:'🟡', accepted:'🟢', arrived:'🚗', in_trip:'🛣', completed:'✅', cancelled:'❌', scheduled:'🕐' }
const fmtOrder = (o) =>
  `${STATUS_ICON[o.status]||'⬜'} *#${o.id}* ${o.destination} — ${o.price} тг\n` +
  `👤 ${o.client_name||o.client_phone||'?'} ${o.driver_name ? `| 🚗 ${o.driver_name}` : ''}\n` +
  `🕐 ${new Date(o.created_at).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}`

// ── /start ─────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg.from.id)) return
  conv.delete(msg.chat.id)
  send(msg.chat.id, `👨‍💼 *Панель администратора еОсакаровка*\n\n_chat\\_id: ${msg.chat.id}_`, MAIN)
})

bot.onText(/\/cancel/, (msg) => {
  if (!isAdmin(msg.from.id)) return
  conv.delete(msg.chat.id)
  send(msg.chat.id, '↩️ Отменено.', MAIN)
})

// ── callback_query ─────────────────────────────────────────────
bot.on('callback_query', async (cb) => {
  if (!isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id)
  const cid  = cb.message.chat.id
  const mid  = cb.message.message_id
  const data = cb.data
  bot.answerCallbackQuery(cb.id)

  const KEEP_STATE = ['broadcast_confirm_yes','broadcast_confirm_no','restart_confirm','tariff_del_confirm_yes','order_cancel_confirm']
  if (!KEEP_STATE.includes(data)) conv.delete(cid)

  try {
    // ── главное меню ───────────────────────────────────────
    if (data === 'main') { edit(cid, mid, '👨‍💼 *Панель администратора*', MAIN); return }

    // ── СТАТИСТИКА ─────────────────────────────────────────
    if (data === 'stats_today') {
      const [s, d] = await Promise.all([q.getTodayStats(), q.getAllDrivers()])
      const on = d.filter(x => ['online','busy'].includes(x.status)).length
      const convRate = s.total > 0 ? Math.round(s.completed / s.total * 100) : 0
      edit(cid, mid,
        `📊 *Статистика сегодня:*\n\n` +
        `🚖 Выполнено: *${s.completed}* | Отменено: *${s.cancelled}*\n` +
        `📦 Всего: *${s.total}* | Конверсия: *${convRate}%*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💵 Комиссия (10%): *${Number(s.commission||0).toLocaleString()} тг*\n\n` +
        `👥 Онлайн: *${on}/${d.length}*`,
        KB(
          [{ text: '📅 Неделя', callback_data: 'stats_week' }, { text: '🗓 Месяц', callback_data: 'stats_month' }],
          [{ text: '🏆 Топ водителей', callback_data: 'stats_top' }, { text: '📈 Аналитика', callback_data: 'stats_analytics' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'stats_week') {
      const s = await q.getPeriodStats(7)
      edit(cid, mid,
        `📅 *За 7 дней:*\n\n🚖 Выполнено: *${s.completed}* | Отменено: *${s.cancelled}*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💵 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n👤 Уникальных клиентов: *${s.unique_clients}*`,
        KB([{ text: '◀️ Статистика', callback_data: 'stats_today' }])
      ); return
    }
    if (data === 'stats_month') {
      const s = await q.getPeriodStats(30)
      edit(cid, mid,
        `🗓 *За 30 дней:*\n\n🚖 Выполнено: *${s.completed}* | Отменено: *${s.cancelled}*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💵 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n👤 Уникальных клиентов: *${s.unique_clients}*`,
        KB([{ text: '◀️ Статистика', callback_data: 'stats_today' }])
      ); return
    }
    if (data === 'stats_top') {
      const top = await q.getTopDrivers(7)
      const lines = top.map((d,i) => `*${i+1}.* ${d.full_name} — ${d.trips} поезд. ⭐${Number(d.avg_rating||5).toFixed(1)}`).join('\n')
      edit(cid, mid, `🏆 *Топ водителей (7 дней):*\n\n${lines||'Нет данных'}`, KB([{ text: '◀️ Статистика', callback_data: 'stats_today' }])); return
    }
    if (data === 'stats_analytics') {
      const r = await db(`
        SELECT
          COUNT(*) FILTER(WHERE status='completed') AS completed,
          COUNT(*) FILTER(WHERE status='cancelled') AS cancelled,
          ROUND(AVG(EXTRACT(EPOCH FROM (accepted_at - created_at))/60)::numeric, 1) AS avg_accept_min,
          COUNT(*) FILTER(WHERE is_intercity=true) AS intercity,
          COUNT(*) FILTER(WHERE is_free=true) AS free_trips
        FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'
      `)
      const s = r.rows?.[0] || {}
      edit(cid, mid,
        `📈 *Аналитика за 7 дней:*\n\n` +
        `✅ Выполнено: *${s.completed}* | ❌ Отменено: *${s.cancelled}*\n` +
        `⏱ Среднее время принятия: *${s.avg_accept_min||'?'} мин*\n` +
        `🚗 Межгород: *${s.intercity}* | 🎁 Бесплатных: *${s.free_trips}*`,
        KB([{ text: '◀️ Статистика', callback_data: 'stats_today' }])
      ); return
    }

    // ── ЗАКАЗЫ ─────────────────────────────────────────────
    if (data === 'menu_orders') {
      edit(cid, mid, '🚖 *Заказы*',
        KB(
          [{ text: '🔴 Активные', callback_data: 'orders_active' }, { text: '📜 История', callback_data: 'orders_history' }],
          [{ text: '🔍 Найти #ID', callback_data: 'order_find_start' }, { text: '❌ Отменить #ID', callback_data: 'order_cancel_start' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'orders_active') {
      const orders = await q.getActiveOrders()
      if (!orders.length) { edit(cid, mid, '✅ *Активных заказов нет*', KB([{ text: '◀️ Назад', callback_data: 'menu_orders' }])); return }
      const lines = orders.map(o => {
        const mins = Math.round((Date.now() - new Date(o.created_at)) / 60000)
        return `${STATUS_ICON[o.status]||'⬜'} *${o.destination}* — ${o.price} тг · ${o.client_name}${o.driver_name?' · '+o.driver_name:''} (${mins} мин)`
      }).join('\n')
      edit(cid, mid, `🚖 *Активные (${orders.length}):*\n\n${lines}`, KB([{ text: '🔄 Обновить', callback_data: 'orders_active' }, { text: '◀️ Назад', callback_data: 'menu_orders' }])); return
    }
    if (data === 'orders_history') {
      const r = await db(`
        SELECT o.id, o.destination, o.price, o.status, o.created_at,
          u.name AS client_name, d.full_name AS driver_name
        FROM orders o
        LEFT JOIN users u ON o.client_id=u.id
        LEFT JOIN drivers d ON o.driver_id=d.id
        ORDER BY o.created_at DESC LIMIT 15
      `)
      const rows = r.rows || []
      const lines = rows.map(o => fmtOrder(o)).join('\n\n')
      edit(cid, mid, `📜 *Последние заказы:*\n\n${lines||'Нет'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_orders' }])); return
    }
    if (data === 'order_find_start') {
      conv.set(cid, { step: 'order_find' })
      edit(cid, mid, '🔍 *Найти заказ*\n\nВведите ID заказа (#номер):\n\n/cancel', BACK); return
    }
    if (data === 'order_cancel_start') {
      conv.set(cid, { step: 'order_cancel' })
      edit(cid, mid, '❌ *Отменить заказ*\n\nВведите ID активного заказа:\n\n/cancel', BACK); return
    }
    if (data === 'order_cancel_confirm') {
      const st = conv.get(cid); conv.delete(cid)
      if (!st?.order_id) { edit(cid, mid, '❌ Ошибка', BACK); return }
      await db(`UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE id=$1 AND status NOT IN('completed','cancelled')`, [st.order_id])
      send(cid, `✅ Заказ *#${st.order_id}* отменён.`, KB([{ text: '◀️ Заказы', callback_data: 'menu_orders' }])); return
    }

    // ── ВОДИТЕЛИ ───────────────────────────────────────────
    if (data === 'menu_drivers') {
      edit(cid, mid, '👥 *Водители*',
        KB(
          [{ text: '📋 Список', callback_data: 'drivers_list' }, { text: '👤 Профиль', callback_data: 'driver_profile_start' }],
          [{ text: '💰 Баланс', callback_data: 'driver_balance_start' }, { text: '📜 История поездок', callback_data: 'driver_history_start' }],
          [{ text: '⏹ Offline (один)', callback_data: 'driver_forceoff_start' }, { text: '⏹ Offline (все)', callback_data: 'driver_alloff' }],
          [{ text: '🚫 Заблокировать', callback_data: 'driver_block_start' }, { text: '✅ Разблокировать', callback_data: 'driver_unblock_start' }],
          [{ text: '⭐ Сбросить рейтинг', callback_data: 'driver_rating_start' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'drivers_list') {
      const list = await q.getAllDrivers()
      const on = list.filter(d => ['online','busy'].includes(d.status)).length
      edit(cid, mid, `👥 *Водители (${on} онлайн из ${list.length}):*\n\n${fmtDrivers(list)||'Нет'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_drivers' }])); return
    }
    if (data === 'driver_profile_start') {
      conv.set(cid, { step: 'driver_profile' })
      edit(cid, mid, '👤 *Профиль водителя*\n\nВведите номер телефона:\n\n/cancel', BACK); return
    }
    if (data === 'driver_history_start') {
      conv.set(cid, { step: 'driver_history' })
      edit(cid, mid, '📜 *История поездок водителя*\n\nВведите номер телефона:\n\n/cancel', BACK); return
    }
    if (data === 'driver_forceoff_start') {
      conv.set(cid, { step: 'driver_forceoff' })
      edit(cid, mid, '⏹ *Перевести водителя offline*\n\nВведите номер телефона:\n\n/cancel', BACK); return
    }
    if (data === 'driver_alloff') {
      edit(cid, mid, '⚠️ *Перевести ВСЕХ водителей offline?*', CONFIRM('driver_alloff_yes', 'menu_drivers')); return
    }
    if (data === 'driver_alloff_yes') {
      conv.delete(cid)
      await db(`UPDATE drivers SET status='offline', queue_position=NULL WHERE status IN ('online','busy')`)
      send(cid, '✅ Все водители переведены offline.', KB([{ text: '◀️ Назад', callback_data: 'menu_drivers' }])); return
    }
    if (data === 'driver_balance_start') {
      conv.set(cid, { step: 'driver_balance' })
      edit(cid, mid, '💰 *Пополнение баланса*\n\nФормат: `+50 77001234567`\n\n/cancel', BACK); return
    }
    if (data === 'driver_block_start') {
      conv.set(cid, { step: 'driver_block' })
      edit(cid, mid, '🚫 *Блокировка водителя*\n\nВведите номер:\n\n/cancel', BACK); return
    }
    if (data === 'driver_unblock_start') {
      conv.set(cid, { step: 'driver_unblock' })
      edit(cid, mid, '✅ *Разблокировка водителя*\n\nВведите номер:\n\n/cancel', BACK); return
    }
    if (data === 'driver_rating_start') {
      conv.set(cid, { step: 'driver_rating' })
      edit(cid, mid, '⭐ *Сброс рейтинга*\n\nВведите номер водителя:\n\n/cancel', BACK); return
    }

    // ── ТАРИФЫ ─────────────────────────────────────────────
    if (data === 'menu_tariffs') {
      edit(cid, mid, '📋 *Тарифы*',
        KB(
          [{ text: '📋 Список', callback_data: 'tariffs_list' }],
          [{ text: '➕ Добавить', callback_data: 'tariff_add_start' }, { text: '✏️ Изменить', callback_data: 'tariff_edit_start' }, { text: '🗑 Удалить', callback_data: 'tariff_del_start' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'tariffs_list') {
      const list = await q.getTariffs()
      edit(cid, mid, `📋 *Тарифы (${list.length}):*\n\n${fmtTariffs(list)||'Нет тарифов'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_tariffs' }])); return
    }
    if (data === 'tariff_add_start') {
      conv.set(cid, { step: 'tariff_add_1', data: {} })
      edit(cid, mid, '➕ *Новый тариф — Шаг 1/4*\n\nВведите *название* направления:\n\n/cancel', BACK); return
    }
    if (data === 'tariff_edit_start') {
      const list = await q.getTariffs()
      if (!list.length) { edit(cid, mid, '❌ Тарифов нет', KB([{ text: '◀️ Назад', callback_data: 'menu_tariffs' }])); return }
      conv.set(cid, { step: 'tariff_edit_pick', tariffs: list })
      edit(cid, mid, `✏️ *Изменить тариф*\n\nВведите номер:\n\n${fmtTariffs(list)}\n\n/cancel`, BACK); return
    }
    if (data === 'tariff_del_start') {
      const list = await q.getTariffs()
      if (!list.length) { edit(cid, mid, '❌ Тарифов нет', KB([{ text: '◀️ Назад', callback_data: 'menu_tariffs' }])); return }
      conv.set(cid, { step: 'tariff_del_pick', tariffs: list })
      edit(cid, mid, `🗑 *Удалить тариф*\n\nВведите номер:\n\n${fmtTariffs(list)}\n\n/cancel`, BACK); return
    }
    if (data === 'tariff_del_confirm_yes') {
      const st = conv.get(cid); conv.delete(cid)
      if (!st?.tariff) return
      await q.deleteTariff(st.tariff.id)
      send(cid, `🗑 Тариф *${st.tariff.name}* удалён.`, KB([{ text: '◀️ Назад', callback_data: 'menu_tariffs' }])); return
    }

    // ── КЛИЕНТ ─────────────────────────────────────────────
    if (data === 'client_start') {
      conv.set(cid, { step: 'client_lookup' })
      edit(cid, mid, '🔍 *Найти клиента*\n\nВведите номер телефона:\n\n/cancel', BACK); return
    }

    // ── ФИНАНСЫ ────────────────────────────────────────────
    if (data === 'menu_finance') {
      edit(cid, mid, '💰 *Финансы*',
        KB(
          [{ text: '📊 Выручка сегодня', callback_data: 'finance_today' }],
          [{ text: '📅 Выручка 7 дней', callback_data: 'finance_week' }, { text: '🗓 30 дней', callback_data: 'finance_month' }],
          [{ text: '🏆 Топ клиентов', callback_data: 'finance_top_clients' }],
          [{ text: '📋 Биллинг водителей', callback_data: 'finance_billing' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'finance_today') {
      const r = await db(`
        SELECT
          COUNT(*) FILTER(WHERE status='completed') AS trips,
          COALESCE(SUM(price) FILTER(WHERE status='completed'), 0) AS revenue,
          COALESCE(SUM(price*0.1) FILTER(WHERE status='completed'), 0) AS commission,
          COUNT(*) FILTER(WHERE is_free=true AND status='completed') AS free_trips,
          COUNT(*) FILTER(WHERE is_intercity=true AND status='completed') AS intercity
        FROM orders WHERE created_at::date=CURRENT_DATE
      `)
      const s = r.rows?.[0] || {}
      edit(cid, mid,
        `💰 *Финансы сегодня:*\n\n` +
        `🚖 Поездок: *${s.trips}* (межгород: ${s.intercity}, бесплатных: ${s.free_trips})\n` +
        `💵 Выручка: *${Number(s.revenue).toLocaleString()} тг*\n` +
        `💼 Комиссия: *${Number(s.commission).toFixed(0)} тг*`,
        KB([{ text: '◀️ Назад', callback_data: 'menu_finance' }])
      ); return
    }
    if (data === 'finance_week') {
      const s = await q.getPeriodStats(7)
      edit(cid, mid,
        `📅 *Финансы за 7 дней:*\n\n💵 Выручка: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💼 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n🚖 Поездок: *${s.completed}*`,
        KB([{ text: '◀️ Назад', callback_data: 'menu_finance' }])
      ); return
    }
    if (data === 'finance_month') {
      const s = await q.getPeriodStats(30)
      edit(cid, mid,
        `🗓 *Финансы за 30 дней:*\n\n💵 Выручка: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💼 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n🚖 Поездок: *${s.completed}*`,
        KB([{ text: '◀️ Назад', callback_data: 'menu_finance' }])
      ); return
    }
    if (data === 'finance_top_clients') {
      const r = await db(`
        SELECT u.name, u.phone,
          COUNT(*) AS trips,
          COALESCE(SUM(o.price), 0) AS spent
        FROM orders o
        JOIN users u ON o.client_id=u.id
        WHERE o.status='completed' AND o.created_at >= NOW() - INTERVAL '30 days'
        GROUP BY u.id, u.name, u.phone
        ORDER BY spent DESC LIMIT 10
      `)
      const lines = (r.rows||[]).map((c,i) =>
        `*${i+1}.* ${c.name||'?'} (${c.phone}) — ${c.trips} поезд. | ${Number(c.spent).toLocaleString()} тг`
      ).join('\n')
      edit(cid, mid, `🏆 *Топ клиентов (30 дней):*\n\n${lines||'Нет данных'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_finance' }])); return
    }
    if (data === 'finance_billing') {
      const r = await db(`
        SELECT b.amount, b.balance_after, b.note, b.created_at, d.full_name
        FROM billing b
        JOIN drivers d ON b.driver_id=d.id
        ORDER BY b.created_at DESC LIMIT 15
      `)
      const lines = (r.rows||[]).map(b =>
        `💳 *${b.full_name}* +${b.amount} (итого: ${b.balance_after})\n   ${b.note||''} · ${new Date(b.created_at).toLocaleDateString('ru-RU')}`
      ).join('\n')
      edit(cid, mid, `📋 *Биллинг водителей:*\n\n${lines||'Нет записей'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_finance' }])); return
    }

    // ── РАССЫЛКА ───────────────────────────────────────────
    if (data === 'menu_broadcast') {
      edit(cid, mid, '📢 *Рассылка*',
        KB(
          [{ text: '👤 Клиентам', callback_data: 'broadcast_clients' }, { text: '🚗 Водителям', callback_data: 'broadcast_drivers' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'broadcast_clients') { conv.set(cid, { step: 'broadcast_text', target: 'client' }); edit(cid, mid, '📢 *Рассылка клиентам*\n\nВведите текст:\n\n/cancel', BACK); return }
    if (data === 'broadcast_drivers') { conv.set(cid, { step: 'broadcast_text', target: 'driver' }); edit(cid, mid, '📢 *Рассылка водителям*\n\nВведите текст:\n\n/cancel', BACK); return }
    if (data === 'broadcast_confirm_yes') {
      const st = conv.get(cid); conv.delete(cid)
      if (!st?.message || !st?.target) { edit(cid, mid, '❌ Ошибка', BACK); return }
      edit(cid, mid, '⏳ Отправляю...', BACK)
      const n = await notify.broadcast(st.target, st.message)
      send(cid, `✅ Отправлено *${n}* ${st.target==='client'?'клиентам':'водителям'}.`, MAIN); return
    }
    if (data === 'broadcast_confirm_no') { conv.delete(cid); edit(cid, mid, '❌ *Рассылка отменена*', MAIN); return }

    // ── ЧЁРНЫЙ СПИСОК ──────────────────────────────────────
    if (data === 'blacklist') {
      const blocked = await q.getBlockedUsers()
      const BL_KB = KB(
        [{ text: '🚫 Заблокировать', callback_data: 'block_start' }, { text: '✅ Разблокировать', callback_data: 'unblock_start' }],
        [{ text: '⏱ Врем. блок', callback_data: 'tempblock_start' }, { text: '💸 Снять долг', callback_data: 'debt_start' }],
        [{ text: '💸 Добавить долг', callback_data: 'adddebt_start' }],
        [{ text: '◀️ Меню', callback_data: 'main' }]
      )
      if (!blocked.length) { edit(cid, mid, '✅ *Чёрный список пуст*', BL_KB); return }
      const lines = blocked.map(u => {
        const until = u.blacklisted_until ? ` до ${new Date(u.blacklisted_until).toLocaleDateString('ru-RU')}` : ' (навсегда)'
        return `🚫 *${u.phone}* — ${u.name||'?'}${until}${u.debt_tg>0?` | долг ${u.debt_tg} тг`:''}`
      }).join('\n')
      edit(cid, mid, `🚫 *Чёрный список (${blocked.length}):*\n\n${lines}`, BL_KB); return
    }
    if (data === 'block_start')     { conv.set(cid, { step: 'block_user' });     send(cid, '🚫 Номер клиента для блокировки:\n\n/cancel', BACK); return }
    if (data === 'unblock_start')   { conv.set(cid, { step: 'unblock_user' });   send(cid, '✅ Номер для разблокировки:\n\n/cancel', BACK); return }
    if (data === 'tempblock_start') { conv.set(cid, { step: 'tempblock_user' }); send(cid, '⏱ *Временная блокировка*\n\nФормат: `77001234567 24h` или `77001234567 3d`\n\n/cancel', BACK); return }
    if (data === 'debt_start')      { conv.set(cid, { step: 'clear_debt' });     send(cid, '💸 Номер для снятия долга:\n\n/cancel', BACK); return }
    if (data === 'adddebt_start')   { conv.set(cid, { step: 'add_debt' });       send(cid, '💸 *Добавить долг*\n\nФормат: `77001234567 500 причина`\n\n/cancel', BACK); return }

    // ── НАСТРОЙКИ ──────────────────────────────────────────
    if (data === 'menu_settings') {
      const [mode, loyEn, loyEvery] = await Promise.all([
        q.getSetting('distribution_mode'), q.getSetting('loyalty_enabled'), q.getSetting('loyalty_every'),
      ])
      edit(cid, mid,
        `⚙️ *Настройки*\n\n` +
        `Режим: *${mode==='first'?'⚡ Кто первый':'📋 Очередь'}*\n` +
        `Лояльность: *${loyEn!=='false'?'🟢 Вкл':'🔴 Выкл'}* (каждая ${loyEvery||10}-я)\n`,
        KB(
          [{ text: '📋 Режим: Очередь', callback_data: 'mode_queue' }, { text: '⚡ Режим: Первый', callback_data: 'mode_first' }],
          [{ text: '🎁 Лояльность', callback_data: 'loyalty_info' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'mode_queue') { await q.setSetting('distribution_mode','queue'); edit(cid, mid, '✅ Режим: *Очередь*', KB([{ text: '◀️ Настройки', callback_data: 'menu_settings' }])); return }
    if (data === 'mode_first') { await q.setSetting('distribution_mode','first'); edit(cid, mid, '✅ Режим: *Кто первый принял*', KB([{ text: '◀️ Настройки', callback_data: 'menu_settings' }])); return }
    if (data === 'loyalty_info') {
      const [en, every] = await Promise.all([q.getSetting('loyalty_enabled'), q.getSetting('loyalty_every')])
      edit(cid, mid,
        `🎁 *Лояльность:* ${en!=='false'?'🟢 Включена':'🔴 Выключена'}\nКаждая *${every||10}-я* поездка бесплатна`,
        KB(
          [{ text: '🔛 Включить', callback_data: 'loyalty_on' }, { text: '🔴 Выключить', callback_data: 'loyalty_off' }],
          [{ text: '🔢 Изменить интервал', callback_data: 'loyalty_every_start' }],
          [{ text: '◀️ Настройки', callback_data: 'menu_settings' }]
        )
      ); return
    }
    if (data === 'loyalty_on')  { await q.setSetting('loyalty_enabled','true');  edit(cid, mid, '✅ Лояльность *включена*',  KB([{ text: '◀️ Настройки', callback_data: 'menu_settings' }])); return }
    if (data === 'loyalty_off') { await q.setSetting('loyalty_enabled','false'); edit(cid, mid, '🔴 Лояльность *выключена*', KB([{ text: '◀️ Настройки', callback_data: 'menu_settings' }])); return }
    if (data === 'loyalty_every_start') { conv.set(cid, { step: 'loyalty_every' }); send(cid, '🔢 Введите число 2–100:\n\n/cancel', BACK); return }

    // ── ДОЛЖНИКИ ───────────────────────────────────────────
    if (data === 'debtors') {
      const r = await db(`SELECT phone, name, debt_tg, debt_reason FROM users WHERE debt_tg>0 ORDER BY debt_tg DESC`)
      const rows = r.rows || []
      if (!rows.length) { edit(cid, mid, '✅ *Должников нет*', KB([{ text: '◀️ Меню', callback_data: 'main' }])); return }
      const total = rows.reduce((s, u) => s + Number(u.debt_tg), 0)
      const lines = rows.map(u => `💸 *${u.phone}* — ${u.debt_tg} тг${u.name?` (${u.name})`:''}${u.debt_reason?`\n   _${u.debt_reason}_`:''}`).join('\n')
      edit(cid, mid, `💸 *Должники (${rows.length}) — итого ${total} тг:*\n\n${lines}`, KB([{ text: '💸 Снять долг', callback_data: 'debt_start' }, { text: '◀️ Меню', callback_data: 'main' }])); return
    }

    // ── ПИКОВЫЕ ЧАСЫ ───────────────────────────────────────
    if (data === 'peak_hours') {
      const r = await db(`
        SELECT EXTRACT(HOUR FROM created_at + INTERVAL '5 hours') AS hour,
               COUNT(*) AS orders, COUNT(*) FILTER(WHERE status='completed') AS done
        FROM orders WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY 1 ORDER BY 1
      `)
      const rows = r.rows || []
      if (!rows.length) { edit(cid, mid, '❌ Нет данных за 7 дней', BACK); return }
      const maxOrders = Math.max(...rows.map(r => Number(r.orders)))
      const BAR = ['▁','▂','▃','▄','▅','▆','▇','█']
      const chart = rows.map(r => {
        const h = String(r.hour).padStart(2,'0')
        const bar = BAR[Math.round((Number(r.orders)/maxOrders)*7)]
        return `${h}:00 ${bar} ${r.orders} (✅${r.done})`
      }).join('\n')
      edit(cid, mid, `📊 *Пиковые часы (7 дней, Алмата UTC+5):*\n\n\`\`\`\n${chart}\n\`\`\``, KB([{ text: '◀️ Меню', callback_data: 'main' }])); return
    }

    // ── РУЧНОЙ ЗАКАЗ ───────────────────────────────────────
    if (data === 'manual_order_start') {
      conv.set(cid, { step: 'manual_order_phone' })
      edit(cid, mid, '🚖 *Ручной заказ*\n\nВведите телефон клиента:\n\n/cancel', BACK); return
    }

    // ── БЫСТРЫЕ ДЕЙСТВИЯ ───────────────────────────────────
    if (data === 'menu_quick') {
      edit(cid, mid, '⚡ *Быстрые действия*',
        KB(
          [{ text: '⏹ Все водители offline', callback_data: 'driver_alloff' }],
          [{ text: '🧹 Очистить зависшие заказы', callback_data: 'quick_cleanup' }],
          [{ text: '📊 Тест-отчёт', callback_data: 'quick_testreport' }],
          [{ text: '🔄 Перезапуск бота', callback_data: 'monitor_restart' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'quick_cleanup') {
      const r = await db(`UPDATE orders SET status='cancelled', cancelled_at=NOW() WHERE status='searching' AND created_at < NOW() - INTERVAL '15 minutes' RETURNING id`)
      const n = r.rows?.length || 0
      edit(cid, mid, `🧹 Очищено *${n}* зависших заказов.`, KB([{ text: '◀️ Назад', callback_data: 'menu_quick' }])); return
    }
    if (data === 'quick_testreport') {
      const { getTestReport } = require('../src/modules/testLogger')
      const report = getTestReport()
      send(cid, `📊 *Отчёт тестирования:*\n\n${report||'Нет данных'}`, KB([{ text: '◀️ Назад', callback_data: 'menu_quick' }])); return
    }

    // ── МОНИТОРИНГ ─────────────────────────────────────────
    if (data === 'menu_monitor') {
      edit(cid, mid, '🤖 *Мониторинг и деплой*',
        KB(
          [{ text: '🔍 Проверить бота', callback_data: 'monitor_run' }, { text: '📜 Логи', callback_data: 'monitor_logs' }],
          [{ text: '💻 Сервер CPU/RAM', callback_data: 'monitor_server' }, { text: '🧠 Память агента', callback_data: 'monitor_memory' }],
          [{ text: '🔌 API статус', callback_data: 'monitor_apis' }],
          [{ text: '🚀 Деплой (git pull)', callback_data: 'monitor_deploy' }, { text: '🔄 Перезапуск', callback_data: 'monitor_restart' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'monitor_apis') {
      edit(cid, mid, '🔌 *Проверяю все API...*', BACK)
      const { runAll, formatReport } = require('../tools/api_monitor')
      const results = await runAll()
      send(cid, formatReport(results), KB([{ text: '🔄 Обновить', callback_data: 'monitor_apis' }, { text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return
    }
    if (data === 'monitor_run') {
      edit(cid, mid, '🔍 Запускаю проверку...', BACK)
      const result = await monitorBot()
      const d = result.decision
      send(cid, d?.alert ? `⚠️ *Алерт:* ${d.alert}` : `✅ *Всё нормально*\n${(d?.actions||[]).filter(Boolean).join('\n')}`, KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return
    }
    if (data === 'monitor_server') {
      const r = await tools.ssh("echo '=CPU='; top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4\"%\"}'; echo '=RAM='; free -m | awk 'NR==2{printf \"%s/%sMB (%.0f%%)\", $3,$2,$3*100/$2}'; echo; echo '=DISK='; df -h / | awk 'NR==2{print $3\"/\"$2\" (\"$5\")\"}'")
      const lines = (r.output||'').split('\n').reduce((acc, line) => {
        if (line.startsWith('=') && line.endsWith('=')) { acc.current = line.replace(/=/g,'').trim(); return acc }
        if (line.trim()) acc[acc.current] = line.trim()
        return acc
      }, { current: '' })
      edit(cid, mid,
        `💻 *Сервер:*\n\n` +
        `🔥 CPU: *${lines['CPU']||'?'}*\n` +
        `🧠 RAM: *${lines['RAM']||'?'}*\n` +
        `💾 Диск: *${lines['DISK']||'?'}*`,
        KB([{ text: '🔄 Обновить', callback_data: 'monitor_server' }, { text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])
      ); return
    }
    if (data === 'monitor_deploy') {
      edit(cid, mid, '🚀 *Деплой: git pull + restart?*', CONFIRM('deploy_confirm', 'menu_monitor')); return
    }
    if (data === 'deploy_confirm') {
      conv.delete(cid)
      edit(cid, mid, '🚀 Деплой запущен...', BACK)
      const r = await tools.ssh('cd ~/osakarovka-bot && git pull && npm install --production --silent && pm2 restart ecosystem.config.js')
      send(cid, r.ok
        ? `✅ *Деплой успешен!*\n\`\`\`\n${r.output.slice(-600)}\n\`\`\``
        : `❌ Ошибка:\n\`\`\`\n${r.output.slice(-600)}\n\`\`\``,
        KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])
      ); return
    }
    if (data === 'monitor_logs') {
      const logs = await tools.getLogs(20)
      send(cid, `\`\`\`\n${(logs.output||'Нет').slice(-2500)}\n\`\`\``, KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return
    }
    if (data === 'monitor_memory') {
      const critical = await memory.getCritical()
      if (!critical.length) { send(cid, '🧠 Критических записей нет', KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return }
      const text = critical.map(m => `[${m.importance}] *${m.key}*: ${String(m.content).slice(0,120)}`).join('\n')
      send(cid, `🧠 *Критическая память:*\n\n${text}`, KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return
    }
    if (data === 'monitor_restart') {
      edit(cid, mid, '⚠️ *Перезапустить бота еОсакаровка?*', CONFIRM('restart_confirm', 'menu_monitor')); return
    }
    if (data === 'restart_confirm') {
      conv.delete(cid)
      edit(cid, mid, '🔄 Перезапускаю...', BACK)
      const r = await tools.ssh('pm2 restart osakarovka-bot')
      send(cid, r.ok ? '✅ Бот перезапущен!' : `❌ ${r.output.slice(0,300)}`, KB([{ text: '◀️ Мониторинг', callback_data: 'menu_monitor' }])); return
    }

    // ── ЗАДАЧИ ─────────────────────────────────────────────
    if (data === 'menu_tasks') {
      const r = await db("SELECT id, description, status, created_at FROM agent_tasks ORDER BY created_at DESC LIMIT 15")
      const rows = r.rows || []
      const pending = rows.filter(t => t.status === 'pending')
      const done    = rows.filter(t => t.status !== 'pending').slice(0, 5)
      let text = `📝 *Задачи для Claude Code*\n\n`
      if (pending.length) {
        text += `*Ожидают (${pending.length}):*\n` + pending.map(t => `🔴 #${t.id}: ${t.description}`).join('\n')
      } else { text += '✅ Нет ожидающих задач' }
      if (done.length) text += `\n\n*Выполненные:*\n` + done.map(t => `${t.status==='completed'?'✅':'❌'} #${t.id}: ${t.description.slice(0,60)}`).join('\n')
      text += `\n\n_Откроешь Claude Code — задачи появятся автоматически_`
      edit(cid, mid, text,
        KB(
          [{ text: '➕ Новая задача', callback_data: 'task_add' }, { text: '🗑 Удалить', callback_data: 'task_del_start' }],
          [{ text: '◀️ Меню', callback_data: 'main' }]
        )
      ); return
    }
    if (data === 'task_add') {
      conv.set(cid, { step: 'task_add' })
      edit(cid, mid, '📝 *Новая задача*\n\nОпиши что нужно сделать Claude Code:\n\n/cancel', BACK); return
    }
    if (data === 'task_del_start') {
      const r = await db("SELECT id, description FROM agent_tasks WHERE status='pending' ORDER BY created_at")
      const rows = r.rows || []
      if (!rows.length) { edit(cid, mid, '✅ Нет задач для удаления', BACK); return }
      conv.set(cid, { step: 'task_del', tasks: rows })
      edit(cid, mid, `🗑 *Удалить задачу*\n\nВведите ID:\n\n${rows.map(t=>`#${t.id}: ${t.description.slice(0,60)}`).join('\n')}\n\n/cancel`, BACK); return
    }

    // ── СПРОСИТЬ АГЕНТА ────────────────────────────────────
    if (data === 'ask_start') {
      conv.set(cid, { step: 'ask_hermes' })
      edit(cid, mid, '💬 *Задайте вопрос агенту Hermes:*\n\nСпросите что угодно о боте...\n\n/cancel', BACK); return
    }

    // ── ИИ АССИСТЕНТ (свободный чат) ──────────────────────
    if (data === 'free_chat_start') {
      conv.set(cid, { step: 'free_chat', history: [] })
      edit(cid, mid,
        '🧠 *ИИ Ассистент Hermes*\n\n' +
        'Задайте любой вопрос — не только про такси.\n' +
        'Перевод, текст для рассылки, совет по бизнесу, расчёт — что угодно.\n\n' +
        '_/cancel или кнопка Выйти — завершить чат_',
        KB([{ text: '◀️ Выйти', callback_data: 'main' }])
      ); return
    }

    // ── ТЕНДЕРЫ (10b.kz госзакуп + самрук) ────────────────
    if (data === 'tender_menu') {
      const auth = await tenders.isAuthorized()
      if (!auth) {
        const url = await tenders.getAuthUrl()
        if (!url) {
          edit(cid, mid,
            '🏛 *Тендеры 10b.kz*\n\n❌ Не задан TENDER_CLIENT_ID в .env\n\nДобавьте переменные и перезапустите.',
            KB([{ text: '◀️ Меню', callback_data: 'main' }])
          ); return
        }
        edit(cid, mid,
          '🏛 *Тендеры 10b.kz*\n\n🔐 Требуется авторизация.\n\nНажмите кнопку — откроется браузер, войдите через 10b.kz и вернитесь сюда.',
          KB(
            [{ text: '🔑 Авторизоваться', url }],
            [{ text: '🔄 Проверить авторизацию', callback_data: 'tender_menu' }],
            [{ text: '◀️ Меню', callback_data: 'main' }]
          )
        ); return
      }
      edit(cid, mid, '🏛 *Тендеры 10b.kz*\n\n✅ Авторизован',
        KB(
          [{ text: '🔍 Найти лоты',      callback_data: 'tender_search_start' }],
          [{ text: '🛠 Список инструментов', callback_data: 'tender_tools'     }],
          [{ text: '💬 ИИ-анализ лота',  callback_data: 'tender_analyze_start'}],
          [{ text: '🔓 Выйти',           callback_data: 'tender_logout'       }],
          [{ text: '◀️ Меню',            callback_data: 'main'                }]
        )
      ); return
    }
    if (data === 'tender_tools') {
      edit(cid, mid, '🛠 Загружаю инструменты...', BACK)
      try {
        const tools = await tenders.listTools()
        const lines = tools.map(t => `• *${t.name}*\n  _${t.description||''}_`).join('\n\n')
        send(cid, `🛠 *Инструменты 10b.kz (${tools.length}):*\n\n${lines||'нет данных'}`,
          KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }])
        )
      } catch(e) { send(cid, `❌ ${e.message}`, KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }])) }
      return
    }
    if (data === 'tender_search_start') {
      conv.set(cid, { step: 'tender_search' })
      edit(cid, mid, '🔍 *Поиск лотов*\n\nВведите ключевые слова (например: *уборка улиц* или *транспортные услуги*):\n\n/cancel',
        KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }])
      ); return
    }
    if (data === 'tender_analyze_start') {
      conv.set(cid, { step: 'tender_analyze' })
      edit(cid, mid, '💬 *ИИ-анализ лота*\n\nВставьте ID лота или ссылку на него — Claude разберёт условия, требования и риски:\n\n/cancel',
        KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }])
      ); return
    }
    if (data === 'tender_logout') {
      await tenders.revokeAuth()
      edit(cid, mid, '✅ Авторизация удалена.', KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }])); return
    }

    // ── РУЧНОЙ ЗАКАЗ — финальный шаг ──────────────────────
    if (data === 'manual_order_exec') {
      const st = conv.get(cid); conv.delete(cid)
      if (!st?.phone || !st?.dest || !st?.tariff) { edit(cid, mid, '❌ Ошибка состояния', MAIN); return }
      try {
        const orderEngine = require('../src/modules/orderEngine')
        const priceInfo = { price: st.price, tariff: st.tariff }
        const order = await orderEngine.create(st.phone, st.dest, priceInfo)
        if (!order) { send(cid, `❌ Не удалось создать — у клиента уже есть активный заказ?`, MAIN); return }
        send(cid, `✅ *Заказ #${order.id} создан!*\n📍 ${st.dest}\n💰 ${st.price} тг\n👤 ${st.name||st.phone}`, MAIN)
      } catch(e2) { send(cid, `❌ ${e2.message}`, MAIN) }
      return
    }

    // ── БЫСТРЫЙ ПРОФИЛЬ/БЛОК ВОДИТЕЛЯ (из push-уведомлений) ──
    if (data.startsWith('driver_profile_quick_')) {
      const phone = data.replace('driver_profile_quick_', '')
      const d = await q.getDriver(phone)
      if (!d) { edit(cid, mid, `❌ Водитель ${phone} не найден.`, MAIN); return }
      send(cid,
        `🚗 *${d.full_name}*\n📱 ${phone}\n${d.car_make||''} ${d.car_plate||''} ${d.car_color||''}\n⭐ ${Number(d.rating||5).toFixed(1)} | 💰 ${d.order_balance}`,
        KB([{ text: '🚫 Заблокировать', callback_data: `driver_block_quick_${phone}` }, { text: '◀️ Меню', callback_data: 'main' }])
      ); return
    }
    if (data.startsWith('driver_block_quick_')) {
      const phone = data.replace('driver_block_quick_', '')
      await q.blacklistDriver(phone, true)
      edit(cid, mid, `🚫 Водитель *${phone}* заблокирован.`, KB([{ text: '◀️ Меню', callback_data: 'main' }])); return
    }

  } catch(e) {
    conv.delete(cid)
    send(cid, `❌ Ошибка: ${e.message}`, MAIN)
  }
})

// ── text messages ──────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!isAdmin(msg.from.id)) return
  if (!msg.text || msg.text.startsWith('/')) return

  const cid  = msg.chat.id
  const text = msg.text.trim()
  const lo   = text.toLowerCase()
  const st   = conv.get(cid)

  if (!st) {
    await send(cid, '🤔 Думаю...')
    try { send(cid, (await analyze(text)).slice(0, 3500), MAIN) }
    catch(e) { send(cid, `❌ ${e.message}`, MAIN) }
    return
  }

  try {
    if (st.step === 'ask_hermes') {
      conv.delete(cid)
      await send(cid, '🤔 Думаю...')
      send(cid, (await analyze(text)).slice(0, 3500), MAIN); return
    }

    if (st.step === 'free_chat') {
      const history = st.history || []
      const thinking = await send(cid, '🤔 ...')
      let reply
      try { reply = await freeChat(text, history) }
      catch(e) { reply = `❌ ${e.message}` }
      const newHistory = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      ].slice(-20)
      conv.set(cid, { step: 'free_chat', history: newHistory })
      // удаляем "🤔 ..." и отправляем ответ
      bot.deleteMessage(cid, thinking.message_id).catch(() => {})
      send(cid, reply.slice(0, 4000), KB([{ text: '◀️ Выйти', callback_data: 'main' }]))
      return
    }

    // ── тендеры ───────────────────────────────────────────
    if (st.step === 'tender_search') {
      conv.delete(cid)
      const q = text.trim()
      await send(cid, `🔍 Ищу лоты: *${q}*...`)
      try {
        const toolList = await tenders.listTools()
        const searchTool = toolList.find(t => /search|lot|find|поис/i.test(t.name))
        if (!searchTool) {
          send(cid, `❌ Инструмент поиска не найден.\nДоступные: ${toolList.map(t=>t.name).join(', ')}`,
            KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }]))
          return
        }
        const result = await tenders.callTool(searchTool.name, { query: q })
        const summary = await freeChat(
          `Вот результаты поиска тендеров по запросу "${q}":\n\n${result.slice(0, 3000)}\n\nКратко опиши найденные лоты — название, сумма, заказчик, сроки.`,
          []
        )
        send(cid, summary.slice(0, 4000),
          KB(
            [{ text: '🔍 Новый поиск', callback_data: 'tender_search_start' }],
            [{ text: '◀️ Тендеры',    callback_data: 'tender_menu'         }]
          )
        )
      } catch(e) {
        send(cid, `❌ ${e.message}`, KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }]))
      }
      return
    }

    if (st.step === 'tender_analyze') {
      conv.delete(cid)
      await send(cid, '🤔 Анализирую лот через ИИ...')
      try {
        const toolList = await tenders.listTools()
        const getLotTool = toolList.find(t => /get|lot|detail|card/i.test(t.name))
        let rawData = text.trim()
        if (getLotTool) {
          // Попробуем получить данные лота по ID/ссылке
          const idMatch = text.match(/\d{5,}/)
          if (idMatch) {
            try {
              rawData = await tenders.callTool(getLotTool.name, { id: idMatch[0], lot_id: idMatch[0] })
            } catch(_) {}
          }
        }
        const analysis = await freeChat(
          `Проанализируй этот тендерный лот. Выдели:\n1. Что требуется\n2. Сумма и условия\n3. Сроки\n4. Требования к участнику\n5. Риски и подводные камни\n\nЛот:\n${rawData.slice(0, 3000)}`,
          []
        )
        send(cid, analysis.slice(0, 4000),
          KB(
            [{ text: '💬 Другой лот', callback_data: 'tender_analyze_start' }],
            [{ text: '◀️ Тендеры',   callback_data: 'tender_menu'          }]
          )
        )
      } catch(e) {
        send(cid, `❌ ${e.message}`, KB([{ text: '◀️ Тендеры', callback_data: 'tender_menu' }]))
      }
      return
    }

    // ── заказы ────────────────────────────────────────────
    if (st.step === 'order_find') {
      const id = parseInt(text.replace(/\D/g,''))
      if (!id) { send(cid, '❌ Введите числовой ID:'); return }
      conv.delete(cid)
      const o = await q.getOrder(id)
      if (!o) { send(cid, `❌ Заказ #${id} не найден.`, BACK); return }
      send(cid,
        `🚖 *Заказ #${o.id}*\n\n` +
        `📍 ${o.destination}${o.pickup_address?`\n🏠 Откуда: ${o.pickup_address}`:''}\n` +
        `💰 Цена: *${o.price} тг*${o.is_free?' 🎁 бесплатно':''}\n` +
        `${STATUS_ICON[o.status]||'⬜'} Статус: *${o.status}*\n\n` +
        `👤 Клиент: *${o.client_name}* (${o.client_phone})\n` +
        `${o.driver_name?`🚗 Водитель: *${o.driver_name}* (${o.driver_phone})\n   ${o.car_make} · ${o.car_plate}\n`:''}\n` +
        `🕐 Создан: ${new Date(o.created_at).toLocaleString('ru-RU')}`,
        KB([{ text: '◀️ Заказы', callback_data: 'menu_orders' }])
      ); return
    }
    if (st.step === 'order_cancel') {
      const id = parseInt(text.replace(/\D/g,''))
      if (!id) { send(cid, '❌ Введите числовой ID:'); return }
      const o = await q.getOrder(id)
      if (!o || ['completed','cancelled'].includes(o.status)) { send(cid, `❌ Заказ #${id} не найден или уже завершён.`, BACK); return }
      conv.set(cid, { ...st, order_id: id })
      send(cid, `❌ Отменить *#${id}* — ${o.destination} (${o.status})?`, CONFIRM('order_cancel_confirm', 'menu_orders')); return
    }

    // ── водители ──────────────────────────────────────────
    if (st.step === 'driver_profile') {
      const phone = text.replace(/\D/g,'')
      if (!phone) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      const d = await q.getDriver(phone)
      if (!d) { send(cid, `❌ Водитель ${phone} не найден.`, BACK); return }
      const r = await db(`SELECT COUNT(*) AS trips, COALESCE(SUM(price),0) AS earned FROM orders WHERE driver_id=$1 AND status='completed'`, [d.id])
      const s = r.rows?.[0] || {}
      send(cid,
        `🚗 *${d.full_name}*\n📱 ${phone}\n` +
        `${d.car_make} ${d.car_plate} (${d.car_color})\n\n` +
        `${d.status==='online'?'🟢 Онлайн':d.status==='busy'?'🟡 В поездке':'⚫ Офлайн'}\n` +
        `⭐ Рейтинг: *${Number(d.rating||5).toFixed(1)}*\n` +
        `💰 Баланс: *${d.order_balance}*\n` +
        `🚖 Всего поездок: *${s.trips}*\n` +
        `💵 Заработано: *${Number(s.earned).toLocaleString()} тг*`,
        BACK
      ); return
    }
    if (st.step === 'driver_history') {
      const phone = text.replace(/\D/g,'')
      if (!phone) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      const r = await db(`
        SELECT o.id, o.destination, o.price, o.status, o.created_at
        FROM orders o
        JOIN drivers d ON o.driver_id=d.id
        JOIN users u ON d.user_id=u.id
        WHERE u.phone=$1
        ORDER BY o.created_at DESC LIMIT 15
      `, [phone])
      const rows = r.rows || []
      if (!rows.length) { send(cid, `❌ Нет поездок для ${phone}`, BACK); return }
      const lines = rows.map(o => `${STATUS_ICON[o.status]||'⬜'} *${o.destination}* — ${o.price} тг · ${new Date(o.created_at).toLocaleDateString('ru-RU')}`).join('\n')
      send(cid, `📜 *Поездки водителя ${phone}:*\n\n${lines}`, BACK); return
    }
    if (st.step === 'driver_forceoff') {
      const phone = text.replace(/\D/g,'')
      if (!phone) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await db(`UPDATE drivers SET status='offline', queue_position=NULL WHERE user_id=(SELECT id FROM users WHERE phone=$1)`, [phone])
      send(cid, `⏹ Водитель *${phone}* переведён offline.`, KB([{ text: '◀️ Водители', callback_data: 'menu_drivers' }])); return
    }
    if (st.step === 'driver_balance') {
      const parts  = text.split(/\s+/)
      const amount = parseInt((parts[0]||'').replace('+',''))
      const target = (parts[1]||'').replace(/\D/g,'')
      if (isNaN(amount)||amount<=0||!target) { send(cid, '❌ Формат: `+50 77001234567`'); return }
      if (amount > 10000) { send(cid, '❌ Максимум 10000 за раз.'); return }
      conv.delete(cid)
      const result = await q.addDriverBalance(target, amount)
      if (!result) { send(cid, `❌ Водитель ${target} не найден.`); return }
      await q.addBillingRecord(result.id, amount, result.order_balance, 'Пополнение', 'tg-admin')
      send(cid, `✅ *${target}* +${amount} → итого: *${result.order_balance}*`, KB([{ text: '◀️ Водители', callback_data: 'menu_drivers' }])); return
    }
    if (st.step === 'driver_block')   { const t=text.replace(/\D/g,''); if(!t){send(cid,'❌ Введите номер:');return} conv.delete(cid); await q.blacklistDriver(t,true);  send(cid,`🚫 Водитель *${t}* заблокирован.`, KB([{text:'◀️ Водители',callback_data:'menu_drivers'}])); return }
    if (st.step === 'driver_unblock') { const t=text.replace(/\D/g,''); if(!t){send(cid,'❌ Введите номер:');return} conv.delete(cid); await q.blacklistDriver(t,false); send(cid,`✅ Водитель *${t}* разблокирован.`, KB([{text:'◀️ Водители',callback_data:'menu_drivers'}])); return }
    if (st.step === 'driver_rating')  { const t=text.replace(/\D/g,''); if(!t){send(cid,'❌ Введите номер:');return} conv.delete(cid); await q.resetDriverRating(t); send(cid,`⭐ Рейтинг *${t}* сброшен до 5.0`, KB([{text:'◀️ Водители',callback_data:'menu_drivers'}])); return }

    // ── клиент ────────────────────────────────────────────
    if (st.step === 'client_lookup') {
      const phone = text.replace(/\D/g,'')
      if (!phone) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      const [c, u] = await Promise.all([q.getClientStats(phone), q.getUser(phone)])
      if (!c) { send(cid, `❌ Клиент ${phone} не найден.`, BACK); return }
      const lastTrip = c.last_trip ? new Date(c.last_trip).toLocaleDateString('ru-RU') : 'нет'
      let status = u?.is_blacklisted ? '🚫 Заблокирован' : '✅ Активен'
      if (u?.blacklisted_until && new Date(u.blacklisted_until) > new Date()) {
        status = `⏱ Врем. блок до ${new Date(u.blacklisted_until).toLocaleDateString('ru-RU')}`
      }
      const debtLine = u?.debt_tg > 0 ? `\n💸 Долг: *${u.debt_tg} тг*${u.debt_reason?' ('+u.debt_reason+')':''}` : ''
      const CLIENT_KB = KB(
        [{ text: '📜 История заказов', callback_data: `client_orders_${phone}` }],
        [{ text: '⏱ Врем. блок', callback_data: `client_tempblock_${phone}` }, { text: '💸 Добавить долг', callback_data: `client_adddebt_${phone}` }],
        [{ text: '◀️ Меню', callback_data: 'main' }]
      )
      send(cid,
        `👤 *${c.name||'Без имени'}*\n📱 ${c.phone}\n` +
        `🚖 Поездок: *${c.trip_count}* (завершено: ${c.completed})\n` +
        `💰 Потрачено: *${Number(c.spent||0).toLocaleString()} тг*\n` +
        `📅 Последняя: *${lastTrip}*${debtLine}\n${status}`,
        CLIENT_KB
      ); return
    }

    // ── чёрный список ─────────────────────────────────────
    if (st.step === 'block_user')   { const t=text.replace(/\D/g,''); if(!t){send(cid,'❌ Введите номер:');return} conv.delete(cid); await q.blacklistUser(t,true,'Заблокирован'); send(cid,`🚫 *${t}* заблокирован.`, BACK); return }
    if (st.step === 'unblock_user') { const t=text.replace(/\D/g,''); if(!t){send(cid,'❌ Введите номер:');return} conv.delete(cid); await q.unblockUser(t); send(cid,`✅ *${t}* разблокирован.`, BACK); return }
    if (st.step === 'clear_debt') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      const u = await q.getUser(t)
      if (!u) { send(cid, `❌ Клиент ${t} не найден.`, BACK); return }
      if (!u.debt_tg) { send(cid, `ℹ️ У ${t} долга нет.`, BACK); return }
      conv.delete(cid)
      await q.clearDebt(t)
      send(cid, `✅ Долг *${t}* (${u.debt_tg} тг) снят.`, BACK); return
    }
    if (st.step === 'add_debt') {
      const parts = text.split(/\s+/)
      const phone = (parts[0]||'').replace(/\D/g,'')
      const amount = parseInt(parts[1])
      const reason = parts.slice(2).join(' ') || 'Нарушение'
      if (!phone || isNaN(amount) || amount <= 0) { send(cid, '❌ Формат: `77001234567 500 причина`'); return }
      conv.delete(cid)
      await q.addDebt(phone, amount, reason)
      send(cid, `💸 Долг *${amount} тг* добавлен клиенту ${phone}.`, BACK); return
    }
    if (st.step === 'tempblock_user') {
      const parts = text.split(/\s+/)
      const phone = (parts[0]||'').replace(/\D/g,'')
      const durStr = parts[1] || '24h'
      const match = durStr.match(/^(\d+)(h|d)$/)
      if (!phone || !match) { send(cid, '❌ Формат: `77001234567 24h` или `77001234567 3d`'); return }
      const hours = parseInt(match[1]) * (match[2]==='d'?24:1)
      const until = new Date(Date.now() + hours*3600000)
      conv.delete(cid)
      await q.tempBlockUser(phone, until, 'Временная блокировка')
      send(cid, `⏱ *${phone}* временно заблокирован до ${until.toLocaleString('ru-RU')}.`, BACK); return
    }

    // ── ручной заказ ──────────────────────────────────────
    if (st.step === 'manual_order_phone') {
      const phone = text.replace(/\D/g,'')
      if (!phone || phone.length < 10) { send(cid, '❌ Введите номер (10+ цифр):'); return }
      const u = await q.getUser(phone)
      if (!u) { send(cid, `❌ Клиент ${phone} не найден в БД.\n\nКлиент должен хотя бы раз написать боту.`, BACK); return }
      conv.set(cid, { step: 'manual_order_dest', phone, name: u.name })
      send(cid, `👤 *${u.name||phone}*\n\nВведите адрес назначения:`, BACK); return
    }
    if (st.step === 'manual_order_dest') {
      if (!text || text.length < 3) { send(cid, '❌ Введите адрес (минимум 3 символа):'); return }
      const tariffs = await q.getTariffs()
      if (!tariffs.length) { send(cid, '❌ Нет тарифов. Добавьте тариф сначала.', BACK); return }
      const list = tariffs.map((t,i) => `${i+1}. *${t.name}* — ${t.day_price} тг`).join('\n')
      conv.set(cid, { step: 'manual_order_tariff', phone: st.phone, name: st.name, dest: text.trim(), tariffs })
      send(cid, `📍 *${text.trim()}*\n\n*Выберите тариф (введите номер):*\n\n${list}`, BACK); return
    }
    if (st.step === 'manual_order_tariff') {
      const n = parseInt(text)
      if (isNaN(n) || n < 1 || n > st.tariffs.length) { send(cid, `❌ Номер 1–${st.tariffs.length}:`); return }
      const tariff = st.tariffs[n-1]
      const hour = new Date().getUTCHours() + 5
      const isNight = hour >= 23 || hour < 7
      const price = (isNight && tariff.night_price) ? tariff.night_price : tariff.day_price
      conv.set(cid, { step: 'manual_order_confirm', phone: st.phone, name: st.name, dest: st.dest, tariff, price })
      send(cid,
        `🚖 *Подтвердите заказ:*\n\n👤 ${st.name||st.phone}\n📍 ${st.dest}\n📋 ${tariff.name}\n💰 *${price} тг*${isNight?' 🌙':''}\n\nСоздать?`,
        CONFIRM('manual_order_exec', 'main')
      ); return
    }
    if (data === 'manual_order_exec') {
      // это callback — перехватывается выше, но добавим проверку
    }

    // ── рассылка ──────────────────────────────────────────
    if (st.step === 'broadcast_text') {
      if (!text.trim()) { send(cid, '❌ Введите текст:'); return }
      conv.set(cid, { ...st, message: text.trim() })
      const who = st.target==='client'?'клиентам':'водителям'
      send(cid, `📢 *Подтвердите рассылку ${who}:*\n\n${text.trim()}`, CONFIRM('broadcast_confirm_yes','broadcast_confirm_no')); return
    }

    // ── тарифы ────────────────────────────────────────────
    if (st.step === 'tariff_add_1') {
      if (!text.trim()) { send(cid, '❌ Введите название:'); return }
      conv.set(cid, { step: 'tariff_add_2', data: { name: text.trim().slice(0,100) } })
      send(cid, `✅ *${text.trim()}*\n\n*Шаг 2/4:* Цена днём (тг):`); return
    }
    if (st.step === 'tariff_add_2') {
      const dp = parseInt(text)
      if (isNaN(dp)||dp<=0||dp>99999) { send(cid, '❌ Число 1–99999:'); return }
      conv.set(cid, { step: 'tariff_add_3', data: { ...st.data, day_price: dp } })
      send(cid, `✅ День: *${dp} тг*\n\n*Шаг 3/4:* Цена ночью (0 = как днём):`); return
    }
    if (st.step === 'tariff_add_3') {
      const np = parseInt(text)||0
      conv.set(cid, { step: 'tariff_add_4', data: { ...st.data, night_price: np>0?np:null } })
      send(cid, `✅ Ночь: *${np>0?np+' тг':'как днём'}*\n\n*Шаг 4/4:* Ключевые слова через запятую:`); return
    }
    if (st.step === 'tariff_add_4') {
      const kw = text.split(',').map(k=>k.trim().toLowerCase().slice(0,50)).filter(Boolean).slice(0,20)
      if (!kw.length) { send(cid, '❌ Минимум одно слово:'); return }
      conv.delete(cid)
      const t = await q.createTariff({ name: st.data.name, keywords: kw, day_price: st.data.day_price, night_price: st.data.night_price })
      send(cid, `✅ *Тариф добавлен!*\n📍 ${t.name} — ${t.day_price} тг\n🔑 ${kw.join(', ')}`, KB([{ text: '◀️ Тарифы', callback_data: 'menu_tariffs' }])); return
    }
    if (st.step === 'tariff_edit_pick') {
      const n = parseInt(text)
      if (isNaN(n)||n<1||n>st.tariffs.length) { send(cid, `❌ Номер 1–${st.tariffs.length}:`); return }
      conv.set(cid, { step: 'tariff_edit_field', tariff_id: st.tariffs[n-1].id, name: st.tariffs[n-1].name })
      send(cid, `✏️ *${st.tariffs[n-1].name}*\n\n\`название Новое\`\n\`цена день 600\`\n\`цена ночь 800\`\n\`ключи слово1, слово2\`\n\n/cancel`); return
    }
    if (st.step === 'tariff_edit_field') {
      let upd = {}
      if (lo.startsWith('название '))      upd.name       = text.slice(9).trim().slice(0,100)
      else if (lo.startsWith('цена день ')) upd.day_price  = parseInt(text.slice(10))
      else if (lo.startsWith('цена ночь '))upd.night_price = parseInt(text.slice(10))
      else if (lo.startsWith('ключи '))     upd.keywords   = text.slice(6).split(',').map(k=>k.trim().toLowerCase()).filter(Boolean)
      else { send(cid, '❌ Неизвестная команда:'); return }
      conv.delete(cid)
      await q.updateTariff(st.tariff_id, upd)
      send(cid, '✅ *Тариф обновлён!*', KB([{ text: '◀️ Тарифы', callback_data: 'menu_tariffs' }])); return
    }
    if (st.step === 'tariff_del_pick') {
      const n = parseInt(text)
      if (isNaN(n)||n<1||n>st.tariffs.length) { send(cid, `❌ Номер 1–${st.tariffs.length}:`); return }
      conv.set(cid, { step: 'tariff_del_confirm', tariff: st.tariffs[n-1] })
      send(cid, `🗑 Удалить *${st.tariffs[n-1].name}*?`, CONFIRM('tariff_del_confirm_yes', 'menu_tariffs')); return
    }

    // ── настройки ─────────────────────────────────────────
    if (st.step === 'loyalty_every') {
      const n = parseInt(text)
      if (isNaN(n)||n<2||n>100) { send(cid, '❌ Число 2–100:'); return }
      conv.delete(cid)
      await q.setSetting('loyalty_every', String(n))
      send(cid, `✅ Каждая *${n}-я* поездка бесплатная.`, KB([{ text: '◀️ Настройки', callback_data: 'menu_settings' }])); return
    }

    // ── задачи ────────────────────────────────────────────
    if (st.step === 'task_add') {
      if (!text.trim()) { send(cid, '❌ Введите описание:'); return }
      conv.delete(cid)
      await db("INSERT INTO agent_tasks(description, status, created_at) VALUES($1,'pending',NOW())", [text.trim().slice(0,500)])
      send(cid, `✅ *Задача добавлена:*\n📝 ${text.trim()}\n\n_Откроешь Claude Code — задача появится автоматически_`, MAIN); return
    }
    if (st.step === 'task_del') {
      const id = parseInt(text.replace(/\D/g,''))
      if (!st.tasks?.find(t=>t.id===id)) { send(cid, `❌ ID #${id} не найден:`); return }
      conv.delete(cid)
      await db("DELETE FROM agent_tasks WHERE id=$1", [id])
      send(cid, `🗑 Задача #${id} удалена.`, MAIN); return
    }

  } catch(e) {
    conv.delete(cid)
    send(cid, `❌ Ошибка: ${e.message}`, MAIN)
  }
})

// ── client_orders и client_tempblock через callback ────────────
bot.on('callback_query', async (cb) => {
  if (!isAdmin(cb.from.id)) return
  const cid  = cb.message.chat.id
  const data = cb.data

  if (data.startsWith('client_orders_')) {
    bot.answerCallbackQuery(cb.id)
    const phone = data.replace('client_orders_', '')
    try {
      const r = await db(`
        SELECT id, destination, price, status, created_at FROM orders
        WHERE client_id=(SELECT id FROM users WHERE phone=$1)
        ORDER BY created_at DESC LIMIT 15
      `, [phone])
      const rows = r.rows || []
      if (!rows.length) { send(cid, `❌ Нет заказов для ${phone}`, BACK); return }
      const lines = rows.map(o => `${STATUS_ICON[o.status]||'⬜'} *${o.destination}* — ${o.price} тг · ${new Date(o.created_at).toLocaleDateString('ru-RU')}`).join('\n')
      send(cid, `📜 *История клиента ${phone}:*\n\n${lines}`, BACK)
    } catch(e) { send(cid, `❌ ${e.message}`) }
  }

  if (data.startsWith('client_tempblock_') || data.startsWith('client_adddebt_')) {
    bot.answerCallbackQuery(cb.id)
    const phone = data.replace(/client_(tempblock|adddebt)_/, '')
    const step  = data.startsWith('client_tempblock_') ? 'tempblock_user' : 'add_debt'
    conv.set(cid, { step })
    const hint = step === 'tempblock_user'
      ? `⏱ Формат: \`${phone} 24h\` или \`${phone} 3d\`\n\n/cancel`
      : `💸 Формат: \`${phone} 500 причина\`\n\n/cancel`
    send(cid, hint, BACK)
  }
})

// ── ежедневный авто-отчёт ──────────────────────────────────────
const scheduleDailyReport = () => {
  if (!ADMIN_ID) return
  const sendDailyReport = async () => {
    try {
      const [s, d] = await Promise.all([q.getTodayStats(), q.getAllDrivers()])
      const on = d.filter(x => ['online','busy'].includes(x.status)).length
      await bot.sendMessage(ADMIN_ID,
        `📊 *Итоги дня ${new Date().toLocaleDateString('ru-RU')}*\n\n` +
        `🚖 Поездок: *${s.completed}* (отменено: ${s.cancelled})\n` +
        `💰 Выручка: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💼 Комиссия: *${Number(s.commission||0).toFixed(0)} тг*\n` +
        `👥 Водителей онлайн: *${on}/${d.length}*`,
        { parse_mode: 'Markdown' }
      ).catch(() => {})
    } catch(_) {}
  }
  // Каждый день в 23:30
  const now = new Date()
  const target = new Date(now)
  target.setHours(23, 30, 0, 0)
  if (target <= now) target.setDate(target.getDate() + 1)
  setTimeout(function tick() {
    sendDailyReport()
    setTimeout(tick, 24 * 60 * 60 * 1000)
  }, target - now)
}

scheduleDailyReport()
console.log('🤖 Hermes Telegram Admin v2 запущен')
