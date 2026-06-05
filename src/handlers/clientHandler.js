const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const chatRelay = require('../modules/chatRelay')
const { isAddress } = require('../modules/addressDetector')
const { transcribe: transcribeVoice } = require('../modules/voiceCommandHandler')
const { getGroqReply } = require('../modules/smartReply')
const { dailyGreeting } = require('../modules/greetingService')
const driverMgr = require('../modules/driverManager')
const orderEngine = require('../modules/orderEngine')
const log = require('../logger')
const { suspicious } = require('../modules/testLogger')
const clientOrderHandler = require('./clientOrderHandler')
const clientInfoHandler = require('./clientInfoHandler')
const clientProfileHandler = require('./clientProfileHandler')

const ORDER_STATES = ['cancel_client_reason','waiting_driver','in_trip','confirming','intercity_pickup','intercity_confirm','schedule_time','scheduled_confirm','scheduled']

const getSmartReply = (text) => {
  const lo = (text||'').toLowerCase().trim()

  if (['привет','здравствуйте','добрый','хай','hi','hello','салем','ассалам','сәлем','қайырлы',
       'доброе утро','добрый день','добрый вечер','добрый ночь','здрасте'].some(w => lo === w || lo.startsWith(w+' ') || lo.startsWith(w+'!')))
    return '👋 Добро пожаловать в *еОсакаровка Сервис*!\n\n🚖 Напишите куда нужно ехать — найдём водителя!'

  if (['машину','такси','нужна машина','заказать такси','такси керек','машина керек','нужно такси',
       'вызовите','вызов','нужен водитель','закажите','вызвать такси','заказ такси'].some(w => lo.includes(w)))
    return '🚖 Напишите *куда* нужно ехать — сразу найдём водителя!'

  if (['сколько стоит','цена','тариф','почем','баға','қанша','стоимость','прайс','расценки','сколько',
       'сколько берете','ценник'].some(w => lo.includes(w)))
    return '💰 Цена от *500 тг* по посёлку.\nНапишите адрес — скажем точную стоимость! 📍'

  if (['долго ждать','сколько ждать','когда приедет','время ожидания','как долго'].some(w => lo.includes(w)))
    return '⏱ Водитель приедет через *3–7 минут* после принятия заказа.'

  if (['ночью','ночной тариф','түнде','ночной','после 23','после полуночи','ночь'].some(w => lo.includes(w)))
    return '🌙 С *23:00 до 07:00* действует ночной тариф.\n☀️ Дневной тариф с 07:00 до 23:00.'

  if (['карта','безнал','каспи','kaspi','перевод','переводом','оплата','оплатить'].some(w => lo.includes(w)))
    return '💳 Основная оплата — *наличными* водителю.\nБезнал уточняйте у водителя при посадке.'

  if (['спасибо','рахмет','благодарю','рақмет','алғыс','благодарность'].some(w => lo.includes(w)))
    return '🙏 Пожалуйста! Всегда рады помочь.\n\nЖдём вас снова в *еОсакаровка Сервис*! 😊'

  if (['пока','до свидания','сау болын','дасвидания','до встречи'].some(w => lo.includes(w)))
    return '👋 До свидания! Удачи и до новых встреч!\n\n🚖 *еОсакаровка Сервис* всегда рядом!'

  if (['помощь','как заказать','help','инструкция','как пользоваться','команды','что умеешь'].some(w => lo.includes(w)))
    return '📋 *Как заказать такси:*\n\n1️⃣ Напишите куда нужно ехать\n2️⃣ Подтвердите заказ кнопкой\n3️⃣ Ждите — водитель приедет!\n\n🎁 Каждая *10-я поездка бесплатная!*\n🏠 Сохраните домашний адрес: напишите *"домой это [адрес]"*'

  if (['работаете','круглосуточно','открыты','режим работы','график'].some(w => lo.includes(w)))
    return '🕐 Да, работаем *круглосуточно* — 24/7!\n\n🚖 Напишите куда нужно ехать.'

  if (['с вещами','с багажом','багаж','груз','перевезти вещи','переезд'].some(w => lo.includes(w)))
    return '🧳 Конечно! Напишите куда ехать — водитель поможет с вещами.'

  if (['детское кресло','с ребенком','с детьми','ребёнок','дети'].some(w => lo.includes(w)))
    return '👶 Напишите куда ехать и уточните у водителя наличие детского кресла при посадке.'

  if (['не знаю адрес','не знаю куда','ориентир','где находится','как найти'].some(w => lo.includes(w)))
    return '📍 Напишите ближайший ориентир — магазин, школу, остановку или улицу. Водитель разберётся!'

  if (['что за сервис','кто вы','о компании','о вас','что это','расскажите о','что умеет'].some(w => lo.includes(w)))
    return '🚖 *еОсакаровка Сервис* — такси посёлка Осакаровка.\n\n✅ Работаем 24/7\n💰 От 500 тг по посёлку\n🎁 Каждая 10-я поездка бесплатно\n\nПишите адрес — найдём водителя!'

  if (['скидка','акция','бонус','промокод','бесплатно','скидки'].some(w => lo.includes(w)))
    return '🎁 *Программа лояльности:*\n\nКаждая *10-я поездка* — бесплатная! 😊'

  if (['безопасно','безопасность','надёжно','проверены'].some(w => lo.includes(w)))
    return '✅ Все водители зарегистрированы в системе.\n🚖 Безопасная поездка гарантирована!'

  if (['номер водителя','телефон водителя','контакт водителя'].some(w => lo.includes(w)))
    return '📞 Данные водителя придут автоматически после принятия заказа.\n\nНапишите куда ехать! 🚖'

  if (['мой адрес','домашний адрес','сохранить адрес'].some(w => lo.includes(w)))
    return '🏠 Чтобы сохранить домашний адрес напишите:\n*"домой это [ваш адрес]"*\n\n🏢 Рабочий адрес:\n*"работа это [ваш адрес]"*\n\nПотом просто пишите *"домой"* или *"на работу"*!'

  return null
}

