const Groq = require('groq-sdk');
const { getWeather, formatWeatherForGroq } = require('./weatherService');

let groq = null;
const getGroq = () => { if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); return groq; };

const getTimeOfDay = () => {
  const h = new Date().getHours();
  if (h >= 6  && h < 12) return { ru:'утро',   greeting_ru:'Доброе утро',   greeting_kz:'Қайырлы таң' };
  if (h >= 12 && h < 17) return { ru:'день',   greeting_ru:'Добрый день',   greeting_kz:'Қайырлы күн' };
  if (h >= 17 && h < 22) return { ru:'вечер',  greeting_ru:'Добрый вечер',  greeting_kz:'Қайырлы кеш' };
  return                         { ru:'ночь',   greeting_ru:'Доброй ночи',   greeting_kz:'Қайырлы түн' };
};

const detectLanguage = (text) => {
  if (!text) return 'ru';
  const kzWords = ['сәлем','салем','қайырлы','рахмет','жақсы','иә','жоқ','қайда','үйге','жұмыс','мектеп','дүкен','аурухана','болыңыз'];
  return kzWords.some(w => (text||'').toLowerCase().includes(w)) ? 'kz' : 'ru';
};

const newClientGreeting = async (name, firstText) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather().catch(() => null);
  // Погода только если плохая
  const weatherStr = formatWeatherForGroq(weather);

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис* в посёлке Осакаровка, Казахстан.
Клиент обращается ВПЕРВЫЕ. Напиши тёплое приветствие + краткую инструкцию.
ВРЕМЯ: ${tod.ru}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${weatherStr ? 'ВАЖНАЯ ПОГОДА: ' + weatherStr : ''}

ИНСТРУКЦИЯ (включи кратко):
- Напиши адрес куда ехать — найдём водителя
- Голосовое сообщение тоже работает
- Каждая 10-я поездка бесплатная
- По посёлку от 500 тг, работаем 24/7

ПРАВИЛА:
- СТРОГО один язык: казахский — ТОЛЬКО казахский, русский — ТОЛЬКО русский, НИКОГДА не мешай языки, НИКАКОГО английского
- ${weatherStr ? 'Упомяни погоду — она важная сегодня' : 'Погода обычная — не упоминай её'}
- Тепло и коротко — максимум 6 строк`
      }, { role: 'user', content: `Новый клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 250, temperature: 0.8,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:new]', e.message); return null; }
};

const dailyGreeting = async (name, firstText, tripCount) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather().catch(() => null);
  // Погода только если важная
  const weatherStr = formatWeatherForGroq(weather);
  const nextFree = 10 - (tripCount % 10);

  // Разнообразные темы для приветствия (без погоды если обычная)
  const topics = [
    tripCount > 0 && nextFree <= 3 ? `близко к бесплатной поездке — осталось ${nextFree}` : null,
    tripCount > 0 ? `уже ${tripCount} поездок — постоянный клиент` : null,
    weatherStr || null,
    null, // просто доброе приветствие
  ].filter(Boolean);
  const topic = topics[Math.floor(Math.random() * Math.max(topics.length, 1))] || null;

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис*.
Поприветствуй постоянного клиента — сегодня написал впервые.
ВРЕМЯ: ${tod.ru} (${tod.greeting_ru})
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${topic ? 'ЧТО УПОМЯНУТЬ: ' + topic : 'Просто тёплое приветствие без лишнего'}

ПРАВИЛА:
- Если казахский — на казахском
- СТРОГО 2 предложения максимум
- Учитывай время суток
- В конце намекни написать адрес
- КАЖДЫЙ РАЗ РАЗНОЕ — не шаблонно
- Без упоминания погоды если не указана в "ЧТО УПОМЯНУТЬ"`
      }, { role: 'user', content: `Клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 100, temperature: 0.95,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:daily]', e.message); return null; }
};

const smartFarewell = async (name, lang, tripCount, isFree) => {
  const tod = getTimeOfDay();
  const nextFree = 10 - (tripCount % 10);
  const weather = await getWeather().catch(() => null);
  const weatherStr = formatWeatherForGroq(weather);

  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис*.
Поездка завершена. Попрощайся тепло.
ВРЕМЯ: ${tod.ru}
ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'}
ИМЯ: ${name}
${isFree ? 'ПОЕЗДКА БЫЛА БЕСПЛАТНОЙ — поздравь!' : ''}
${nextFree <= 2 ? `ДО БЕСПЛАТНОЙ: ${nextFree} поездки — намекни` : ''}
${weatherStr ? 'ПОГОДА ВАЖНАЯ: ' + weatherStr + ' — пожелай добраться безопасно' : ''}

ПРАВИЛА:
- 1-2 предложения максимум
- Каждый раз уникально
- Без упоминания погоды если не указана выше`
      }, { role: 'user', content: `Завершилась поездка клиента ${name}` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 100, temperature: 0.95,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:farewell]', e.message); return null; }
};

module.exports = { newClientGreeting, dailyGreeting, smartFarewell, detectLanguage, getTimeOfDay };
