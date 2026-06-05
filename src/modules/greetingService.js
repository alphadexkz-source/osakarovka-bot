'use strict'
const { callClaude } = require('../lib/claudeApi')
const { getWeather, formatWeatherForGroq } = require('./weatherService')
const { SYSTEM_CONTEXT } = require('./prompts')

const getTimeOfDay = () => {
  const h = new Date(Date.now() + 5 * 3600_000).getUTCHours() // UTC+5 Almaty
  if (h >= 6  && h < 12) return { key: 'morning', ru: 'утро',  greeting_ru: 'Доброе утро',  greeting_kz: 'Қайырлы таң'  }
  if (h >= 12 && h < 17) return { key: 'day',     ru: 'день',  greeting_ru: 'Добрый день',  greeting_kz: 'Қайырлы күн'  }
  if (h >= 17 && h < 22) return { key: 'evening', ru: 'вечер', greeting_ru: 'Добрый вечер', greeting_kz: 'Қайырлы кеш'  }
  return                        { key: 'night',   ru: 'ночь',  greeting_ru: 'Доброй ночи',  greeting_kz: 'Қайырлы түн'  }
}

const detectLanguage = (text) => {
  if (!text) return 'ru'
  const kzWords = ['сәлем', 'салем', 'қайырлы', 'рахмет', 'жақсы', 'иә', 'жоқ', 'қайда', 'үйге', 'жұмыс', 'мектеп', 'дүкен', 'аурухана', 'болыңыз']
  return kzWords.some(w => (text || '').toLowerCase().includes(w)) ? 'kz' : 'ru'
}

// Первая буква заглавная для каждого слова
const fmt = (name) => {
  if (!name || name === 'Клиент' || name === 'Пользователь') return ''
  return name.split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1) : '').join(' ').trim()
}

// Проверка: нет ли в ответе иностранных слов
const isCleanText = (text) => {
  if (!text) return false
  const latinWords = (text.match(/\b[a-zA-Z]{3,}\b/g) || [])
  return latinWords.length === 0
}

// ─── СТАТИЧЕСКИЕ ШАБЛОНЫ (резерв при сбое Claude) ─────────────

const STATIC_GREET = {
  morning: (n) => `☀️ Доброе утро${n ? ', ' + n : ''}! Куда едем? 🚖`,
  day:     (n) => `👋 Добрый день${n ? ', ' + n : ''}! Напишите куда нужно — найдём водителя. 🚖`,
  evening: (n) => `🌆 Добрый вечер${n ? ', ' + n : ''}! Куда везти? 🚖`,
  night:   (n) => `🌙 Доброй ночи${n ? ', ' + n : ''}! Напишите адрес — водитель найдётся. 🚖`,
}

const STATIC_GREET_LOYAL = {
  morning: (n, cnt)  => `☀️ Доброе утро${n ? ', ' + n : ''}! ${cnt} поездок с нами — спасибо 😊 Куда сегодня? 🚖`,
  day:     (n, cnt)  => `👋 Добрый день${n ? ', ' + n : ''}! ${cnt} поездок — вы наш постоянный клиент 😊 Куда едем? 🚖`,
  evening: (n, _cnt) => `🌆 Добрый вечер${n ? ', ' + n : ''}! Рады видеть снова. Куда везти? 🚖`,
  night:   (n, _cnt) => `🌙 Доброй ночи${n ? ', ' + n : ''}! Куда нужно? Напишите адрес. 🚖`,
}

const STATIC_NEW_RU = (name, greeting) =>
  `${greeting}${name ? ', ' + name : ''}! 👋 Добро пожаловать в *еОсакаровка Сервис*!\n\n` +
  `🚖 Просто напишите куда нужно ехать — найдём водителя\n` +
  `🎤 Голосовое сообщение тоже работает\n` +
  `🎁 Каждая *10-я поездка* бесплатная!\n` +
  `💰 По посёлку от *500 тг*, работаем *24/7*`

const STATIC_NEW_KZ = (name, greeting) =>
  `${greeting}${name ? ', ' + name : ''}! 👋 *еОсакаровка Сервис*-ке қош келдіңіз!\n\n` +
  `🚖 Жай қайда бару керек екенін жазыңыз — жүргізуші табамыз\n` +
  `🎁 Әрбір *10-шы сапар* тегін!\n` +
  `💰 Ауылда *500 тг*-дан, тәулік бойы жұмыс істейміз`

// ─── НОВЫЙ КЛИЕНТ ──────────────────────────────────────────────
const newClientGreeting = async (name, firstText) => {
  const tod = getTimeOfDay()
  const lang = detectLanguage(firstText)
  const weather = await getWeather().catch(() => null)
  const weatherStr = formatWeatherForGroq(weather)
  const displayName = fmt(name)
  const staticFallback = lang === 'kz'
    ? STATIC_NEW_KZ(displayName, tod.greeting_kz)
    : STATIC_NEW_RU(displayName, tod.greeting_ru)

  try {
    const system = SYSTEM_CONTEXT + `

Клиент написал ВПЕРВЫЕ. Поприветствуй тепло и расскажи коротко как заказать.

ВРЕМЯ: ${tod.ru}
ИМЯ: ${displayName || 'Клиент'}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
${weatherStr ? 'ПОГОДА (важная, упомяни): ' + weatherStr : ''}

СТРУКТУРА (не более 5-6 строк):
1. Приветствие с именем и временем суток
2. Как заказать — написать адрес куда ехать
3. Голосовое тоже работает
4. Цена от 500 тг, 24/7
5. 10-я поездка бесплатная
6. Призыв написать адрес

ЯЗЫК — СТРОГО ${lang === 'kz' ? 'ТОЛЬКО казахский' : 'ТОЛЬКО русский'}, без единого иностранного слова, 2-3 эмодзи`

    const result = await callClaude({
      system,
      messages: [{ role: 'user', content: `Новый клиент ${displayName || 'Клиент'} написал: "${firstText}"` }],
      maxTokens: 300,
      temperature: 0.7,
    })
    return (result && isCleanText(result)) ? result : staticFallback
  } catch (e) {
    console.error('[greetingService:new]', e.message)
    return staticFallback
  }
}

