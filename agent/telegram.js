'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot = require('node-telegram-bot-api')
const { monitorBot, analyze } = require('./hermes')
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

// ── helpers ───────────────────────────────────────────────────
const send = (cid, text, extra = {}) =>
  bot.sendMessage(cid, text, { parse_mode: 'Markdown', ...extra })
    .catch(() => bot.sendMessage(cid, text.replace(/[*_`]/g, ''), extra))

const edit = (cid, mid, text, extra = {}) =>
  bot.editMessageText(text, { chat_id: cid, message_id: mid, parse_mode: 'Markdown', ...extra })
    .catch(() => {})

// ── keyboards ─────────────────────────────────────────────────
const MAIN = { reply_markup: { inline_keyboard: [
  [{ text: '📊 Статистика',      callback_data: 'stats_today' },
   { text: '🚖 Активные заказы', callback_data: 'orders' }],
  [{ text: '👥 Водители',        callback_data: 'menu_drivers' },
   { text: '📋 Тарифы',          callback_data: 'menu_tariffs' }],
  [{ text: '📢 Рассылка',        callback_data: 'menu_broadcast' },
   { text: '🚫 Чёрный список',   callback_data: 'blacklist' }],
  [{ text: '🔍 Найти клиента',   callback_data: 'client_start' },
   { text: '⚙️ Настройки',       callback_data: 'menu_settings' }],
  [{ text: '🤖 Мониторинг',      callback_data: 'menu_monitor' },
   { text: '💬 Спросить агента', callback_data: 'ask_start' }],
  [{ text: '📝 Задачи для Claude Code', callback_data: 'menu_tasks' }],
]}}

const STATS_KB = { reply_markup: { inline_keyboard: [
  [{ text: '📊 Сегодня', callback_data: 'stats_today' },
   { text: '📅 Неделя',  callback_data: 'stats_week' },
   { text: '🗓 Месяц',   callback_data: 'stats_month' }],
  [{ text: '🏆 Топ водителей', callback_data: 'stats_top' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const DRIVERS_KB = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Список', callback_data: 'drivers_list' }],
  [{ text: '💰 Пополнить баланс',  callback_data: 'driver_balance_start' },
   { text: '🚫 Заблокировать',     callback_data: 'driver_block_start' }],
  [{ text: '✅ Разблокировать',    callback_data: 'driver_unblock_start' },
   { text: '⭐ Сбросить рейтинг', callback_data: 'driver_rating_start' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const TARIFFS_KB = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Список', callback_data: 'tariffs_list' }],
  [{ text: '➕ Добавить',  callback_data: 'tariff_add_start' },
   { text: '✏️ Изменить', callback_data: 'tariff_edit_start' },
   { text: '🗑 Удалить',  callback_data: 'tariff_del_start' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const BROADCAST_KB = { reply_markup: { inline_keyboard: [
  [{ text: '👤 Клиентам',   callback_data: 'broadcast_clients' },
   { text: '🚗 Водителям', callback_data: 'broadcast_drivers' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const SETTINGS_KB = { reply_markup: { inline_keyboard: [
  [{ text: '📋 Режим: Очередь', callback_data: 'mode_queue' },
   { text: '⚡ Режим: Первый',  callback_data: 'mode_first' }],
  [{ text: '🎁 Акции / Лояльность', callback_data: 'loyalty_info' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const MONITOR_KB = { reply_markup: { inline_keyboard: [
  [{ text: '🔍 Проверить',       callback_data: 'monitor_run' },
   { text: '📜 Логи',            callback_data: 'monitor_logs' }],
  [{ text: '🧠 Память агента',   callback_data: 'monitor_memory' },
   { text: '🔄 Перезапустить',   callback_data: 'monitor_restart' }],
  [{ text: '◀️ Меню', callback_data: 'main' }],
]}}

const BACK = { reply_markup: { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'main' }]] }}

const CONFIRM = (yes, no) => ({ reply_markup: { inline_keyboard: [
  [{ text: '✅ Да', callback_data: yes }, { text: '❌ Отмена', callback_data: no }]
]}})

// ── formatters ────────────────────────────────────────────────
const fmtTariffs = (list) => list.map((t, i) =>
  `*${i+1}.* ${t.name} — ${t.day_price} тг${t.night_price ? ` / ночь ${t.night_price} тг` : ''}\n   🔑 ${(t.keywords||[]).slice(0,5).join(', ')}`
).join('\n\n')

const fmtDrivers = (list) => list.slice(0, 25).map(d =>
  `${d.status==='online'?'🟢':d.status==='busy'?'🟡':'⚫'} *${d.full_name}* ⭐${Number(d.rating||5).toFixed(1)} | Bal:${d.order_balance} | ${d.phone}`
).join('\n')

// ── /start ────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg.from.id)) return
  conv.delete(msg.chat.id)
  send(msg.chat.id,
    `👨‍💼 *Панель администратора еОсакаровка*\n\n_chat\\_id: ${msg.chat.id}_`,
    MAIN
  )
})

// ── /cancel ───────────────────────────────────────────────────
bot.onText(/\/cancel/, (msg) => {
  if (!isAdmin(msg.from.id)) return
  conv.delete(msg.chat.id)
  send(msg.chat.id, '↩️ Отменено.', MAIN)
})

// ── callback_query ────────────────────────────────────────────
bot.on('callback_query', async (cb) => {
  if (!isAdmin(cb.from.id)) return bot.answerCallbackQuery(cb.id)
  const cid  = cb.message.chat.id
  const mid  = cb.message.message_id
  const data = cb.data
  bot.answerCallbackQuery(cb.id)

  // сброс состояния при нажатии кнопки (кроме confirm-шагов)
  if (!data.endsWith('_confirm_yes') && !data.endsWith('_confirm_no') && data !== 'restart_confirm') {
    conv.delete(cid)
  }

  try {
    // ── главное меню ───────────────────────────────────────
    if (data === 'main') {
      edit(cid, mid, '👨‍💼 *Панель администратора*', MAIN); return
    }

    // ── статистика ─────────────────────────────────────────
    if (data === 'stats_today') {
      const [s, d] = await Promise.all([q.getTodayStats(), q.getAllDrivers()])
      const on = d.filter(x => ['online','busy'].includes(x.status)).length
      edit(cid, mid,
        `📊 *Статистика сегодня:*\n\n` +
        `🚖 Выполнено: *${s.completed}*\n` +
        `❌ Отменено: *${s.cancelled}*\n` +
        `📦 Всего: *${s.total}*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n` +
        `💵 Комиссия (10%): *${Number(s.commission||0).toLocaleString()} тг*\n\n` +
        `👥 Онлайн: *${on}/${d.length}*`,
        STATS_KB
      ); return
    }
    if (data === 'stats_week') {
      const s = await q.getPeriodStats(7)
      edit(cid, mid,
        `📅 *За 7 дней:*\n\n🚖 Выполнено: *${s.completed}*\n❌ Отменено: *${s.cancelled}*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n💵 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n👤 Клиентов: *${s.unique_clients}*`,
        STATS_KB
      ); return
    }
    if (data === 'stats_month') {
      const s = await q.getPeriodStats(30)
      edit(cid, mid,
        `🗓 *За 30 дней:*\n\n🚖 Выполнено: *${s.completed}*\n❌ Отменено: *${s.cancelled}*\n` +
        `💰 Оборот: *${Number(s.revenue||0).toLocaleString()} тг*\n💵 Комиссия: *${Number(s.commission||0).toLocaleString()} тг*\n👤 Клиентов: *${s.unique_clients}*`,
        STATS_KB
      ); return
    }
    if (data === 'stats_top') {
      const top = await q.getTopDrivers(7)
      const lines = top.map((d,i) => `*${i+1}.* ${d.full_name} — ${d.trips} поезд. | ⭐${Number(d.avg_rating||5).toFixed(1)}`).join('\n')
      edit(cid, mid, `🏆 *Топ водителей (7 дней):*\n\n${lines||'Нет данных'}`, STATS_KB); return
    }

    // ── активные заказы ────────────────────────────────────
    if (data === 'orders') {
      const orders = await q.getActiveOrders()
      if (!orders.length) { edit(cid, mid, '✅ *Активных заказов нет*', BACK); return }
      const ICON = { searching:'🟡', accepted:'🟢', arrived:'🚗', in_trip:'🛣' }
      const lines = orders.map(o => {
        const mins = Math.round((Date.now() - new Date(o.created_at)) / 60000)
        return `${ICON[o.status]||'⬜'} *${o.destination}* — ${o.price} тг · ${o.client_name}${o.driver_name?' · '+o.driver_name:''} (${mins} мин)`
      }).join('\n')
      edit(cid, mid, `🚖 *Активные заказы (${orders.length}):*\n\n${lines}`, BACK); return
    }

    // ── водители ───────────────────────────────────────────
    if (data === 'menu_drivers') { edit(cid, mid, '👥 *Водители*', DRIVERS_KB); return }
    if (data === 'drivers_list') {
      const list = await q.getAllDrivers()
      const on = list.filter(d => ['online','busy'].includes(d.status)).length
      edit(cid, mid, `👥 *Водители (${on} онлайн из ${list.length}):*\n\n${fmtDrivers(list)||'Нет'}`, DRIVERS_KB); return
    }
    if (data === 'driver_balance_start') {
      conv.set(cid, { step: 'driver_balance' })
      edit(cid, mid, '💰 *Пополнение баланса*\n\nФормат: `+50 77001234567`\n(сумма и номер через пробел)\n\n/cancel — отмена', BACK); return
    }
    if (data === 'driver_block_start') {
      conv.set(cid, { step: 'driver_block' })
      edit(cid, mid, '🚫 *Блокировка водителя*\n\nВведите номер (без +):\n\n/cancel — отмена', BACK); return
    }
    if (data === 'driver_unblock_start') {
      conv.set(cid, { step: 'driver_unblock' })
      edit(cid, mid, '✅ *Разблокировка водителя*\n\nВведите номер:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'driver_rating_start') {
      conv.set(cid, { step: 'driver_rating' })
      edit(cid, mid, '⭐ *Сброс рейтинга*\n\nВведите номер водителя:\n\n/cancel — отмена', BACK); return
    }

    // ── тарифы ─────────────────────────────────────────────
    if (data === 'menu_tariffs') { edit(cid, mid, '📋 *Тарифы*', TARIFFS_KB); return }
    if (data === 'tariffs_list') {
      const list = await q.getTariffs()
      edit(cid, mid, `📋 *Тарифы (${list.length}):*\n\n${fmtTariffs(list)||'Нет тарифов'}`, TARIFFS_KB); return
    }
    if (data === 'tariff_add_start') {
      conv.set(cid, { step: 'tariff_add_1', data: {} })
      edit(cid, mid, '➕ *Новый тариф — Шаг 1/4*\n\nВведите *название* направления:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'tariff_edit_start') {
      const list = await q.getTariffs()
      if (!list.length) { edit(cid, mid, '❌ Тарифов нет', TARIFFS_KB); return }
      conv.set(cid, { step: 'tariff_edit_pick', tariffs: list })
      edit(cid, mid, `✏️ *Изменить тариф*\n\nВведите номер:\n\n${fmtTariffs(list)}\n\n/cancel — отмена`, BACK); return
    }
    if (data === 'tariff_del_start') {
      const list = await q.getTariffs()
      if (!list.length) { edit(cid, mid, '❌ Тарифов нет', TARIFFS_KB); return }
      conv.set(cid, { step: 'tariff_del_pick', tariffs: list })
      edit(cid, mid, `🗑 *Удалить тариф*\n\nВведите номер:\n\n${fmtTariffs(list)}\n\n/cancel — отмена`, BACK); return
    }

    // ── рассылка ───────────────────────────────────────────
    if (data === 'menu_broadcast') { edit(cid, mid, '📢 *Рассылка*', BROADCAST_KB); return }
    if (data === 'broadcast_clients') {
      conv.set(cid, { step: 'broadcast_text', target: 'client' })
      edit(cid, mid, '📢 *Рассылка клиентам*\n\nВведите текст:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'broadcast_drivers') {
      conv.set(cid, { step: 'broadcast_text', target: 'driver' })
      edit(cid, mid, '📢 *Рассылка водителям*\n\nВведите текст:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'broadcast_confirm_yes') {
      const st = conv.get(cid); conv.delete(cid)
      if (!st?.message || !st?.target) { edit(cid, mid, '❌ Ошибка', BACK); return }
      edit(cid, mid, '⏳ Отправляю...', BACK)
      const n = await notify.broadcast(st.target, st.message)
      send(cid, `✅ Отправлено *${n}* ${st.target==='client'?'клиентам':'водителям'}.`, MAIN); return
    }
    if (data === 'broadcast_confirm_no') {
      conv.delete(cid)
      edit(cid, mid, '❌ *Рассылка отменена*', MAIN); return
    }

    // ── чёрный список ──────────────────────────────────────
    if (data === 'blacklist') {
      const blocked = await q.getBlockedUsers()
      const BL_KB = { reply_markup: { inline_keyboard: [
        [{ text: '🚫 Заблокировать клиента', callback_data: 'block_start' }],
        [{ text: '✅ Разблокировать', callback_data: 'unblock_start' },
         { text: '💸 Снять долг',     callback_data: 'debt_start' }],
        [{ text: '◀️ Меню', callback_data: 'main' }],
      ]}}
      if (!blocked.length) { edit(cid, mid, '✅ *Чёрный список пуст*', BL_KB); return }
      const lines = blocked.map(u => {
        const until = u.blacklisted_until ? ` до ${new Date(u.blacklisted_until).toLocaleDateString('ru-RU')}` : ' (навсегда)'
        return `🚫 *${u.phone}* — ${u.name||'?'}${until}${u.debt_tg>0?` | долг ${u.debt_tg} тг`:''}`
      }).join('\n')
      edit(cid, mid, `🚫 *Чёрный список (${blocked.length}):*\n\n${lines}`, BL_KB); return
    }
    if (data === 'block_start') {
      conv.set(cid, { step: 'block_user' })
      send(cid, '🚫 Введите номер клиента для блокировки:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'unblock_start') {
      conv.set(cid, { step: 'unblock_user' })
      send(cid, '✅ Введите номер для разблокировки:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'debt_start') {
      conv.set(cid, { step: 'clear_debt' })
      send(cid, '💸 Введите номер для снятия долга:\n\n/cancel — отмена', BACK); return
    }

    // ── найти клиента ──────────────────────────────────────
    if (data === 'client_start') {
      conv.set(cid, { step: 'client_lookup' })
      edit(cid, mid, '🔍 *Найти клиента*\n\nВведите номер телефона:\n\n/cancel — отмена', BACK); return
    }

    // ── настройки ──────────────────────────────────────────
    if (data === 'menu_settings') { edit(cid, mid, '⚙️ *Настройки*', SETTINGS_KB); return }
    if (data === 'mode_queue') {
      await q.setSetting('distribution_mode', 'queue')
      edit(cid, mid, '✅ Режим: *Строгая очередь* установлен', SETTINGS_KB); return
    }
    if (data === 'mode_first') {
      await q.setSetting('distribution_mode', 'first')
      edit(cid, mid, '✅ Режим: *Кто первый принял* установлен', SETTINGS_KB); return
    }
    if (data === 'loyalty_info') {
      const [enabled, every, bonus] = await Promise.all([
        q.getSetting('loyalty_enabled'), q.getSetting('loyalty_every'), q.getSetting('loyalty_bonus'),
      ])
      const LOY_KB = { reply_markup: { inline_keyboard: [
        [{ text: '🔛 Включить', callback_data: 'loyalty_on' },
         { text: '🔴 Выключить', callback_data: 'loyalty_off' }],
        [{ text: '🔢 Изменить интервал', callback_data: 'loyalty_every_start' }],
        [{ text: '◀️ Назад', callback_data: 'menu_settings' }],
      ]}}
      edit(cid, mid,
        `🎁 *Программа лояльности*\n\n` +
        `Статус: ${enabled!=='false'?'🟢 Включена':'🔴 Выключена'}\n` +
        `Каждая *${every||10}-я* поездка бесплатна\n` +
        `Бонус: *${bonus||1} поездка*`,
        LOY_KB
      ); return
    }
    if (data === 'loyalty_on') {
      await q.setSetting('loyalty_enabled', 'true')
      edit(cid, mid, '✅ Программа лояльности *включена*', SETTINGS_KB); return
    }
    if (data === 'loyalty_off') {
      await q.setSetting('loyalty_enabled', 'false')
      edit(cid, mid, '🔴 Программа лояльности *выключена*', SETTINGS_KB); return
    }
    if (data === 'loyalty_every_start') {
      conv.set(cid, { step: 'loyalty_every' })
      send(cid, '🔢 Введите число 2–100 (каждая N-я поездка бесплатна):\n\n/cancel — отмена', BACK); return
    }

    // ── мониторинг ─────────────────────────────────────────
    if (data === 'menu_monitor') { edit(cid, mid, '🤖 *Мониторинг бота*', MONITOR_KB); return }
    if (data === 'monitor_run') {
      edit(cid, mid, '🔍 Запускаю проверку...', MONITOR_KB)
      const result = await monitorBot()
      const d = result.decision
      const text = d?.alert
        ? `⚠️ *Алерт:* ${d.alert}`
        : `✅ *Всё нормально*\n${(d?.actions||[]).filter(Boolean).join('\n')}`
      send(cid, text, MONITOR_KB); return
    }
    if (data === 'monitor_logs') {
      const logs = await tools.getLogs(20)
      const text = (logs.output||'Нет логов').slice(-2500)
      send(cid, `\`\`\`\n${text}\n\`\`\``, MONITOR_KB); return
    }
    if (data === 'monitor_memory') {
      const critical = await memory.getCritical()
      if (!critical.length) { send(cid, '🧠 Критических записей нет', MONITOR_KB); return }
      const text = critical.map(m => `[${m.importance}] *${m.key}*: ${String(m.content).slice(0,120)}`).join('\n')
      send(cid, `🧠 *Критическая память:*\n\n${text}`, MONITOR_KB); return
    }
    if (data === 'monitor_restart') {
      edit(cid, mid, '⚠️ *Точно перезапустить бота еОсакаровка?*', CONFIRM('restart_confirm', 'menu_monitor')); return
    }
    if (data === 'restart_confirm') {
      conv.delete(cid)
      edit(cid, mid, '🔄 Перезапускаю...', BACK)
      const r = await tools.ssh('pm2 restart osakarovka-bot')
      send(cid, r.ok ? '✅ Бот перезапущен!' : `❌ ${r.output.slice(0,300)}`, MONITOR_KB); return
    }

    // ── задачи для Claude Code ─────────────────────────────
    if (data === 'menu_tasks') {
      const r = await tools.queryDB("SELECT id, description, status, created_at FROM agent_tasks ORDER BY created_at DESC LIMIT 15")
      const rows = r.rows || []
      const pending = rows.filter(t => t.status === 'pending')
      const done    = rows.filter(t => t.status !== 'pending').slice(0, 5)
      const TASKS_KB = { reply_markup: { inline_keyboard: [
        [{ text: '➕ Новая задача', callback_data: 'task_add' }],
        [{ text: '🗑 Удалить задачу', callback_data: 'task_del_start' }],
        [{ text: '◀️ Меню', callback_data: 'main' }],
      ]}}
      let text = `📝 *Задачи для Claude Code*\n\n`
      if (pending.length) {
        text += `*Ожидают выполнения (${pending.length}):*\n`
        text += pending.map(t => `🔴 #${t.id}: ${t.description}`).join('\n')
      } else {
        text += `✅ Нет ожидающих задач`
      }
      if (done.length) {
        text += `\n\n*Последние выполненные:*\n`
        text += done.map(t => `${t.status==='completed'?'✅':'❌'} #${t.id}: ${t.description.slice(0,60)}`).join('\n')
      }
      text += `\n\n_Когда откроешь Claude Code — задачи появятся автоматически_`
      edit(cid, mid, text, TASKS_KB); return
    }
    if (data === 'task_add') {
      conv.set(cid, { step: 'task_add' })
      edit(cid, mid, '📝 *Новая задача*\n\nОпиши что нужно сделать Claude Code:\n\n/cancel — отмена', BACK); return
    }
    if (data === 'task_del_start') {
      const r = await tools.queryDB("SELECT id, description FROM agent_tasks WHERE status='pending' ORDER BY created_at")
      const rows = r.rows || []
      if (!rows.length) { edit(cid, mid, '✅ Нет задач для удаления', BACK); return }
      conv.set(cid, { step: 'task_del', tasks: rows })
      const list = rows.map(t => `#${t.id}: ${t.description.slice(0,60)}`).join('\n')
      edit(cid, mid, `🗑 *Удалить задачу*\n\nВведите ID:\n\n${list}\n\n/cancel — отмена`, BACK); return
    }

    // ── спросить агента ────────────────────────────────────
    if (data === 'ask_start') {
      conv.set(cid, { step: 'ask_hermes' })
      edit(cid, mid, '💬 *Задайте вопрос агенту Hermes:*\n\nСпросите что угодно о боте, статистике, водителях...\n\n/cancel — отмена', BACK); return
    }

  } catch(e) {
    conv.delete(cid)
    send(cid, `❌ Ошибка: ${e.message}`, MAIN)
  }
})

