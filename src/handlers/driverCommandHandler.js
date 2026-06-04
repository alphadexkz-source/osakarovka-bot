const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const driverMgr = require('../modules/driverManager')
const orderEngine = require('../modules/orderEngine')
const notify = require('../modules/notificationService')
const { getGroqDriverReply } = require('../modules/smartReply')
const { recognizeVoice } = require('../modules/voiceRecognizer')
const { detectVoiceIntent } = require('../modules/voiceCommands')
const log = require('../logger')
const { driverTest } = require('../modules/testLogger')

const KW = {
  ONLINE:  ['на линию','линию','выхожу','начинаю','работаю','онлайн','старт','начать','работать',
             'жұмыс','жұмысқа','линияға шығам','шығамын','приступаю','начинать'],
  OFFLINE: ['с линии','ухожу','заканчиваю','офлайн','оффлайн','стоп','отдых','отдыхаю','перерыв',
             'закончил','хватит','линиядан','аяқтадым'],
  STATS:   ['статистика','стат','итоги','сколько заработал','мои поездки','қанша','заработок','поездки'],
  EDIT:    ['изменить','изменить данные','сменить данные','редактировать'],
  QUEUE:   ['очередь','моя очередь','где я','позиция','кезек','кезегім'],
}

const match = (text, keywords) => keywords.some(w => text.includes(w))

// Map для отмены таймеров перерыва при ручном выходе на линию
const breakTimers = new Map()

const clearBreakTimer = (phone) => {
  if (breakTimers.has(phone)) {
    clearTimeout(breakTimers.get(phone))
    breakTimers.delete(phone)
  }
  // Синхронизируем с БД (fire-and-forget)
  q.clearBreakUntil(phone).catch(() => {})
}

