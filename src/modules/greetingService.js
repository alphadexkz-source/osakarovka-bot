'use strict'
const Groq = require('groq-sdk');
const { getWeather, formatWeatherForGroq } = require('./weatherService');
const { SYSTEM_CONTEXT } = require('./prompts');

let groq = null;
const getGroq = () => { if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); return groq; };

const getTimeOfDay = () => {
  const h = new Date(Date.now() + 5 * 3600_000).getUTCHours(); // UTC+5 Almaty
  if (h >= 6  && h < 12) return { key:'morning', ru:'утро',  greeting_ru:'Доброе утро',  greeting_kz:'Қайырлы таң'  };
  if (h >= 12 && h < 17) return { key:'day',     ru:'день',  greeting_ru:'Добрый день',  greeting_kz:'Қайырлы күн'  };
  if (h >= 17 && h < 22) return { key:'evening', ru:'вечер', greeting_ru:'Добрый вечер', greeting_kz:'Қайырлы кеш'  };
  return                        { key:'night',   ru:'ночь',  greeting_ru:'Доброй ночи',  greeting_kz:'Қайырлы түн'  };
};

const detectLanguage = (text) => {
  if (!text) return 'ru';
  const kzWords = ['сәлем','салем','қайырлы','рахмет','жақсы','иә','жоқ','қайда','үйге','жұмыс','мектеп','дүкен','аурухана','болыңыз'];
  return kzWords.some(w => (text||'').toLowerCase().includes(w)) ? 'kz' : 'ru';
};

// Проверка: нет ли в ответе иностранных слов (немецкий, английский и т.д.)
const isCleanText = (text) => {
  if (!text) return false;
  const latinWords = (text.match(/\b[a-zA-Z]{3,}\b/g) || []);
  return latinWords.length === 0;
};

// ─── СТАТИЧЕСКИЕ ШАБЛОНЫ (резерв при сбое Groq) ───────────────
const STATIC_GREET = {
  morning: (name) => `☀️ Доброе утро, ${name}! Куда едем сегодня? 🚖`,
  day:     (name) => `👋 Добрый день, ${name}! Напишите куда нужно — найдём водителя. 🚖`,
  evening: (name) => `🌆 Добрый вечер, ${name}! Куда везти? 🚖`,
  night:   (name) => `🌙 Ночной рейс, ${name}? Напишите адрес — водитель найдётся! 🚖`,
};

const STATIC_GREET_LOYAL = {
  morning: (name, n)  => `☀️ Доброе утро, ${name}! Уже ${n} поездок — вы постоянный клиент 😊\nКуда сегодня? 🚖`,
  day:     (name, n)  => `👋 Добрый день, ${name}! ${n} поездок с нами — спасибо за доверие! Куда едем? 🚖`,
  evening: (name)     => `🌆 Добрый вечер, ${name}! Рады видеть. Куда везти? 🚖`,
  night:   (name)     => `🌙 Доброй ночи, ${name}! Куда нужно? Напишите адрес. 🚖`,
};

const STATIC_NEW_RU = (name, greeting) =>
  `${greeting}, ${name}! 👋 Добро пожаловать в *еОсакаровка Сервис*!\n\n` +
  `🚖 Просто напишите куда нужно ехать — найдём водителя\n` +
  `🎤 Голосовое сообщение тоже работает\n` +
  `🎁 Каждая *10-я поездка* бесплатная!\n` +
  `💰 По посёлку от *500 тг*, работаем *24/7*`;

const STATIC_NEW_KZ = (name, greeting) =>
  `${greeting}, ${name}! 👋 *еОсакаровка Сервис*-ке қош келдіңіз!\n\n` +
  `🚖 Жай қайда бару керек екенін жазыңыз — жүргізуші табамыз\n` +
  `🎁 Әрбір *10-шы сапар* тегін!\n` +
  `💰 Ауылда *500 тг*-дан, тәулік бойы жұмыс істейміз`;

