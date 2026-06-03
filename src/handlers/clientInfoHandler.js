const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const tariff = require('../modules/tariffEngine')
const orderEngine = require('../modules/orderEngine')
const { getWeather, getWeatherForecast, formatWeatherFull, formatForecast } = require('../modules/weatherService')
const { getCurrencyRates, getMetalPrices, getGrainPrices, formatCurrency, formatMetals, formatGrain } = require('../modules/infoService')
const { findInAddresses } = require('../modules/addressDetector')

// Обрабатывает информационные запросы. Возвращает true если обработал.
const handleInfo = async (phone, lo, text, loWords) => {
  // ─── ПОГОДА СЕЙЧАС / ПРОГНОЗ ─────────────────────────────────
  if (['погода','какая погода','weather','ауа','ауа райы'].some(w => lo === w || lo.startsWith(w))) {
    const isWeek = ['неделю','неделя','прогноз','7 дней','forecast'].some(w => lo.includes(w))
    if (isWeek) {
      const fc = await getWeatherForecast(7).catch(() => null)
      await wa.sendText(phone, formatForecast(fc, 7))
    } else {
      const [w, fc] = await Promise.all([
        getWeather().catch(() => null),
        getWeatherForecast(4).catch(() => null),
      ])
      const today = formatWeatherFull(w) || '🌡 Данные недоступны.'
      const forecastText = fc ? '\n\n' + formatForecast(fc, 4) : ''
      await wa.sendText(phone, today + forecastText)
    }
    return true
  }

  // ─── ПРОГНОЗ НА НЕДЕЛЮ ────────────────────────────────────────
  if (['прогноз','погода на неделю','погода на 7','forecast'].some(w => lo.includes(w))) {
    const fc = await getWeatherForecast(7).catch(() => null)
    await wa.sendText(phone, formatForecast(fc, 7))
    return true
  }

  // ─── КУРС ВАЛЮТ ───────────────────────────────────────────────
  if (['курс','доллар','валюта','usd','eur','рубль','юань','тенге к','обменник'].some(w => lo.includes(w))) {
    const r = await getCurrencyRates().catch(() => null)
    await wa.sendText(phone, formatCurrency(r))
    return true
  }

  // ─── МЕТАЛЛЫ ──────────────────────────────────────────────────
  if (['золото','серебро','металл','xau','xag','слиток','платина'].some(w => lo.includes(w))) {
    const r = await getMetalPrices().catch(() => null)
    await wa.sendText(phone, formatMetals(r))
    return true
  }

  // ─── ЗЕРНО / КОРМА ────────────────────────────────────────────
  // Используем loWords (разбивка по словам) чтобы «озерное» не совпадало с «зерно»
  if (['пшеница','зерно','кукуруза','корм','фуражный','шрот','урожай','сельхоз','агро'].some(w => loWords.includes(w))) {
    const r = await getGrainPrices().catch(() => null)
    await wa.sendText(phone, formatGrain(r))
    return true
  }

  // ─── FAQ КЛИЕНТА ──────────────────────────────────────────────
  if (['faq','фак','инструкция','как заказать','как пользоваться','команды','что умеешь'].some(w => lo === w || lo.includes(w)) ||
      ['помощь'].some(w => lo === w)) {
    await wa.sendText(phone,
      '📋 *FAQ — еОсакаровка Сервис*\n\n' +
      '🚖 *Как заказать такси?*\nПросто напишите куда нужно ехать!\n\n' +
      '💰 *Цены:*\n• По посёлку от *500 тг*\n• До ЖД станции ~*1000 тг*\n• До Элеватора ~*700 тг*\n• 🌙 Ночной тариф с 23:00 до 07:00\n\n' +
      '🎁 *Бонусы:*\n• Каждая *10-я поездка — бесплатно!*\n\n' +
      '🏠 *Быстрые адреса:*\n• *"домой это [адрес]"* — сохранить дом\n• *"работа это [адрес]"* — сохранить работу\n• Потом просто *"домой"* или *"на работу"*\n\n' +
      '🔍 *Команды:*\n• *"повтори"* — повторить маршрут\n• *"история"* — мои поездки\n• *"где [место]"* — адрес любого объекта\n• *"погода"* — сегодня + 3 дня\n• *"прогноз"* — погода на 7 дней\n• *"курс"* — курс валют USD/EUR/RUB\n• *"золото"* — цены на металлы\n• *"пшеница"* — мировые цены на зерно\n• *"услуги"* — все услуги сервиса\n\n' +
      '📞 *Работаем 24/7 — всегда на связи!*'
    )
    return true
  }

  // ─── УСЛУГИ СЕРВИСА ───────────────────────────────────────────
  if (['услуги','сервисы','что вы делаете','что предлагаете','виды услуг','что можете'].some(w => lo.includes(w))) {
    await wa.sendText(phone,
      '🏢 *еОсакаровка Сервис — наши услуги:*\n\n' +
      '🚖 *Такси* — по посёлку и межгород\nОт 500 тг, работаем 24/7\n\n' +
      '📦 *Доставка* — товары, посылки, продукты\nНапишите: *"доставка [что и куда]"*\n\n' +
      '🔧 *Мужчина на час* — мелкий ремонт, монтаж, помощь по хозяйству\nНапишите: *"мастер [что нужно сделать]"*\n\n' +
      '🚛 *Аренда техники:*\n• КАМАЗ / грузовик — вывоз мусора, переезд\n• Погрузчик\n• Ассенизатор (откачка)\n• Эвакуатор\nНапишите: *"техника [что нужно]"*\n\n' +
      '❓ Напишите нужную услугу — свяжем с исполнителем!'
    )
    return true
  }

  // ─── ЗАЯВКА НА ДОСТАВКУ ──────────────────────────────────────
  if (lo.startsWith('доставка ') || lo.startsWith('доставить ')) {
    const task = text.replace(/^доставка |^доставить /i, '').trim()
    const adminPhone = await q.getSetting('admin_phone').catch(() => null)
    if (adminPhone) await wa.sendText(adminPhone, '📦 *Заявка на доставку*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {})
    await wa.sendText(phone, '📦 *Заявка на доставку принята!*\n\n📝 ' + task + '\n\n⏳ Администратор свяжется с вами в ближайшее время.')
    return true
  }

  // ─── ЗАЯВКА НА МАСТЕРА ───────────────────────────────────────
  if (lo.startsWith('мастер ') || lo.startsWith('муж на час') || lo.startsWith('мужчина на час') || lo.startsWith('ремонт ')) {
    const task = text.replace(/^мастер |^муж на час|^мужчина на час|^ремонт /i, '').trim() || text
    const adminPhone = await q.getSetting('admin_phone').catch(() => null)
    if (adminPhone) await wa.sendText(adminPhone, '🔧 *Заявка: Мастер на час*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {})
    await wa.sendText(phone, '🔧 *Заявка принята!*\n\n📝 ' + task + '\n\n⏳ Свяжемся с вами в ближайшее время.')
    return true
  }

  // ─── ЗАЯВКА НА ТЕХНИКУ ───────────────────────────────────────
  if (lo.startsWith('техника ') || ['камаз','погрузчик','ассенизатор','эвакуатор','грузовик'].some(w => lo.includes(w))) {
    const task = text.trim()
    const adminPhone = await q.getSetting('admin_phone').catch(() => null)
    if (adminPhone) await wa.sendText(adminPhone, '🚛 *Заявка: Аренда техники*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {})
    await wa.sendText(phone, '🚛 *Заявка на технику принята!*\n\n📝 ' + task + '\n\n⏳ Уточним детали и свяжемся с вами.')
    return true
  }

  // ─── НОВОСТИ/ОБНОВЛЕНИЯ ──────────────────────────────────────
  if (['новости','обновления','что нового','апдейт','news'].some(w => lo.includes(w))) {
    await wa.sendText(phone,
      '📰 *Новости еОсакаровка Сервис:*\n\n' +
      '✅ Теперь можно оценивать поездки (⭐ 1-5)\n' +
      '🔄 Команда *"повтори"* — повторяет последний маршрут\n' +
      '🎁 Каждая *10-я поездка — бесплатно!*\n' +
      '📦 Доставка — напишите *"доставка [что куда]"*\n' +
      '🔧 Мастер на час — напишите *"мастер [задача]"*\n' +
      '🚛 Аренда техники — напишите *"техника [что]"*\n' +
      '🌤 Погода/прогноз — *"погода"* / *"прогноз"*\n' +
      '💱 Курс валют — напишите *"курс"*\n' +
      '🥇 Металлы — напишите *"золото"*\n' +
      '🌾 Зерно/корма — напишите *"пшеница"*\n' +
      '📋 Помощь — напишите *"faq"*\n\n' +
      '🚖 *Работаем 24/7. Всегда рядом!*'
    )
    return true
  }

  // ─── ПОИСК АДРЕСА ОБЪЕКТА («где аптека», «на какой улице полиция») ──
  const whereRe = /^(?:где|адрес|как найти|как доехать|где находится|найди|покажи адрес|на какой улице|по какому адресу|какой адрес у|в каком доме|как пройти до)\s+(.+)/i
  const whereMatch = lo.match(whereRe)
  if (whereMatch) {
    const objName = whereMatch[1].trim()
    // Если в запросе есть цифры (номер дома) — это адрес назначения, не поиск объекта
    if (/\d/.test(objName)) return false
    const found = await findInAddresses(objName).catch(() => ({ found: false }))
    if (found.found) {
      const addrLine = found.address && found.address !== 'п. Осакаровка' ? '\n🏠 Адрес: *' + found.address + '*' : ''
      const catLine  = found.category ? '\n📂 ' + found.category : ''
      const pi = await tariff.getPrice(found.name)
      const dest = found.name + (found.address && found.address !== 'п. Осакаровка' ? ', ' + found.address : '')
      await wa.sendButtons(phone,
        '📍 *' + found.name + '*' + addrLine + catLine + '\n\nЗаказать такси туда?',
        [{ id:'order_found', text:'🚖 Да, везите туда!' }, { id:'cancel_new', text:'❌ Нет, спасибо' }]
      )
      await q.setSession(phone, 'confirming', { destination: dest, price: pi.price, tariff_id: pi.tariff?.id || null })
      return true
    }
    await wa.sendText(phone,
      '🔍 *"' + objName + '"* не нашли в нашей базе.\n\n' +
      'Попробуйте написать точнее или напишите адрес куда ехать — найдём водителя! 🚖'
    )
    return true
  }

  // ─── НАЛИЧИЕ ТАКСИ ────────────────────────────────────────────
  if (['есть такси','есть машина','такси есть','бар ма такси','такси бар ма','свободные водители',
       'сколько машин','сколько водителей','сколько такси','машин на линии','водителей на линии'].some(w => lo.includes(w))) {
    const online = await q.getOnlineDriversQueue().catch(() => [])
    const cnt = online.length
    if (cnt === 0) await wa.sendText(phone, '😔 Сейчас все водители заняты.\n⏱ Обычно ждать 5–10 минут.\n\n📍 Напишите адрес — поставим в очередь!')
    else await wa.sendText(phone, '✅ Да! Сейчас *' + cnt + '* водител' + (cnt===1?'ь':(cnt<5?'я':'ей')) + ' на линии.\n\n🚖 Напишите куда ехать!')
    return true
  }

  return false
}

module.exports = { handleInfo }
