const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const orderEngine = require('../modules/orderEngine')
const chatRelay = require('../modules/chatRelay')
const tariff = require('../modules/tariffEngine')
const config = require('../config')
const { isAddress, resolveAddress } = require('../modules/addressDetector')
const { parseScheduleTime } = require('../modules/smartReply')
const { recognizeVoice } = require('../modules/voiceRecognizer')
const { detectVoiceIntent } = require('../modules/voiceCommands')
const log = require('../logger')

// Добавляет подсказку о переименовании улицы (в обе стороны)
const addStreetAlias = (addr) => {
  const lo = addr.toLowerCase()

  // Новое название → показываем старое
  for (const [newName, oldLabel] of Object.entries(config.STREET_ALIASES)) {
    if (lo.includes(newName)) return addr + '\n📋 ' + oldLabel
  }

  // Старое название → показываем новое
  for (const [newName, oldLabel] of Object.entries(config.STREET_ALIASES)) {
    const oldStreet = oldLabel.replace('бывш. ', '').toLowerCase()
    const parts = oldStreet.split(' / ').map(p => p.split(' (')[0].trim())
    for (const part of parts) {
      if (part.length >= 4 && lo.includes(part)) {
        const cap = newName.charAt(0).toUpperCase() + newName.slice(1)
        return addr + '\n📋 Новое название: ' + cap
      }
    }
  }

  return addr
}

const INTERCITY = [
  // Сёла Осакаровского района
  'есиль','литвинское','литвинка','5 поселок','пятый поселок',
  'карагайлы','октябрьское','акбулак','пролетарское','озерное','приишимское',
  'колхозное','садовое','николаевка','сункар','скобелевка','шункыркол','богучар',
  'уызбай','сарыозек','вольское','сарыозен','крестовка','ошаганды','батпакты',
  'батпак','мирное','трудовое','тельманское','акпан','новый кронштадт','шидерты',
  'иртышское','звездное','дальнее','родниковское','шокай','чапаево',
  'жарлы','коктал','аккудук','токаревка','ашлы','бектас','акжар','степной',
  'михайловка','алексеевка','петровка','ивановка','новосёловка','красногорка',
  '1 поселок','2 поселок','3 поселок','4 поселок','первый поселок','второй поселок',
  // Города Карагандинской области и Казахстана
  'темиртау','балхаш','жезказган','жезқазған','сатпаев','приозёрск','каражал',
  'астана','нурсултан','нур-султан','алматы','алма-ата','шымкент',
  'кокшетау','павлодар','петропавловск','семей','усть-каменогорск','актобе',
  'костанай','атырау','актау','тараз','кызылорда','уральск',
  'абай','шахтинск','сарань','топар','карагандинск','агадырь',
]

const isIntercity = (text) => INTERCITY.some(w => (text||'').toLowerCase().includes(w))

const CANCEL_EXACT    = ['нет','жок','стоп','нет.','жоқ']
const CANCEL_CONTAINS = ['отмена','cancel','назад','выход','отменить','не надо']
const CONFIRM = ['да','ok','ок','yes','подтверждаю','поехали','ия','иа']

const isCancel  = (lo) => CANCEL_EXACT.some(w => lo === w) || CANCEL_CONTAINS.some(w => lo === w || lo.includes(w))
const isConfirm = (lo) => CONFIRM.some(w => lo === w)


/**
 * Основная точка входа для состояния confirming.
 * Принимает и голосовые, и текстовые сообщения — сам разбирается.
 * Вызывается из clientHandler.js напрямую, без промежуточной транскрипции.
 */
const handle = async (phone, name, msg, session) => {
  const { text, type, mediaUrl } = msg
  const state = session?.state || 'idle'

  // ─── Голос в confirming → recognizeVoice напрямую ───────────
  if (type === 'voice') {
    if (!mediaUrl) return
    const voiceText = await recognizeVoice(mediaUrl, phone)
    if (!voiceText) {
      await wa.sendText(phone, '🎤 Не удалось распознать. Напишите "да" или "нет".')
      return
    }

    const result = detectVoiceIntent(voiceText)
    log.msg(phone, 'client', 'confirming', 'voice', voiceText + ' → ' + result.intent)

    const ctx = session?.ctx || {}

    if (result.intent === 'confirm') {
      if (!ctx.destination) {
        await wa.sendText(phone, '⚠️ Ошибка сессии. Начните заказ заново.')
        await q.clearSession(phone)
        return
      }
      return orderEngine.create(phone, ctx.destination, {
        price: ctx.price,
        tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null,
      })
    }

    if (result.intent === 'cancel') {
      await q.clearSession(phone)
      await wa.sendText(phone, '❌ Заказ отменён.\nНапишите новый адрес.')
      return
    }

    // Неясное намерение — повторяем вопрос с кнопками
    if (ctx.destination) {
      await wa.sendButtons(phone,
        '🚖 *Ваш заказ:*\n\n📍 Куда: *' + addStreetAlias(ctx.destination) + '*\n💰 Цена: *' + ctx.price + ' тг*\n\nВсё верно?',
        [{ id: 'confirm_order', text: '✅ Да, поехали!' }, { id: 'cancel_new', text: '❌ Отмена' }]
      )
    }
    return
  }

  // ─── Текст → стандартный handleOrderState ────────────────────
  const lo = (text || '').toLowerCase().trim()
  return handleOrderState(phone, name, lo, text, msg, session)
}