// Кнопки водителя попавшие в clientHandler (водитель офлайн нажал кнопку)
const handleGeneralButton = async (phone, buttonId, session) => {
  if (buttonId === 'order_as_client') { await q.setSession(phone,'driver_as_client',{}); await wa.sendText(phone,'🚖 Куда нужно ехать?'); return }
  if (buttonId === 'go_online') {
    const r = await driverMgr.goOnline(phone)
    if (r.error === 'no_balance') { await wa.sendText(phone,'🔴 Баланс = 0. Обратитесь к администратору.'); return }
    const pos = await q.getDriverQueuePosition(phone)
    const cnt = (await q.getOnlineDriversQueue()).length
    await wa.sendButtons(phone,'🟢 *Вы на линии!*\n📋 Позиция: *'+pos+'-й* из *'+cnt+'*. Ожидайте заказы!',[{id:'go_offline',text:'⚫ Уйти с линии'}])
    return
  }
  if (buttonId === 'go_offline') {
    await driverMgr.goOffline(phone)
    await wa.sendButtons(phone,'⚫ *Вы ушли с линии.*\n\nОтдыхайте!',[{id:'go_online',text:'🟢 Выйти на линию'},{id:'order_as_client',text:'🚖 Заказать такси'}])
    return
  }
}

const handle = async (phone, name, msg, session) => {
  const { text, type, buttonId, mediaUrl } = msg
  const state = session?.state || 'idle'
  const lo = (text||'').toLowerCase().trim()
  try {
    // 1. Голос
    if (type === 'voice') {

      // ── Приоритетные состояния — маршрутизируем без транскрипции ──
      // confirming: clientOrderHandler сам вызывает recognizeVoice внутри
      if (state === 'confirming') {
        return clientOrderHandler.handle(phone, name, msg, session)
      }
      // reg_*/edit_*: не должны попадать сюда (router.js → driverHandler),
      // но на случай ошибки роутинга — молча игнорируем голос
      if (state.startsWith('reg_') || state.startsWith('edit_')) return

      // ── Общая обработка голоса ────────────────────────────────────
      if (!mediaUrl) {
        await wa.sendText(phone, '🚖 Напишите куда нужно ехать:')
        return
      }
      await wa.sendText(phone, '🎤 Распознаю голосовое сообщение...')
      const recognized = await transcribeVoice(mediaUrl, phone)
      if (recognized) {
        let voiceText = recognized
        // Если ждём оценку — конвертируем числа словами в цифры
        if (state === 'waiting_rating') {
          const NUMS = {
            'один':1,'одна':1,'два':2,'две':2,'три':3,'четыре':4,'пять':5,
            'бір':1,'екі':2,'үш':3,'төрт':4,'бес':5,'one':1,'two':2,'three':3,'four':4,'five':5,
          }
          const k = recognized.toLowerCase().trim().replace(/[.,!?]/g, '')
          if (NUMS[k]) voiceText = String(NUMS[k])
        }
        return handle(phone, name, { ...msg, text: voiceText, type: 'text', mediaUrl: null }, session)
      }
      await wa.sendText(phone, '🎤 Не удалось распознать. Напишите текстом. 📝')
      return
    }

    // 2. Кнопки
    if (type === 'button' && buttonId) {
      if (await clientOrderHandler.handleOrderButton(phone, buttonId, session)) return
      await handleGeneralButton(phone, buttonId, session)
      return
    }

    // 3. Чат-режим
    if (state === 'chat_mode') {
      if (lo === 'стоп') {
        const order = await q.getActiveOrderByClient(phone)
        await q.setSession(phone, order ? 'in_trip' : 'idle', {})
        await wa.sendText(phone, '💬 Чат завершён.')
        return
      }
      return chatRelay.fromClient(phone, text)
    }

    // 4. Оценка поездки
    if (state === 'waiting_rating') return clientProfileHandler.handleRating(phone, msg, session)

    // 5. Состояния заказа
    if (ORDER_STATES.includes(state)) {
      return clientOrderHandler.handleOrderState(phone, name, lo, text, msg, session)
    }

    // 6. Слишком короткое сообщение
    if (!text || text.length < 2) { await wa.sendText(phone, '🚖 Напишите куда нужно ехать:'); return }

    // 7. Инфо-команды
    if (await clientInfoHandler.handle(phone, msg)) return

    // 8. Профильные команды (история, адреса)
    const user = await q.getUser(phone)
    if (await clientProfileHandler.handleProfile(phone, lo, text, name, user)) return

    // 9. Отмена в любом состоянии
    if (clientOrderHandler.isCancel(lo)) {
      const activeOrder = await q.getActiveOrderByClient(phone)
      if (activeOrder) {
        await orderEngine.cancel(activeOrder.id, 'Отменен клиентом')
        await wa.sendText(phone, '❌ *Заказ отменён.*\n\nНапишите куда ехать — найдём водителя! 🚖')
      } else {
        suspicious(phone, 'CLIENT', 'Неожиданный ответ после отмены')
        await q.clearSession(phone)
        await wa.sendText(phone, '❌ Нет активного заказа.\n\n🚖 Напишите куда нужно ехать.')
      }
      return
    }

    // 10. Умные статичные ответы
    const smartReply = getSmartReply(text)
    if (smartReply) { await wa.sendText(phone, smartReply); return }

    // 11. Межгород (до isAddress — города не адреса, Groq их не распознаёт)
    if (clientOrderHandler.isIntercity(text)) {
      return clientOrderHandler.handleNewOrder(phone, name, text, user)
    }

    // 12. Определение адреса → новый заказ или Groq
    const addr = await isAddress(text)
    if (!addr) {
      // Сравниваем даты по Алматинскому времени UTC+5
      const almatyNow = new Date(Date.now() + 5 * 3600_000)
      const today = almatyNow.toISOString().split('T')[0]
      const lastSeen = user?.last_seen_date ? String(user.last_seen_date).split('T')[0] : null
      if (lastSeen !== today) {
        await q.updateUser(phone, { last_seen_date: today }).catch(() => {})
        const dayGreet = await dailyGreeting(name, text, user?.trip_count||0).catch(() => null)
        if (dayGreet) { await wa.sendText(phone, dayGreet); return }
      }
      const groqReply = await getGroqReply(text, phone).catch(() => null)
      await wa.sendText(phone, groqReply || 'Напишите куда нужно ехать:')
      return
    }
    return clientOrderHandler.handleNewOrder(phone, name, text, user)

  } catch (err) {
    log.error('clientHandler', err, { phone, state })
    await wa.sendText(phone, 'Произошла ошибка. Попробуйте еще раз.').catch(()=>{})
  }
}

module.exports = { handle }
