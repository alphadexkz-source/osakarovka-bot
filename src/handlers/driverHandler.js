const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const driverMgr = require('../modules/driverManager')
const orderEngine = require('../modules/orderEngine')
const chatRelay = require('../modules/chatRelay')
const tariff = require('../modules/tariffEngine')
const { transcribe: transcribeVoice } = require('../modules/voiceCommandHandler')
const { getGroqDriverReply } = require('../modules/smartReply')
const driverRegistrationHandler = require('./driverRegistrationHandler')
const driverOrderHandler = require('./driverOrderHandler')
const driverCommandHandler = require('./driverCommandHandler')

const { KW: ORDER_KW, match } = driverOrderHandler
const { KW: CMD_KW, clearBreakTimer } = driverCommandHandler

const handleCancelReason = async (phone, text, ctx) => {
  const order = await q.getActiveOrderByDriver(phone)
  if (!order) { await q.clearSession(phone); return }
  await orderEngine.cancel(order.id, text?.slice(0, 200) || 'Водитель отменил')
}

const handleAsClient = async (phone, msg, session) => {
  const { text, type, buttonId } = msg
  const ctx = session?.ctx || {}
  const lo = (text||'').toLowerCase().trim()
  if (type === 'button') {
    if (buttonId === 'confirm_order') { if (!ctx.destination) return; await orderEngine.create(phone, ctx.destination, { price: ctx.price, tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null }); return }
    if (buttonId === 'cancel_new')    { await q.clearSession(phone); await wa.sendText(phone, 'Отменено.'); return }
    if (buttonId === 'order_as_client') { await q.setSession(phone, 'driver_as_client', {}); await wa.sendText(phone, 'Куда нужно ехать?'); return }
    if (buttonId === 'cancel_order')  { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id, 'Отменён'); else { await q.clearSession(phone); await wa.sendText(phone, 'Нет заказа.') } return }
    return
  }
  if (!text || text.length < 2) return
  if (match(lo, CMD_KW.ONLINE)) {
    await q.clearSession(phone)
    const r = await driverMgr.goOnline(phone)
    if (r.error === 'no_balance') { await wa.sendText(phone, 'Баланс = 0.'); return }
    const pos = await q.getDriverQueuePosition(phone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendButtons(phone, 'Вы на линии! ' + pos + '-й из ' + cnt + '.', [{ id:'go_offline', text:'Уйти с линии' }])
    return
  }
  if (ctx.confirming) {
    if (['да','ок','ok','yes','поехали','иә'].includes(lo)) { await orderEngine.create(phone, ctx.destination, { price: ctx.price, tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null }); return }
    if (['нет','отмена','cancel','жоқ'].includes(lo))       { await q.clearSession(phone); await wa.sendText(phone, 'Отменено.'); return }
  }
  const active = await q.getActiveOrderByClient(phone)
  if (active) { await wa.sendText(phone, 'У вас уже есть активный заказ!'); return }
  const pi = await tariff.getPrice(text)
  const nightNote = pi.isNight ? ' (ночной тариф)' : ''
  await wa.sendButtons(phone, 'Ваш заказ:\n\nКуда: ' + text + '\nЦена: ' + pi.price + ' тг' + nightNote + '\n\nПодтвердить?', [{ id:'confirm_order', text:'Да, поехали!' }, { id:'cancel_new', text:'Отмена' }])
  await q.setSession(phone, 'driver_as_client', { confirming: true, destination: text, price: pi.price, tariff_id: pi.tariff?.id || null })
}