const handleNewOrder = async (phone, name, text, user) => {
  if (!text || text.length < 2) return
  const active = await q.getActiveOrderByClient(phone)
  if (active) { await wa.sendText(phone, '⚠️ У вас уже есть активный заказ!\n📍 *' + active.destination + '*\n\nДождитесь завершения или отмените его.'); return }
  if (isIntercity(text)) {
    await q.setSession(phone, 'intercity_pickup', { destination: text })
    await wa.sendText(phone, '🚗 Межгородская поездка!\n🏁 Куда: *' + text + '*\n\n📍 Откуда вас забрать?\n(напишите адрес или ориентир)')
    return
  }
  const resolved = await resolveAddress(text).catch(() => ({ found: false }))
  // resolved.name используем только если он содержит оригинальный текст (истинное обогащение)
  const enriched = resolved.found && (
    resolved.groqNormalized ||
    resolved.name.toLowerCase().includes(text.trim().toLowerCase())
  )
  const displayAddress = enriched ? resolved.name : text.trim()
  const pi = await tariff.getPrice(text)
  const nightNote = pi.isNight ? '\n🌙 *Ночной тариф*' : ''
  const freeNote = user && (user.trip_count+1) % config.FREE_TRIP_EVERY === 0 ? '\n\n🎁 *Эта поездка будет БЕСПЛАТНОЙ!*' : ''
  const displayWithAlias = addStreetAlias(displayAddress)
  await wa.sendButtons(phone,
    '🚖 *Ваш заказ:*\n\n📍 Куда: *' + displayWithAlias + '*\n💰 Цена: *' + pi.price + ' тг*' + nightNote + freeNote + '\n\nВсё верно?',
    [{ id:'confirm_order', text:'✅ Да, поехали!' }, { id:'cancel_new', text:'❌ Отмена' }])
  await q.setSession(phone, 'confirming', { destination: displayAddress, price: pi.price, tariff_id: pi.tariff?.id||null })
}

// Обрабатывает состояния заказа. Возвращает true если обработал.
const handleOrderState = async (phone, name, lo, text, msg, session) => {
  const state = session?.state || 'idle'
  const { type, buttonId } = msg

  if (state === 'cancel_client_reason') {
    const ctx = session?.ctx || {}
    const reasons = { wait: 'Долго ждал водителя', plans: 'Планы изменились', address: 'Ошибся адресом' }
    const reasonKey = type === 'button' ? buttonId?.replace('cancel_reason_', '') : null
    const reason = reasons[reasonKey] || 'Клиент отменил'
    if (ctx.order_id) {
      await orderEngine.cancel(ctx.order_id, reason)
      await wa.sendText(phone, '❌ *Заказ отменён.*\nПричина: ' + reason + '\n\nНапишите куда ехать — найдём нового водителя! 🚖').catch(() => {})
    } else {
      await q.clearSession(phone)
      await wa.sendText(phone, '❌ Заказ отменён. Напишите куда ехать. 🚖')
    }
    return true
  }

  if (state === 'waiting_driver') {
    if (['где','где водитель','едет','когда','статус'].some(k => lo.includes(k))) {
      const order = await q.getActiveOrderByClient(phone)
      if (order) { const mins = Math.floor((Date.now()-new Date(order.created_at))/60000); await wa.sendText(phone, '🔍 Ищем водителя уже *' + mins + ' мин...*\nКак только найдём — сразу сообщим! 🚖') }
      return true
    }
    if (isCancel(lo)) { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id, 'Отменен клиентом'); else { await q.clearSession(phone); await wa.sendText(phone, '❌ Нет активного заказа.') } return true }
    await wa.sendButtons(phone, '🔍 Ищем водителя...\n\nОжидайте, это займёт буквально пару минут!', [{ id:'cancel_order', text:'❌ Отменить заказ' }])
    return true
  }

  if (state === 'in_trip') {
    await wa.sendButtons(phone, '🚗 Вы в поездке!\n\nЕсли нужно — напишите водителю:', [{ id:'chat_driver', text:'💬 Написать водителю' }])
    return true
  }

  if (state === 'intercity_pickup') {
    if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return true }
    if (!text || text.length < 2) { await wa.sendText(phone, '📍 Введите адрес откуда вас забрать:'); return true }
    const ctx = session?.ctx || {}
    await q.setSession(phone, 'intercity_time', { ...ctx, pickup: text.trim() })
    await wa.sendText(phone, '📍 Откуда: *' + text.trim() + '*\n\n🕐 На какое время нужна машина?\n\nНапишите:\n• *сейчас*\n• *сегодня в 15:00*\n• *завтра в 8:00*')
    return true
  }

  if (state === 'intercity_time') {
    if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return true }
    if (!text || text.length < 2) { await wa.sendText(phone, '🕐 Напишите время: *сейчас* или *завтра в 8:00*'); return true }
    const ctx = session?.ctx || {}
    const parsedTime = await parseScheduleTime(text).catch(() => text)
    const isNow = parsedTime === 'сейчас'
    const timeStr = isNow ? 'Сейчас' : parsedTime
    const pi = await tariff.getPrice(ctx.destination || '')
    await q.setSession(phone, 'intercity_confirm', { ...ctx, timeStr, isNow, price: pi.price })
    await wa.sendButtons(phone,
      '🚗 *Межгородской заказ*\n\n📍 Откуда: *' + ctx.pickup + '*\n🏁 Куда: *' + ctx.destination + '*\n🕐 Время: *' + timeStr + '*\n💰 Цена: *' + pi.price + ' тг*\n\nВсё верно?',
      [{ id:'confirm_intercity', text:'✅ Подтвердить' }, { id:'cancel_new', text:'❌ Отмена' }]
    )
    return true
  }

  if (state === 'intercity_confirm') {
    if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return true }
    if (isConfirm(lo)) {
      const ctx = session?.ctx || {}
      await orderEngine.create(phone, ctx.destination, { price: ctx.price, pickup_address: ctx.pickup, is_intercity: true })
      return true
    }
    return true
  }

  if (state === 'confirming') {
    if (isConfirm(lo)) {
      const f = await q.getSession(phone)
      if (!f || f.state !== 'confirming') return true
      const { destination, price, tariff_id } = f.ctx
      await orderEngine.create(phone, destination, { price, tariff: tariff_id ? { id: tariff_id } : null })
      return true
    }
    if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return true }
    const f = await q.getSession(phone)
    if (f?.ctx?.destination) {
      await wa.sendButtons(phone,
        '🚖 *Ваш заказ:*\n\n📍 Куда: *' + f.ctx.destination + '*\n💰 Цена: *' + f.ctx.price + ' тг*\n\nВсё верно?',
        [{ id:'confirm_order', text:'✅ Да, поехали!' }, { id:'cancel_new', text:'❌ Отмена' }])
    }
    return true
  }

  return false
}

