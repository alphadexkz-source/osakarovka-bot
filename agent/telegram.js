'use strict'
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const TelegramBot = require('node-telegram-bot-api')
const { monitorBot, analyze } = require('./hermes')
const tools = require('./tools')
const memory = require('./memory')

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) { console.error('TELEGRAM_BOT_TOKEN не задан в .env'); process.exit(1) }

const ADMIN_ID = process.env.TELEGRAM_ADMIN_ID ? Number(process.env.TELEGRAM_ADMIN_ID) : null

const bot = new TelegramBot(token, { polling: true })

const isAdmin = (msg) => !ADMIN_ID || msg.from.id === ADMIN_ID

const send = (chatId, text) =>
  bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).catch(() =>
    bot.sendMessage(chatId, text)
  )

// /start
bot.onText(/\/start/, (msg) => {
  if (!isAdmin(msg)) return
  send(msg.chat.id,
    `🤖 *Hermes* — агент еОсакаровка\n\n` +
    `Команды:\n` +
    `/stats — статистика бота сегодня\n` +
    `/monitor — запустить проверку\n` +
    `/logs — последние логи\n` +
    `/memory — критическая память\n` +
    `/ask <вопрос> — спросить агента\n\n` +
    `Или просто напиши вопрос текстом.\n\n` +
    `_Твой chat\\_id: ${msg.chat.id}_`
  )
})

// /stats
bot.onText(/\/stats/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const s = await tools.getBotStats()
    send(msg.chat.id,
      `📊 *Статистика сегодня*\n\n` +
      `👥 Клиентов: ${s.clients}\n` +
      `🚗 Водителей: ${s.drivers} (онлайн: ${s.online})\n` +
      `📦 Заказов: ${s.today_orders} (выполнено: ${s.today_done})\n` +
      `💰 Выручка: ${s.today_revenue} ₸\n` +
      `🔍 Ищут водителя: ${s.searching_now}`
    )
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка: ${e.message}`)
  }
})

// /monitor
bot.onText(/\/monitor/, async (msg) => {
  if (!isAdmin(msg)) return
  await send(msg.chat.id, '🔍 Запускаю проверку...')
  try {
    const result = await monitorBot()
    const d = result.decision
    if (d?.alert) {
      send(msg.chat.id, `⚠️ *Алерт:* ${d.alert}`)
    } else {
      const actions = d?.actions?.filter(Boolean).join('\n• ') || 'Всё нормально'
      send(msg.chat.id, `✅ *Проверка завершена*\n\n• ${actions}`)
    }
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка мониторинга: ${e.message}`)
  }
})

// /logs
bot.onText(/\/logs/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const logs = await tools.getLogs(20)
    const text = (logs.output || 'Нет логов').slice(-2500)
    send(msg.chat.id, `\`\`\`\n${text}\n\`\`\``)
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка: ${e.message}`)
  }
})

// /memory
bot.onText(/\/memory/, async (msg) => {
  if (!isAdmin(msg)) return
  try {
    const critical = await memory.getCritical()
    if (!critical.length) return send(msg.chat.id, '🧠 Критических записей нет')
    const text = critical.map(m => `[${m.importance}] *${m.key}*: ${m.content.slice(0, 100)}`).join('\n')
    send(msg.chat.id, `🧠 *Критическая память:*\n\n${text}`)
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка: ${e.message}`)
  }
})

// /ask <вопрос>
bot.onText(/\/ask (.+)/, async (msg, match) => {
  if (!isAdmin(msg)) return
  const question = match[1]
  await send(msg.chat.id, '🤔 Думаю...')
  try {
    const answer = await analyze(question)
    send(msg.chat.id, answer.slice(0, 3500))
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка: ${e.message}`)
  }
})

// Любой текст → analyze
bot.on('message', async (msg) => {
  if (!isAdmin(msg)) return
  if (!msg.text || msg.text.startsWith('/')) return
  await send(msg.chat.id, '🤔 Думаю...')
  try {
    const answer = await analyze(msg.text)
    send(msg.chat.id, answer.slice(0, 3500))
  } catch(e) {
    send(msg.chat.id, `❌ Ошибка: ${e.message}`)
  }
})

console.log('🤖 Hermes Telegram бот запущен')
