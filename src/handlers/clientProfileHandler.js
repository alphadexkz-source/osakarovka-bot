const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const db = require('../db/index')
const favAddr = require('../modules/favoriteAddresses')
const clientOrderHandler = require('./clientOrderHandler')

// Ответ клиенту в зависимости от оценки
const RATING_REPLY = {
  5: (name) => `🤩 *Спасибо${name ? ', ' + name : ''}!* Рады что поездка понравилась. Ждём снова! 🚖`,
  4: (name) => `😊 *Спасибо за оценку${name ? ', ' + name : ''}!* Рады что всё хорошо. До встречи! 🚖`,
  3: (name) => `😐 *Спасибо${name ? ', ' + name : ''}!* Будем стараться лучше. Ждём снова! 🚖`,
  2: (name) => `😕 *Жаль, что не всё понравилось${name ? ', ' + name : ''}.* Постараемся быть лучше! 🙏`,
  1: (name) => `😞 *Извините за неудобство${name ? ', ' + name : ''}.* Передадим водителю. Спасибо за честность! 🙏`,
};

const DRIVER_RATING_MSG = {
  5: (stars) => `${stars} *5/5* — Клиент доволен! 💪 Так держать!`,
  4: (stars) => `${stars} *4/5* — Хорошая оценка! 😊`,
  3: (stars) => `${stars} *3/5* — Средняя оценка. Есть куда расти. 😐`,
  2: (stars) => `${stars} *2/5* — Клиент не совсем доволен. Обратите внимание. 😕`,
  1: (stars) => `${stars} *1/5* — Плохая оценка. Пожалуйста, будьте внимательнее к клиентам. 😞`,
};

// Обрабатывает оценку поездки (состояние waiting_rating)
const handleRating = async (phone, msg, session) => {
  const { type, buttonId } = msg
  const lo = (msg.text||'').toLowerCase().trim()
  const ctx = session?.ctx || {}

  const saveRating = async (score) => {
    await q.clearSession(phone)
    if (!ctx.order_id || !ctx.driver_id) return

    const client = await q.getUser(phone).catch(() => null)
    // Защита от дублей — saveRating в БД откажет при UNIQUE(order_id)
    await q.saveRating(ctx.order_id, client?.id, ctx.driver_id, score).catch(() => {})
    await q.updateDriverRating(ctx.driver_id, score).catch(() => {})

    const stars = '⭐'.repeat(score)
    const clientName = client?.name ? client.name.split(' ')[0] : null
    await wa.sendText(phone, RATING_REPLY[score]?.(clientName) || `${stars} Спасибо за оценку! 🙏`)

    const driver = await q.getDriverById(ctx.driver_id).catch(() => null)
    if (driver?.phone) {
      const msg = `📬 *Новая оценка за поездку:*\n\n` +
        (DRIVER_RATING_MSG[score]?.(stars) || `${stars} ${score}/5`)
      await wa.sendText(driver.phone, msg).catch(() => {})
    }
  }

  // Кнопки рейтинга (rating_1..rating_5)
  if (type === 'button' && buttonId?.startsWith('rating_')) {
    const score = parseInt(buttonId.replace('rating_', ''))
    if (score >= 1 && score <= 5) { await saveRating(score); return }
  }

  // Текстовый ввод числом 1-5
  const score = parseInt(lo)
  if (score >= 1 && score <= 5) { await saveRating(score); return }

  // Пропуск
  if (['пропустить','не хочу','позже','skip','отмена','стоп','некогда'].some(w => lo.includes(w))) {
    await q.clearSession(phone)
    await wa.sendText(phone, '👌 Понятно! Ждём вас снова. 🚖')
    return
  }

  // Повторный показ если непонятный ввод
  const driverName = ctx.driver_name || 'водитель'
  const ratingMsg =
    `⭐ *Оцените поездку с ${driverName}*\n\n` +
    `Напишите цифру от 1 до 5:\n` +
    `*5* — 🤩 Отлично\n` +
    `*4* — 😊 Хорошо\n` +
    `*3* — 😐 Нормально\n` +
    `*2* — 😕 Так себе\n` +
    `*1* — 😞 Плохо`
  await wa.sendButtons(phone, ratingMsg, [
    { id: 'rating_5', text: '🤩 Отлично (5)' },
    { id: 'rating_3', text: '😐 Нормально (3)' },
    { id: 'rating_1', text: '😞 Плохо (1)' },
  ])
}