// Обрабатывает кнопки заказа. Возвращает true если обработал.
const handleOrderButton = async (phone, buttonId, session) => {
  if (buttonId === 'confirm_order' || buttonId === 'order_found') {
    const f = await q.getSession(phone)
    if (!f || f.state !== 'confirming') return true
    const { destination, price, tariff_id } = f.ctx
    await orderEngine.create(phone, destination, { price, tariff: tariff_id ? { id: tariff_id } : null })
    return true
  }
  if (buttonId === 'confirm_intercity') {
    const f = await q.getSession(phone)
    if (!f || f.state !== 'intercity_confirm') return true
    const ctx = f.ctx
    await orderEngine.create(phone, ctx.destination, { price: ctx.price, pickup_address: ctx.pickup, is_intercity: true })
    return true
  }
  if (buttonId === 'cancel_new') {
    await q.clearSession(phone)
    await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.')
    return true
  }
  if (buttonId === 'cancel_order') {
    const order = await q.getActiveOrderByClient(phone)
    if (!order) { await q.clearSession(phone); await wa.sendText(phone, '❌ Нет активного заказа.'); return true }
    await q.setSession(phone, 'cancel_client_reason', { order_id: order.id })
    await wa.sendButtons(phone, '❓ *Почему отменяете заказ?*', [
      { id:'cancel_reason_wait',    text:'⏱ Долго жду' },
      { id:'cancel_reason_plans',   text:'🔄 Планы изменились' },
      { id:'cancel_reason_address', text:'📍 Ошибся адресом' },
    ])
    return true
  }
  if (buttonId.startsWith('cancel_reason_')) {
    const reasons = { wait:'Долго ждал водителя', plans:'Планы изменились', address:'Ошибся адресом' }
    const key = buttonId.replace('cancel_reason_', '')
    const order = await q.getActiveOrderByClient(phone)
    if (order) await orderEngine.cancel(order.id, reasons[key] || 'Клиент отменил')
    else { await q.clearSession(phone); await wa.sendText(phone, '❌ Заказ отменён.') }
    return true
  }
  if (buttonId === 'chat_driver') {
    const order = await q.getActiveOrderByClient(phone)
    if (!order) { await wa.sendText(phone, '❌ Нет активного заказа.'); return true }
    await q.setSession(phone, 'chat_mode', { prev_state: session?.state||'idle', order_id: order.id })
    await wa.sendText(phone, '💬 *Чат с водителем активирован.*\nНапишите сообщение — водитель его получит.\n\n✏️ Для выхода из чата напишите: *стоп*')
    return true
  }
  return false
}

module.exports = { handle, handleNewOrder, handleOrderState, handleOrderButton, isIntercity, isCancel, isConfirm, INTERCITY, CANCEL_EXACT, CANCEL_CONTAINS, CONFIRM }