// ─── НОВЫЙ КЛИЕНТ ─────────────────────────────────────────────
const newClientGreeting = async (name, firstText) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather().catch(() => null);
  const weatherStr = formatWeatherForGroq(weather);
  const staticFallback = lang === 'kz'
    ? STATIC_NEW_KZ(name, tod.greeting_kz)
    : STATIC_NEW_RU(name, tod.greeting_ru);

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: SYSTEM_CONTEXT + `\n\nНовый клиент пишет ПЕРВЫЙ РАЗ. Напиши приветствие + краткую инструкцию.
ВРЕМЯ: ${tod.ru}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${weatherStr ? 'ВАЖНАЯ ПОГОДА: ' + weatherStr : ''}

ОБЯЗАТЕЛЬНО ВКЛЮЧИ:
- Как заказать (написать адрес куда ехать)
- Голосовое тоже работает
- Каждая 10-я поездка бесплатная
- Цена от 500 тг, 24/7

СТРОГИЕ ПРАВИЛА:
- ТОЛЬКО ${lang === 'kz' ? 'казахский' : 'русский'} язык — НОЛЬ других языков, НОЛЬ английских/немецких/любых иностранных слов
- Максимум 6 строк, 2-3 эмодзи
- ${weatherStr ? 'Упомяни погоду' : 'Погода обычная — не упоминай'}`
      }, { role: 'user', content: `Новый клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 250, temperature: 0.7,
    });
    const result = r.choices[0]?.message?.content?.trim();
    // Если Groq вернул иностранные слова — используем статику
    return (result && isCleanText(result)) ? result : staticFallback;
  } catch(e) {
    console.error('[greetingService:new]', e.message);
    return staticFallback;
  }
};

// ─── ЕЖЕДНЕВНОЕ ПРИВЕТСТВИЕ ────────────────────────────────────
const dailyGreeting = async (name, firstText, tripCount) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather().catch(() => null);
  const weatherStr = formatWeatherForGroq(weather);
  const nextFree = 10 - (tripCount % 10);
  const isLoyal = tripCount >= 3;

  // Статический fallback — всегда гарантированно чистый
  const staticFallback = isLoyal
    ? (STATIC_GREET_LOYAL[tod.key] || STATIC_GREET_LOYAL.day)(name, tripCount)
    : (STATIC_GREET[tod.key] || STATIC_GREET.day)(name);

  // Дополнительный контекст для Groq
  const topics = [
    tripCount > 0 && nextFree <= 2 ? `до бесплатной поездки осталось ${nextFree}` : null,
    isLoyal ? `постоянный клиент, ${tripCount} поездок` : null,
    weatherStr || null,
  ].filter(Boolean);
  const topic = topics[Math.floor(Math.random() * Math.max(topics.length, 1))] || null;

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: SYSTEM_CONTEXT + `\n\nПоприветствуй вернувшегося клиента — сегодня написал впервые.
ВРЕМЯ: ${tod.ru} (${tod.greeting_ru})
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${topic ? 'ЧТО УПОМЯНУТЬ: ' + topic : 'Просто тёплое, короткое приветствие'}

СТРОГИЕ ПРАВИЛА:
- ТОЛЬКО ${lang === 'kz' ? 'казахский' : 'русский'} язык — НОЛЬ иностранных слов любого другого языка
- Ровно 1-2 предложения
- 1-2 уместных эмодзи
- В конце намекни написать адрес
- Каждый раз новый вариант, не шаблонно
- ${weatherStr ? 'Упомяни погоду — она важная' : 'Погоду не упоминай'}`
      }, { role: 'user', content: `Клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 100, temperature: 0.9,
    });
    const result = r.choices[0]?.message?.content?.trim();
    return (result && isCleanText(result)) ? result : staticFallback;
  } catch(e) {
    console.error('[greetingService:daily]', e.message);
    return staticFallback;
  }
};

// ─── ПРОЩАНИЕ ПОСЛЕ ПОЕЗДКИ ───────────────────────────────────
const smartFarewell = async (name, lang, tripCount, isFree) => {
  const tod = getTimeOfDay();
  const nextFree = 10 - (tripCount % 10);
  const weather = await getWeather().catch(() => null);
  const weatherStr = formatWeatherForGroq(weather);

  const staticFallback = isFree
    ? `🎁 Поездка была бесплатной — поздравляем, ${name}! Спасибо что с нами. 🙏`
    : nextFree <= 2
      ? `🙏 Спасибо, ${name}! До бесплатной поездки осталось всего ${nextFree}. 🎁`
      : `🙏 Спасибо, ${name}! Удачного дня! 😊`;

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: SYSTEM_CONTEXT + `\n\nПоездка завершена. Попрощайся тепло.
ВРЕМЯ: ${tod.ru}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${isFree ? 'ПОЕЗДКА БЫЛА БЕСПЛАТНОЙ — поздравь!' : ''}
${nextFree <= 2 ? `ДО БЕСПЛАТНОЙ: ${nextFree} поездки — намекни` : ''}
${weatherStr ? 'ПОГОДА ВАЖНАЯ: ' + weatherStr + ' — пожелай добраться безопасно' : ''}

СТРОГИЕ ПРАВИЛА:
- ТОЛЬКО ${lang === 'kz' ? 'казахский' : 'русский'} — НОЛЬ иностранных слов
- 1-2 предложения максимум, 1 эмодзи`
      }, { role: 'user', content: `Завершилась поездка клиента ${name}` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 100, temperature: 0.9,
    });
    const result = r.choices[0]?.message?.content?.trim();
    return (result && isCleanText(result)) ? result : staticFallback;
  } catch(e) {
    console.error('[greetingService:farewell]', e.message);
    return staticFallback;
  }
};

module.exports = { newClientGreeting, dailyGreeting, smartFarewell, detectLanguage, getTimeOfDay };
