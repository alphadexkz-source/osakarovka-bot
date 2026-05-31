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
  const kzWords = ['сәлем','салем','қайырлы','рахмет','жақсы','иә','жоқ','қайда','үйге','жұмыс','мектеп','дүкен','аурухана','сәлеметсіз','болыңыз'];
  return kzWords.some(w => text.toLowerCase().includes(w)) ? 'kz' : 'ru';
};
const newClientGreeting = async (name, firstText) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather();
  const weatherStr = formatWeatherForGroq(weather);
  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис* в посёлке Осакаровка, Казахстан.
Клиент обращается ВПЕРВЫЕ. Напиши тёплое приветствие + краткую инструкцию.
ВРЕМЯ: ${tod.ru} | ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'} | ИМЯ: ${name}
ПОГОДА: ${weatherStr || 'нет данных'}
ИНСТРУКЦИЯ (включи кратко):
• Напиши адрес куда ехать — найдём водителя
• Голосовое сообщение тоже работает 🎤
• Каждая 10-я поездка бесплатная 🎁
• По посёлку от 500 тг, до вокзала 1000 тг
• Работаем 24/7
ПРАВИЛА: если казахский — пиши на казахском. Упомяни погоду если плохая. Тепло, коротко — максимум 8 строк.`
      }, { role: 'user', content: `Новый клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 300, temperature: 0.8,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:new]', e.message); return null; }
};
const dailyGreeting = async (name, firstText, tripCount) => {
  const tod = getTimeOfDay();
  const lang = detectLanguage(firstText);
  const weather = await getWeather();
  const weatherStr = formatWeatherForGroq(weather);
  const nextFree = 10 - (tripCount % 10);
  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис* в Осакаровке.
Поприветствуй постоянного клиента — сегодня написал впервые.
ВРЕМЯ: ${tod.ru} (${tod.greeting_ru}) | ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'} | ИМЯ: ${name}
ПОГОДА: ${weatherStr || 'нет данных'} | ПОЕЗДОК ВСЕГО: ${tripCount} | ДО БЕСПЛАТНОЙ: ${nextFree}
ПРАВИЛА:
- Если казахский — на казахском
- 2-3 строки максимум
- Учитывай время суток
- Если плохая погода — упомяни что лучше на такси
- Если до бесплатной 1-2 поездки — намекни
- КАЖДЫЙ РАЗ РАЗНОЕ — не повторяйся!
- В конце намекни написать адрес`
      }, { role: 'user', content: `Клиент ${name} написал: "${firstText}"` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 150, temperature: 0.9,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:daily]', e.message); return null; }
};
const smartFarewell = async (name, lang, tripCount, isFree) => {
  const tod = getTimeOfDay();
  const nextFree = 10 - (tripCount % 10);
  const weather = await getWeather();
  const weatherStr = formatWeatherForGroq(weather);
  try {
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — дружелюбный диспетчер такси *еОсакаровка Сервис*.
Поездка завершена. Попрощайся тепло и лично.
ВРЕМЯ: ${tod.ru} | ЯЗЫК: ${lang === 'kz' ? 'казахский' : 'русский'} | ИМЯ: ${name}
БЕСПЛАТНАЯ: ${isFree ? 'да' : 'нет'} | ВСЕГО ПОЕЗДОК: ${tripCount} | ДО БЕСПЛАТНОЙ: ${nextFree}
ПОГОДА: ${weatherStr || 'нет данных'}
ПРАВИЛА: поблагодари, если бесплатная — поздравь, если 1-2 до бесплатной — намекни, учитывай время суток, если плохая погода — пожелай добраться безопасно. 2-3 строки. Каждый раз уникально.`
      }, { role: 'user', content: `Завершилась поездка клиента ${name}` }],
      model: 'llama-3.3-70b-versatile', max_tokens: 150, temperature: 0.9,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[greetingService:farewell]', e.message); return null; }
};
module.exports = { newClientGreeting, dailyGreeting, smartFarewell, detectLanguage, getTimeOfDay };