const handle = async (phone, msg, session) => {
  let { text, type, buttonId, mediaUrl } = msg
  const state = session?.state || 'idle'
  try {
    // 1. ГОЛОСОВОЕ — сложная нормализация остаётся здесь
    if (type === 'voice') {
      if (!mediaUrl) { await wa.sendText(phone, '🎙 Голосовое не получено. Напишите команду.'); return }
      const voiceText = await transcribeVoice(mediaUrl, phone)
      if (!voiceText) { await wa.sendText(phone, '🎤 Не удалось распознать. Напишите команду.'); return }

      // Голос в режиме «водитель как клиент» → обработка как адрес/текст клиента
      if (state === 'driver_as_client') {
        return handleAsClient(phone, { ...msg, text: voiceText, type: 'text' }, session)
      }
      // Голос во время фото → нельзя голосом, нужно фото
      if (state === 'reg_photo' || state === 'edit_photo') {
        await wa.sendText(phone, '📸 Для этого шага отправьте ФОТО автомобиля.')
        return
      }
      // Голос во время регистрации/редактирования → текстовый ввод данных
      if (state.startsWith('reg_'))  { return driverRegistrationHandler.handleRegistration(phone, { ...msg, text: voiceText, type: 'text' }, state) }
      if (state.startsWith('edit_')) { return driverRegistrationHandler.handleEdit(phone, { ...msg, text: voiceText, type: 'text' }, state) }

      // Нормализация: убираем пунктуацию, исправляем формы которые путает Whisper
      const vlo = voiceText.toLowerCase().trim()
        .replace(/[.,!?;:]+/g, '')
        .replace(/слини[йеяь]?/g, 'с линии')
        .replace(/налин[иую][юй]?/g, 'на линию')
        .replace(/\bлинией\b/g, 'линии').replace(/\bлинею\b/g, 'линию')
        .replace(/\bсвободный\b|\bсвободна\b|\bсвободно\b/g, 'свободен')
        .replace(/\bприбыла\b|\bприбыло\b/g, 'прибыл')
        .replace(/\bложная\b|\bложное\b/g, 'ложный')
        .replace(/\bпринято\b|\bприняла\b|\bпринятый\b/g, 'принял')
        .replace(/\bдоехала\b/g, 'доехали').replace(/\bзавершила\b/g, 'завершил')
        .trim()

      const driver2 = await q.getDriver(phone)
      if (!driver2) { await wa.sendText(phone, '⚠️ Водитель не найден.'); return }
      if (driver2?.status === 'busy') {
        const order2 = await q.getActiveOrderByDriver(phone)
        if (order2) {
          if (await driverOrderHandler.handleBusyCommands(phone, vlo, order2)) return
        }
      }
      if (await driverOrderHandler.handleAcceptSkip(phone, vlo)) return
      if (match(vlo, CMD_KW.ONLINE)) {
        await q.clearSession(phone)
        const r2 = await driverMgr.goOnline(phone)
        if (r2.error === 'no_balance') { await wa.sendText(phone, 'Баланс = 0. Обратитесь к администратору.'); return }
        const pos2 = await q.getDriverQueuePosition(phone)
        const cnt2 = (await q.getOnlineDriversQueue()).length
        await wa.sendText(phone, '🟢 *Вы на линии!*\n📋 Позиция: *' + pos2 + '-й* из *' + cnt2 + '* водителей.')
        return
      }
      if (match(vlo, CMD_KW.OFFLINE)) { await driverMgr.goOffline(phone); await wa.sendText(phone, '⚫ Ушли с линии. Отдыхайте!'); return }
      if (match(vlo, CMD_KW.STATS))   { const stats2 = await q.getDriverTodayStats(driver2?.id); await require('../modules/notificationService').driverStats(phone, driver2, stats2); return }
      const groqVoice = await getGroqDriverReply(voiceText, driver2?.full_name, null, { status: driver2?.status }).catch(() => null)
      await wa.sendText(phone, groqVoice || '🎤 Сказано: *"' + voiceText + '"*\n\nКоманды: *принял, прибыл, свободен, ложный, на линию, с линии, статистика*')
      return
    }

    // 2. Состояния регистрации/редактирования
    if (state.startsWith('reg_'))  return driverRegistrationHandler.handleRegistration(phone, msg, state)
    if (state.startsWith('edit_')) return driverRegistrationHandler.handleEdit(phone, msg, state)

    // 3. Причина отмены
    if (state === 'cancel_reason') return handleCancelReason(phone, text, session?.ctx || {})

    // 4. Кнопки
    if (type === 'button' && buttonId) {
      if (await driverOrderHandler.handleOrderButtons(phone, buttonId)) return
      await driverCommandHandler.handleCommandButtons(phone, buttonId)
      return
    }

    // 5. Чат водителя
    if (state === 'driver_chat') {
      if ((text||'').toLowerCase() === 'стоп') { await q.clearSession(phone); await wa.sendText(phone, 'Чат завершён.'); return }
      return chatRelay.fromDriver(phone, text)
    }

    // 6. Водитель как клиент
    if (state === 'driver_as_client') return handleAsClient(phone, msg, session)

    const driver = await q.getDriver(phone)
    if (!driver) { await wa.sendText(phone, 'Водитель не найден.'); return }
    const lo = (text||'').toLowerCase().trim()

    // 7. В поездке
    if (driver.status === 'busy') {
      const order = await q.getActiveOrderByDriver(phone)
      if (order) {
        if (await driverOrderHandler.handleBusyCommands(phone, lo, order)) return
        await wa.sendText(phone, '🚗 *Вы в поездке.*\n\n📍 *прибыл* — приехали к клиенту\n✅ *свободен* — довезли клиента\n🚫 *ложный* — клиента нет на месте')
        return
      }
    }

    // 8. Принял/пропустил (только если есть pending)
    if (await driverOrderHandler.handleAcceptSkip(phone, lo)) return

    // 9. Команды водителя (онлайн/офлайн/стат/и.т.д.)
    return driverCommandHandler.handleCommand(phone, lo, driver, session)

  } catch (err) {
    const log = require('../logger')
    log.error('driverHandler', err, { phone, state })
    await wa.sendText(phone, 'Произошла ошибка.').catch(() => {})
  }
}

module.exports = { handle }