// Обрабатывает профильные команды. Возвращает true если обработал.
const handleProfile = async (phone, lo, text, name, user) => {
  // ─── ПОВТОРИТЬ ПОСЛЕДНИЙ ЗАКАЗ ────────────────────────────────
  if (['повтори','повторить','снова','тот же','как прошлый раз','повтор','ещё раз','еще раз'].some(w => lo.includes(w))) {
    const lastOrder = await q.getLastCompletedOrder(phone)
    if (!lastOrder) { await wa.sendText(phone, '🚖 Прошлых поездок нет. Напишите куда ехать!'); return true }
    await wa.sendText(phone, '🔄 Повторяю последний маршрут: *' + lastOrder.destination + '*')
    await clientOrderHandler.handleNewOrder(phone, name, lastOrder.destination, user)
    return true
  }

  // ─── ИСТОРИЯ ПОЕЗДОК ──────────────────────────────────────────
  if (['история','мои поездки','поездки','тарихым','сапарым','поездка'].some(w => lo.includes(w))) {
    const hist = await db.query(
      `SELECT destination, price, status, created_at FROM orders WHERE client_id=$1 AND status IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 5`,
      [user?.id]
    ).then(r => r.rows).catch(() => [])
    if (!hist.length) { await wa.sendText(phone, '🚖 У вас пока нет поездок.\n\nНапишите куда ехать — начнём!'); return true }
    const lines = hist.map((h,i) => {
      const date = new Date(h.created_at).toLocaleDateString('ru-RU',{day:'numeric',month:'short'})
      return (i+1) + '. ' + (h.status==='completed'?'✅':'❌') + ' ' + date + ' — ' + h.destination + ' — ' + h.price + ' тг'
    }).join('\n')
    const nextFree = 10 - ((user?.trip_count||0) % 10)
    await wa.sendText(phone, '🚖 *Ваши последние поездки:*\n\n' + lines + '\n\n📊 Всего поездок: *' + (user?.trip_count||0) + '*\n🎁 До бесплатной: *' + nextFree + '*')
    return true
  }

  // ─── ЯРЛЫКИ (shortcut через favAddr) ─────────────────────────
  const shortcut = await favAddr.resolveShortcut(phone, lo).catch(() => null)
  if (shortcut) {
    await clientOrderHandler.handleNewOrder(phone, name, shortcut.address, user)
    return true
  }

  // ─── ХИНТЫ — «домой» / «на работу» без сохранённого адреса ──
  if (['домой','дома','үйге','үй','домашний адрес'].some(w => lo === w)) {
    await wa.sendText(phone, '🏠 Домашний адрес не сохранён.\n\nЧтобы сохранить:\n*"домой это [ваш адрес]"*\n\nНапример: домой это Достык 15')
    return true
  }
  if (['на работу','работа','жұмыс','жұмысқа','рабочий адрес'].some(w => lo === w)) {
    await wa.sendText(phone, '🏢 Рабочий адрес не сохранён.\n\nЧтобы сохранить:\n*"работа это [ваш адрес]"*\n\nНапример: работа это ул. Школьная 15')
    return true
  }

  // ─── СОХРАНЕНИЕ ДОМАШНЕГО АДРЕСА ─────────────────────────────
  if (lo.startsWith('домой это ') || lo.startsWith('мой дом ')) {
    const addr = text.replace(/^домой это |^мой дом /i, '').trim()
    await favAddr.saveHome(phone, addr)
    await wa.sendText(phone, '🏠 Домашний адрес сохранён: *' + addr + '*\n\nТеперь просто напишите *"домой"* — сразу поедем! 🚖')
    return true
  }

  // ─── СОХРАНЕНИЕ РАБОЧЕГО АДРЕСА ──────────────────────────────
  if (lo.startsWith('работа это ') || lo.startsWith('моя работа ')) {
    const addr = text.replace(/^работа это |^моя работа /i, '').trim()
    await favAddr.saveWork(phone, addr)
    await wa.sendText(phone, '🏢 Рабочий адрес сохранён: *' + addr + '*\n\nТеперь просто напишите *"на работу"* — сразу поедем! 🚖')
    return true
  }

  return false
}

module.exports = { handleRating, handleProfile }
