const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const db = require('../db/index')
const favAddr = require('../modules/favoriteAddresses')
const clientOrderHandler = require('./clientOrderHandler')

// Обрабатывает оценку поездки (состояние waiting_rating)
const handleRating = async (phone, msg, session) => {
  const { type, buttonId } = msg
  const lo = (msg.text||'').toLowerCase().trim()
  const ctx = session?.ctx || {}

  const saveRating = async (score) => {
    if (ctx.order_id && ctx.driver_id) {
      const client = await q.getUser(phone)
      await q.saveRating(ctx.order_id, client?.id, ctx.driver_id, score).catch(() => {})
      await q.updateDriverRating(ctx.driver_id, score).catch(() => {})
      const driver = await q.getDriverById(ctx.driver_id).catch(() => null)
      const stars = '⭐'.repeat(score)
      await wa.sendText(phone, stars + ' *Спасибо за оценку!*\nВаш отзыв помогает нам стать лучше. 🙏')
      if (driver?.phone) {
        const praise = score >= 4 ? '💪 Продолжайте в том же духе!' : score <= 2 ? 'Постарайтесь улучшить сервис.' : ''
        await wa.sendText(driver.phone, '📬 *Новая оценка:*\n\n' + stars + ' *' + score + '/5*\n\n' + praise).catch(() => {})
      }
    }
    await q.clearSession(phone)
  }

  // Кнопки оценки (rating_5, rating_3, rating_1)
  if (type === 'button' && buttonId?.startsWith('rating_')) {
    const score = parseInt(buttonId.replace('rating_', ''))
    if (score >= 1 && score <= 5) { await saveRating(score); return }
  }
  // Текстовый ввод числом
  const score = parseInt(lo)
  if (score >= 1 && score <= 5) { await saveRating(score); return }
  if (['пропустить','не хочу','позже','skip','отмена','стоп'].some(w => lo.includes(w))) {
    await q.clearSession(phone)
    await wa.sendText(phone, '👌 Хорошо! Ждём вас снова. 🚖')
    return
  }
  await wa.sendButtons(phone, '⭐ Как прошла поездка?',
    [{ id:'rating_5', text:'😊 Отлично' }, { id:'rating_3', text:'😐 Нормально' }, { id:'rating_1', text:'😞 Плохо' }])
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

  // ─── МОЙ РЕФЕРАЛЬНЫЙ КОД ─────────────────────────────────────
  if (['мой код','реферал','пригласить','моя ссылка','бонусный код','реферальный','промокод','код друга'].some(w => lo.includes(w))) {
    const code = await q.getOrCreateReferralCode(phone).catch(() => null)
    if (!code) { await wa.sendText(phone, '❌ Не удалось получить код. Попробуйте позже.'); return true }
    const refStats = await q.getReferralStats(phone).catch(() => null)
    const invited = refStats?.activated || 0
    const bonus = refStats?.bonus_trips || 0
    await wa.sendText(phone,
      '🎁 *Ваш реферальный код:*\n\n🔑 *' + code + '*\n\n' +
      'Поделитесь кодом с другом — когда он совершит первую поездку, вы получите *бесплатную поездку!* 🎉\n\n' +
      '📊 Приглашено друзей: *' + invited + '*\n' +
      '🎫 Бонусных поездок в запасе: *' + bonus + '*'
    )
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