// Обрабатывает команды кнопок водителя (не заказ). Возвращает true если обработал.
const handleCommandButtons = async (phone, buttonId) => {
  if (buttonId === 'order_as_client') { await q.setSession(phone, 'driver_as_client', {}); await wa.sendText(phone, 'Куда нужно ехать?'); return true }
  if (buttonId === 'go_online') {
    clearBreakTimer(phone)
    await q.clearSession(phone)
    const r = await driverMgr.goOnline(phone)
    if (r.error === 'no_balance') { await wa.sendText(phone, 'Баланс = 0.'); return true }
    const pos = await q.getDriverQueuePosition(phone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendButtons(phone, 'На линии! ' + pos + '-й из ' + cnt, [{ id:'go_offline', text:'Уйти с линии' }])
    return true
  }
  if (buttonId === 'go_offline') {
    await driverMgr.goOffline(phone)
    await wa.sendButtons(phone, 'Ушли с линии.', [{ id:'go_online', text:'Выйти на линию' }, { id:'order_as_client', text:'Заказать такси' }])
    return true
  }
  if (buttonId === 'edit_name')  { await q.setSession(phone, 'edit_name', {}); await wa.sendText(phone, 'Введите новое ФИО:'); return true }
  if (buttonId === 'edit_car')   { await q.setSession(phone, 'edit_car', {}); await wa.sendText(phone, 'Введите марку и номер:'); return true }
  if (buttonId === 'edit_photo') { await q.setSession(phone, 'edit_photo', {}); await wa.sendText(phone, 'Отправьте фото:'); return true }
  return false
}

// Обрабатывает текстовые команды водителя. Главный fallback.
const handleCommand = async (phone, lo, driver, session) => {
  // ─── FAQ ВОДИТЕЛЯ ─────────────────────────────────────────────
  if (['faq','фак','инструкция','помощь','help','что умеешь','как работает','команды'].some(w => lo === w || lo.startsWith(w))) {
    await wa.sendText(phone,
      '📋 *FAQ водителя — еОсакаровка Сервис*\n\n' +
      '🟢 *Выход на работу:*\n• *"на линию"* — начать работу\n• *"с линии"* — закончить работу\n• *"перерыв 20"* — пауза 20 мин (авто-возврат)\n\n' +
      '🚖 *Управление заказом:*\n• *принял / да / ok* — принять заказ\n• *прибыл / на месте* — приехал к клиенту\n• *свободен / доехали* — поездка завершена\n• *ложный* — клиента нет на месте\n\n' +
      '📊 *Статистика:*\n• *"статистика"* — заработок за день/неделю/месяц\n• *"очередь"* — моя позиция в очереди\n\n' +
      '✏️ *Изменить данные:*\n• *"имя"* — изменить ФИО\n• *"авто"* — марку и номер\n• *"фото"* — фото авто\n• *"цвет"* — цвет авто\n\n' +
      '🎙 *Все команды работают голосом!*\n📦 Баланс = кол-во заказов. При 0 — обратитесь к администратору.'
    )
    return
  }

  // ─── НА ЛИНИЮ ─────────────────────────────────────────────────
  if (match(lo, KW.ONLINE)) {
    clearBreakTimer(phone) // уже вызывает q.clearBreakUntil внутри
    await q.clearSession(phone)
    const r = await driverMgr.goOnline(phone)
    if (r.error === 'no_balance') { await wa.sendText(phone, '🔴 Баланс = 0.\nОбратитесь к администратору для пополнения.'); return }
    if (r.error === 'in_trip')    { await wa.sendText(phone, '🚗 Вы сейчас в поездке.'); return }
    const pos = await q.getDriverQueuePosition(phone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendButtons(phone, '🟢 *Вы на линии!*\n📋 Позиция: *' + pos + '-й* из *' + cnt + '* водителей.\n\nОжидайте заказы!', [{ id:'go_offline', text:'⚫ Уйти с линии' }])
    return
  }

  // ─── С ЛИНИИ ──────────────────────────────────────────────────
  if (match(lo, KW.OFFLINE)) {
    await driverMgr.goOffline(phone)
    await wa.sendButtons(phone, '⚫ *Вы ушли с линии.*\n\nОтдыхайте! Когда будете готовы — возвращайтесь.', [{ id:'go_online', text:'🟢 Выйти на линию' }, { id:'order_as_client', text:'🚖 Заказать такси' }])
    return
  }

  // ─── СТАТИСТИКА ───────────────────────────────────────────────
  if (match(lo, KW.STATS)) {
    const stats = await q.getDriverTodayStats(driver.id)
    await notify.driverStats(phone, driver, stats)
    return
  }


  // ─── ОЧЕРЕДЬ ──────────────────────────────────────────────────
  if (match(lo, KW.QUEUE)) {
    if (driver.status !== 'online') {
      await wa.sendText(phone, '⚫ Вы не на линии.\nНапишите *"на линию"* чтобы начать работу.')
    } else {
      const pos = await q.getDriverQueuePosition(phone)
      const online = await q.getOnlineDriversQueue()
      await wa.sendText(phone, '📋 *Ваша позиция в очереди:*\n\n🔢 *' + pos + '-й* из *' + online.length + '* водителей онлайн.')
    }
    return
  }

  // ─── ПЕРЕРЫВ НА N МИНУТ ───────────────────────────────────────
  const breakMatch = lo.match(/перерыв\s+(\d+)/)
  if (breakMatch) {
    const mins = Math.min(parseInt(breakMatch[1]), 180)
    await driverMgr.goOffline(phone)
    await wa.sendText(phone, '⏸ *Перерыв ' + mins + ' мин.*\n\nОтдыхайте! ☕ Автоматически верну вас на линию через *' + mins + ' мин.*')
    // Сохраняем время окончания перерыва в БД — для восстановления после рестарта
    const breakUntilDate = new Date(Date.now() + mins * 60 * 1000)
    await q.setBreakUntil(phone, breakUntilDate).catch(() => {})
    const breakTimer = setTimeout(async () => {
      try {
        breakTimers.delete(phone)
        const d = await q.getDriver(phone)
        if (d?.status === 'offline') {
          const r = await driverMgr.goOnline(phone)
          if (r.success) {
            const pos = await q.getDriverQueuePosition(phone)
            const cnt = (await q.getOnlineDriversQueue()).length
            await wa.sendText(phone, '🟢 *Перерыв закончился!*\n\nВы снова на линии — *' + pos + '-й* из *' + cnt + '* водителей. Удачных заказов! 🚖')
          }
        }
      } catch(e) { console.error('[break timer]', e.message) }
    }, mins * 60 * 1000)
    breakTimers.set(phone, breakTimer)
    return
  }

  // ─── ИЗМЕНИТЬ ДАННЫЕ ──────────────────────────────────────────
  if (match(lo, KW.EDIT)) {
    await wa.sendText(phone, '✏️ *Что изменить?*\n\n*имя* — изменить ФИО\n*авто* — марку и номер\n*фото* — фото авто\n*цвет* — цвет автомобиля')
    return
  }
  if (['имя','фио'].includes(lo))    { await q.setSession(phone, 'edit_name', {}); await wa.sendText(phone, 'Введите новое ФИО:'); return }
  if (['авто','номер'].includes(lo)) { await q.setSession(phone, 'edit_car', {}); await wa.sendText(phone, 'Введите марку и номер через запятую:'); return }
  if (['фото'].includes(lo))         { await q.setSession(phone, 'edit_photo', {}); await wa.sendText(phone, 'Отправьте фото автомобиля:'); return }
  if (['цвет'].includes(lo))         { await q.setSession(phone, 'edit_color', {}); await wa.sendText(phone, 'Введите цвет автомобиля:'); return }

  // ─── ПУСТОЕ СООБЩЕНИЕ → СТАТИСТИКА ───────────────────────────
  if (!lo) {
    const stats = await q.getDriverTodayStats(driver.id)
    await notify.driverStats(phone, driver, stats)
    return
  }

  // ─── GROQ УМНЫЙ ОТВЕТ ─────────────────────────────────────────
  const stats = await q.getDriverTodayStats(driver.id)
  const queuePos = await q.getDriverQueuePosition(phone).catch(() => null)
  const onlineList = await q.getOnlineDriversQueue().catch(() => [])
  const groqReply = await getGroqDriverReply(
    // lo для текстовых команд — передаём оригинальный text через session context недоступен,
    // поэтому используем lo (уже lowercase) — Groq справится
    lo, driver.full_name, stats, {
      status: driver.status,
      queuePos,
      queueTotal: onlineList.length
    }, phone
  ).catch(() => null)

  if (groqReply) {
    await wa.sendText(phone, groqReply)
  } else {
    const btns = driver.status === 'online'
      ? [{ id:'go_offline', text:'⚫ Уйти с линии' }]
      : [{ id:'go_online', text:'🟢 Выйти на линию' }, { id:'order_as_client', text:'🚖 Заказать такси' }]
    await wa.sendButtons(phone,
      '📋 *Команды:*\n\n🟢 *на линию* — начать работу\n⚫ *с линии* — завершить\n📊 *статистика* — заработок\n🔢 *очередь* — моя позиция\n✏️ *изменить* — обновить данные',
      btns
    )
  }
}

/**
 * Вся голосовая обработка водителя — транскрипция + intent + действие.
 * Вызывается из driverHandler.js после priority-state routing (reg_*, edit_*, driver_as_client).
 * Включает Whisper-коррекции специфичные для русских команд водителей.
 */
const handleVoice = async (phone, mediaUrl, session) => {
  const state = session?.state || 'idle'

  const voiceText = await recognizeVoice(mediaUrl, phone)
  if (!voiceText) {
    await wa.sendText(phone, '🎤 Не удалось распознать голос. Напишите команду текстом.')
    return
  }

  // Коррекция типичных ошибок Whisper для русских водительских команд
  const corrected = voiceText.toLowerCase().trim()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/слини[йеяь]?/g, 'с линии')
    .replace(/налин[иую][юй]?/g, 'на линию')
    .replace(/\bлинией\b|\bлинею\b/g, 'линии')
    .replace(/\bсвободный\b|\bсвободна\b|\bсвободно\b/g, 'свободен')
    .replace(/\bприбыла\b|\bприбыло\b/g, 'прибыл')
    .replace(/\bложная\b|\bложное\b/g, 'ложный')
    .replace(/\bпринято\b|\bприняла\b|\bпринятый\b/g, 'принял')
    .replace(/\bдоехала\b/g, 'доехали')
    .replace(/\s+/g, ' ').trim()

  const result = detectVoiceIntent(corrected)
  log.msg(phone, 'driver', state, 'voice', voiceText + ' → ' + result.intent)
  driverTest(phone, 'Голосовая команда', voiceText)

  // ─── В поездке — заказ запрашивается лениво, только когда нужен ──
  if (result.intent === 'arrived') {
    const order = await q.getActiveOrderByDriver(phone)
    if (order) return orderEngine.arrived(order.id, phone)
    return
  }
  if (result.intent === 'complete') {
    const order = await q.getActiveOrderByDriver(phone)
    if (order) return orderEngine.complete(order.id, phone)
    return
  }
  if (result.intent === 'false_call') {
    const order = await q.getActiveOrderByDriver(phone)
    if (order) return orderEngine.falseCall(order.id, phone)
    return
  }

  // ─── Принял / пропустил ───────────────────────────────────────
  if (result.intent === 'accept_order') {
    const pending = await q.getPendingOrderForDriver(phone)
    if (pending) await orderEngine.accept(pending.id, phone)
    else await wa.sendText(phone, 'Нет активного предложения.')
    return
  }
  if (result.intent === 'skip') {
    await q.moveDriverToEndOfQueue(phone)
    await wa.sendText(phone, '✅ Пропущено. Ожидайте следующий заказ.')
    return
  }

  // ─── На линию / с линии ───────────────────────────────────────
  if (result.intent === 'go_online') {
    clearBreakTimer(phone)
    await q.clearSession(phone)
    const r = await driverMgr.goOnline(phone)
    if (r.error === 'no_balance') { await wa.sendText(phone, '🔴 Баланс = 0. Обратитесь к администратору.'); return }
    const pos = await q.getDriverQueuePosition(phone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendButtons(phone,
      '🟢 *Вы на линии!*\n📋 Позиция: *' + pos + '-й* из *' + cnt + '*',
      [{ id: 'go_offline', text: '⚫ Уйти с линии' }]
    )
    return
  }
  if (result.intent === 'go_offline') {
    await driverMgr.goOffline(phone)
    await wa.sendButtons(phone, '⚫ Вы ушли с линии.',
      [{ id: 'go_online', text: '🟢 На линию' }, { id: 'order_as_client', text: '🚖 Заказать такси' }]
    )
    return
  }

  // ─── Статистика ───────────────────────────────────────────────
  if (result.intent === 'stats') {
    const driver = await q.getDriver(phone)
    if (driver) { const stats = await q.getDriverTodayStats(driver.id); await notify.driverStats(phone, driver, stats) }
    return
  }

  // ─── Groq fallback ────────────────────────────────────────────
  const driver = await q.getDriver(phone)
  const groqReply = await getGroqDriverReply(voiceText, driver?.full_name, null, { status: driver?.status }, phone)
    .catch(() => null)
  await wa.sendText(phone,
    groqReply || '🎤 Распознано: *"' + voiceText + '"*\n\nКоманды: *принял, прибыл, свободен, ложный, на линию, с линии, статистика*'
  )
}

// Единая точка входа для голосового сообщения водителя.
// Routing: reg_X/edit_X → registration handler, остальное → handleVoice.
// Вызывается из driverHandler.js после clientOrderHandler routing.
const handle = async (phone, msg, session) => {
  const { mediaUrl } = msg
  const state = session?.state || 'idle'

  if (!mediaUrl) {
    await wa.sendText(phone, '🎙 Голосовое не получено. Напишите команду.')
    return
  }

  // reg_photo/edit_photo: голос не поддерживается, нужно фото
  if (state === 'reg_photo' || state === 'edit_photo') {
    await wa.sendText(phone, '📸 Для этого шага отправьте ФОТО автомобиля.')
    return
  }

  // reg_*/edit_*: транскрибируем и передаём как текст в registration handler
  if (state.startsWith('reg_') || state.startsWith('edit_')) {
    const driverReg = require('./driverRegistrationHandler')
    const voiceText = await recognizeVoice(mediaUrl, phone)
    if (!voiceText) return
    const textMsg = { ...msg, text: voiceText, type: 'text', mediaUrl: null }
    if (state.startsWith('reg_')) return driverReg.handleRegistration(phone, textMsg, state)
    return driverReg.handleEdit(phone, textMsg, state)
  }

  // Основные команды — всё остальное
  return handleVoice(phone, mediaUrl, session)
}

module.exports = { handle, handleVoice, handleCommand, handleCommandButtons, clearBreakTimer, breakTimers, KW, match }