// ─── ЕЖЕДНЕВНОЕ ПРИВЕТСТВИЕ ────────────────────────────────────
const dailyGreeting = async (name, firstText, tripCount) => {
  const tod = getTimeOfDay()
  const lang = detectLanguage(firstText)
  const weather = await getWeather().catch(() => null)
  const weatherStr = formatWeatherForGroq(weather)
  const nextFree = 10 - (tripCount % 10)
  const isLoyal = tripCount >= 3
  const displayName = fmt(name)

  const staticFallback = isLoyal
    ? (STATIC_GREET_LOYAL[tod.key] || STATIC_GREET_LOYAL.day)(displayName, tripCount)
    : (STATIC_GREET[tod.key] || STATIC_GREET.day)(displayName)

  const topics = [
    tripCount > 0 && nextFree <= 2 ? `до бесплатной поездки осталось всего ${nextFree}` : null,
    isLoyal ? `постоянный клиент, уже ${tripCount} поездок` : null,
    weatherStr || null,
  ].filter(Boolean)
  const topic = topics[Math.floor(Math.random() * Math.max(topics.length, 1))] || null

  try {
    const system = SYSTEM_CONTEXT + `

Постоянный клиент написал сегодня первый раз. Поприветствуй коротко и тепло.

ВРЕМЯ: ${tod.ru} (${tod.greeting_ru})
ИМЯ: ${displayName || 'Клиент'}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
${topic ? 'КОНТЕКСТ (упомяни естественно): ' + topic : 'Просто тёплое приветствие'}

ТРЕБОВАНИЯ:
— Ровно 1-2 предложения, 1-2 эмодзи
— Учти время суток в приветствии
— Закончи ОДНОЙ из фраз: "Куда едем?", "Куда везти?", "Напишите адрес", "Куда нужно?"
— ЗАПРЕЩЕНО: "Где вас подвезти", "Где вас подвести", любые английские слова
— СТРОГО ${lang === 'kz' ? 'ТОЛЬКО казахский' : 'ТОЛЬКО русский'}, без смешивания языков
— Каждый раз новый вариант, не повторяй`

    const result = await callClaude({
      system,
      messages: [{ role: 'user', content: `Клиент ${displayName || 'Клиент'} написал: "${firstText}"` }],
      maxTokens: 120,
      temperature: 0.9,
    })
    return (result && isCleanText(result)) ? result : staticFallback
  } catch (e) {
    console.error('[greetingService:daily]', e.message)
    return staticFallback
  }
}

// ─── ПРОЩАНИЕ ПОСЛЕ ПОЕЗДКИ ────────────────────────────────────
const smartFarewell = async (name, lang, tripCount, isFree) => {
  const tod = getTimeOfDay()
  const nextFree = 10 - (tripCount % 10)
  const weather = await getWeather().catch(() => null)
  const weatherStr = formatWeatherForGroq(weather)
  const displayName = fmt(name)

  const staticFallback = isFree
    ? `🎁 Поездка была бесплатной — поздравляем${displayName ? ', ' + displayName : ''}! Спасибо что с нами. 🙏`
    : nextFree <= 2
      ? `🙏 Спасибо${displayName ? ', ' + displayName : ''}! До бесплатной поездки осталось всего ${nextFree}. 🎁`
      : `🙏 Спасибо${displayName ? ', ' + displayName : ''}! Удачного дня! 😊`

  try {
    const system = SYSTEM_CONTEXT + `

Поездка завершена. Попрощайся тепло.

ВРЕМЯ: ${tod.ru}
ИМЯ: ${displayName || 'Клиент'}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
${isFree ? 'ПОЕЗДКА БЫЛА БЕСПЛАТНОЙ — поздравь!' : ''}
${nextFree <= 2 ? `ДО БЕСПЛАТНОЙ: ${nextFree} поездки — намекни` : ''}
${weatherStr ? 'ПОГОДА ВАЖНАЯ: ' + weatherStr + ' — пожелай добраться безопасно' : ''}

ТРЕБОВАНИЯ:
— 1-2 предложения максимум, 1 эмодзи
— СТРОГО ${lang === 'kz' ? 'ТОЛЬКО казахский' : 'ТОЛЬКО русский'} — НОЛЬ иностранных слов
— Тёплое, живое прощание`

    const result = await callClaude({
      system,
      messages: [{ role: 'user', content: `Завершилась поездка клиента ${displayName || 'Клиент'}` }],
      maxTokens: 100,
      temperature: 0.9,
    })
    return (result && isCleanText(result)) ? result : staticFallback
  } catch (e) {
    console.error('[greetingService:farewell]', e.message)
    return staticFallback
  }
}

module.exports = { newClientGreeting, dailyGreeting, smartFarewell, detectLanguage, getTimeOfDay }