// ── text messages (multi-step flows + free questions) ─────────
bot.on('message', async (msg) => {
  if (!isAdmin(msg.from.id)) return
  if (!msg.text || msg.text.startsWith('/')) return

  const cid  = msg.chat.id
  const text = msg.text
  const lo   = text.toLowerCase().trim()
  const st   = conv.get(cid)

  if (!st) {
    // нет активного флоу — отправляем в Hermes
    await send(cid, '🤔 Думаю...')
    try {
      const answer = await analyze(text)
      send(cid, answer.slice(0, 3500), MAIN)
    } catch(e) { send(cid, `❌ ${e.message}`, MAIN) }
    return
  }

  try {
    // ── ask hermes ────────────────────────────────────────
    if (st.step === 'ask_hermes') {
      conv.delete(cid)
      await send(cid, '🤔 Думаю...')
      const answer = await analyze(text)
      send(cid, answer.slice(0, 3500), MAIN); return
    }

    // ── найти клиента ─────────────────────────────────────
    if (st.step === 'client_lookup') {
      const target = text.replace(/\D/g, '')
      if (!target) { send(cid, '❌ Введите номер телефона:'); return }
      conv.delete(cid)
      const [c, u] = await Promise.all([q.getClientStats(target), q.getUser(target)])
      if (!c) { send(cid, `❌ Клиент ${target} не найден.`, BACK); return }
      const lastTrip = c.last_trip ? new Date(c.last_trip).toLocaleDateString('ru-RU') : 'нет'
      let status = u?.is_blacklisted ? '🚫 Заблокирован' : '✅ Активен'
      const debt = u?.debt_tg > 0 ? `\n💸 Долг: *${u.debt_tg} тг*` : ''
      send(cid,
        `👤 *${c.name||'Без имени'}*\n📱 ${c.phone}\n` +
        `🚖 Поездок: *${c.trip_count}* (завершено: ${c.completed})\n` +
        `💰 Потрачено: *${Number(c.spent||0).toLocaleString()} тг*\n` +
        `📅 Последняя: *${lastTrip}*${debt}\n${status}`,
        BACK
      ); return
    }

    // ── баланс водителя ───────────────────────────────────
    if (st.step === 'driver_balance') {
      const parts  = text.trim().split(/\s+/)
      const amount = parseInt((parts[0]||'').replace('+',''))
      const target = (parts[1]||'').replace(/\D/g,'')
      if (isNaN(amount)||amount<=0||!target) { send(cid, '❌ Формат: `+50 77001234567`'); return }
      if (amount > 10000) { send(cid, '❌ Максимум 10000 за раз.'); return }
      conv.delete(cid)
      const result = await q.addDriverBalance(target, amount)
      if (!result) { send(cid, `❌ Водитель ${target} не найден.`, DRIVERS_KB); return }
      await q.addBillingRecord(result.id, amount, result.order_balance, 'Пополнение', 'tg-admin')
      send(cid, `✅ *${target}* — пополнено *+${amount}*. Итого: *${result.order_balance}*`, DRIVERS_KB); return
    }

    // ── блок/разблок водителя ─────────────────────────────
    if (st.step === 'driver_block') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await q.blacklistDriver(t, true)
      send(cid, `🚫 Водитель *${t}* заблокирован.`, DRIVERS_KB); return
    }
    if (st.step === 'driver_unblock') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await q.blacklistDriver(t, false)
      send(cid, `✅ Водитель *${t}* разблокирован.`, DRIVERS_KB); return
    }
    if (st.step === 'driver_rating') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await q.resetDriverRating(t)
      send(cid, `✅ Рейтинг *${t}* сброшен до ⭐5.0`, DRIVERS_KB); return
    }

    // ── добавление тарифа 4 шага ──────────────────────────
    if (st.step === 'tariff_add_1') {
      if (!text.trim()) { send(cid, '❌ Введите название:'); return }
      conv.set(cid, { step: 'tariff_add_2', data: { name: text.trim().slice(0,100) } })
      send(cid, `✅ Название: *${text.trim()}*\n\n*Шаг 2/4:* Цена днём (тг):`); return
    }
    if (st.step === 'tariff_add_2') {
      const dp = parseInt(text)
      if (isNaN(dp)||dp<=0||dp>99999) { send(cid, '❌ Введите число 1–99999:'); return }
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
      if (!kw.length) { send(cid, '❌ Введите хотя бы одно слово:'); return }
      conv.delete(cid)
      const tariff = await q.createTariff({ name: st.data.name, keywords: kw, day_price: st.data.day_price, night_price: st.data.night_price })
      send(cid, `✅ *Тариф добавлен!*\n📍 ${tariff.name}\n💰 ${tariff.day_price} тг${tariff.night_price?` / ночь ${tariff.night_price} тг`:''}\n🔑 ${kw.join(', ')}`, TARIFFS_KB); return
    }

    // ── изменение тарифа ──────────────────────────────────
    if (st.step === 'tariff_edit_pick') {
      const n = parseInt(text)
      if (isNaN(n)||n<1||n>st.tariffs.length) { send(cid, `❌ Номер 1–${st.tariffs.length}:`); return }
      conv.set(cid, { step: 'tariff_edit_field', tariff_id: st.tariffs[n-1].id, name: st.tariffs[n-1].name })
      send(cid, `✏️ *${st.tariffs[n-1].name}*\n\nФормат:\n\`название Новое\`\n\`цена день 600\`\n\`цена ночь 800\`\n\`ключи слово1, слово2\`\n\n/cancel — отмена`); return
    }
    if (st.step === 'tariff_edit_field') {
      let upd = {}
      if (lo.startsWith('название '))       upd.name       = text.slice(9).trim().slice(0,100)
      else if (lo.startsWith('цена день '))  upd.day_price  = parseInt(text.slice(10))
      else if (lo.startsWith('цена ночь ')) upd.night_price= parseInt(text.slice(10))
      else if (lo.startsWith('ключи '))      upd.keywords   = text.slice(6).split(',').map(k=>k.trim().toLowerCase().slice(0,50)).filter(Boolean)
      else { send(cid, '❌ Неизвестная команда. Попробуй ещё:'); return }
      if (upd.day_price!==undefined&&(isNaN(upd.day_price)||upd.day_price<=0)) { send(cid,'❌ Некорректное число:'); return }
      conv.delete(cid)
      await q.updateTariff(st.tariff_id, upd)
      send(cid, '✅ *Тариф обновлён!*', TARIFFS_KB); return
    }

    // ── удаление тарифа ───────────────────────────────────
    if (st.step === 'tariff_del_pick') {
      const n = parseInt(text)
      if (isNaN(n)||n<1||n>st.tariffs.length) { send(cid, `❌ Номер 1–${st.tariffs.length}:`); return }
      const tariff = st.tariffs[n-1]
      conv.set(cid, { step: 'tariff_del_confirm', tariff })
      send(cid, `🗑 Удалить *${tariff.name}*?`, CONFIRM('tariff_del_confirm_yes', 'menu_tariffs')); return
    }

    // ── рассылка — текст ──────────────────────────────────
    if (st.step === 'broadcast_text') {
      if (!text.trim()) { send(cid, '❌ Введите текст:'); return }
      conv.set(cid, { step: 'broadcast_confirm', target: st.target, message: text.trim() })
      const who = st.target==='client'?'клиентам':'водителям'
      send(cid, `📢 *Подтвердите рассылку ${who}:*\n\n${text.trim()}`, CONFIRM('broadcast_confirm_yes','broadcast_confirm_no')); return
    }

    // ── блок/разблок клиента ──────────────────────────────
    if (st.step === 'block_user') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await q.blacklistUser(t, true, 'Заблокирован администратором')
      send(cid, `🚫 Клиент *${t}* заблокирован.`, BACK); return
    }
    if (st.step === 'unblock_user') {
      const t = text.replace(/\D/g,'')
      if (!t) { send(cid, '❌ Введите номер:'); return }
      conv.delete(cid)
      await q.unblockUser(t)
      send(cid, `✅ Клиент *${t}* разблокирован.`, BACK); return
    }
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

    // ── новая задача ──────────────────────────────────────
    if (st.step === 'task_add') {
      if (!text.trim()) { send(cid, '❌ Введите описание задачи:'); return }
      conv.delete(cid)
      await tools.queryDB(
        "INSERT INTO agent_tasks(description, status, created_at) VALUES($1, 'pending', NOW())",
        [text.trim().slice(0, 500)]
      )
      send(cid, `✅ *Задача добавлена!*\n\n📝 ${text.trim()}\n\n_Откроешь Claude Code — задача появится автоматически_`, MAIN); return
    }

    // ── удалить задачу ────────────────────────────────────
    if (st.step === 'task_del') {
      const id = parseInt(text.replace(/[^0-9]/g, ''))
      const found = st.tasks?.find(t => t.id === id)
      if (!found) { send(cid, `❌ ID #${id} не найден. Введите ID из списка:`); return }
      conv.delete(cid)
      await tools.queryDB("DELETE FROM agent_tasks WHERE id=$1", [id])
      send(cid, `🗑 Задача *#${id}* удалена.`, MAIN); return
    }

    // ── лояльность каждые N ───────────────────────────────
    if (st.step === 'loyalty_every') {
      const n = parseInt(text)
      if (isNaN(n)||n<2||n>100) { send(cid, '❌ Введите число 2–100:'); return }
      conv.delete(cid)
      await q.setSetting('loyalty_every', String(n))
      send(cid, `✅ Каждая *${n}-я* поездка теперь бесплатная.`, SETTINGS_KB); return
    }

  } catch(e) {
    conv.delete(cid)
    send(cid, `❌ Ошибка: ${e.message}`, MAIN)
  }
})

// ── tariff_del_confirm через callback ─────────────────────────
bot.on('callback_query', async (cb) => {
  if (!isAdmin(cb.from.id)) return
  if (cb.data !== 'tariff_del_confirm_yes') return
  bot.answerCallbackQuery(cb.id)
  const cid = cb.message.chat.id
  const st  = conv.get(cid)
  conv.delete(cid)
  if (!st?.tariff) return
  await q.deleteTariff(st.tariff.id).catch(() => {})
  send(cid, `🗑 Тариф *${st.tariff.name}* удалён.`, TARIFFS_KB)
})

console.log('🤖 Hermes Telegram Admin запущен')
