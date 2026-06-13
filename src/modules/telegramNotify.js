'use strict'

// Push-уведомления от основного бота → Telegram администратора
// Прямые вызовы Telegram Bot API через fetch (нет зависимости от agent/telegram.js)

const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN
const TG_ADMIN_ID = process.env.TELEGRAM_ADMIN_ID ? Number(process.env.TELEGRAM_ADMIN_ID) : null

const STATUS_ICON = {
  searching: '🟡', accepted: '🟢', arrived: '🚗',
  in_trip: '🛣', completed: '✅', cancelled: '❌', scheduled: '🕐',
}

const push = async (text, keyboard = null) => {
  if (!TG_TOKEN || !TG_ADMIN_ID) return
  try {
    const body = { chat_id: TG_ADMIN_ID, text, parse_mode: 'Markdown' }
    if (keyboard) body.reply_markup = keyboard
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
  } catch (_) {}
}

// ── События заказов ────────────────────────────────────────────────────────────

const onOrderCreated = (order) => {
  const free = order.is_free ? ' 🎁' : ''
  const intercity = order.is_intercity ? ' (межгород)' : ''
  push(`🚖 *Новый заказ #${order.id}*${free}${intercity}\n\n📍 ${order.destination}\n💰 *${order.price} тг*\n👤 ${order.client_phone}`)
}

const onNoDrivers = (order) => {
  push(`⚠️ *Нет водителей*\n\n📍 ${order.destination}\n💰 ${order.price} тг\n👤 ${order.client_phone}\n\nЗаказ *#${order.id}* отменён — никто не принял.`)
}

const onOrderAccepted = (order, driverName) => {
  push(`✅ *Принят #${order.id}*\n📍 ${order.destination}\n🚗 ${driverName}`)
}

const onOrderCompleted = (order, driverName) => {
  push(`🏁 *Завершён #${order.id}*\n📍 ${order.destination}\n💰 ${order.price} тг\n🚗 ${driverName}`)
}

const onOrderCancelled = (order, reason) => {
  if (reason === 'no_drivers') return // уже обрабатывается onNoDrivers
  push(`❌ *Отменён #${order.id}*\n📍 ${order.destination}\n📌 ${reason || '—'}`)
}

// ── События водителей ──────────────────────────────────────────────────────────

const onDriverOnline = (driver) => {
  push(`🟢 *${driver.full_name}* вышел на линию\n🚗 ${driver.car_make || ''} ${driver.car_plate || ''} · ⭐${Number(driver.rating || 5).toFixed(1)} · 💰${driver.order_balance}`)
}

const onDriverRegistered = (driver) => {
  push(
    `👤 *Новый водитель зарегистрирован!*\n\n` +
    `Имя: *${driver.full_name || '—'}*\n` +
    `Авто: *${driver.car_make || '—'}* ${driver.car_color || ''}\n` +
    `Номер: *${driver.car_plate || '—'}*\n` +
    `Тел: *${driver.phone || '—'}*\n\n` +
    `_Проверь в панели: водители → профиль_`,
    {
      inline_keyboard: [[
        { text: '👁 Профиль водителя', callback_data: `driver_profile_quick_${driver.phone}` },
        { text: '🚫 Заблокировать', callback_data: `driver_block_quick_${driver.phone}` },
      ]],
    }
  )
}

// ── Системные события ──────────────────────────────────────────────────────────

const onBotStarted = () => {
  push(`🤖 *еОсакаровка бот запущен*\n⏱ ${new Date().toLocaleString('ru-RU')}`)
}

const onLongSearch = (order, minutesPassed) => {
  push(`⏳ *Долгий поиск — #${order.id}*\n📍 ${order.destination}\n💰 ${order.price} тг\nВремя поиска: *${minutesPassed} мин*`)
}

module.exports = {
  onOrderCreated,
  onNoDrivers,
  onOrderAccepted,
  onOrderCompleted,
  onOrderCancelled,
  onDriverOnline,
  onDriverRegistered,
  onBotStarted,
  onLongSearch,
}
