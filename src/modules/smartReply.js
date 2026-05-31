const Groq = require('groq-sdk');
const { getWeather, formatWeatherForGroq, formatWeatherBrief } = require('./weatherService');

let groq = null;
const getGroq = () => { if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY }); return groq; };
const clientCache = new Map();

const getGroqReply = async (text) => {
  const lo = (text||'').toLowerCase().trim();
  if (!lo || lo.length < 2) return null;
  if (clientCache.has(lo)) return clientCache.get(lo);
  try {
    const weather = await getWeather().catch(() => null);
    const weatherStr = formatWeatherForGroq(weather);
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — виртуальный диспетчер такси *еОсакаровка Сервис* в посёлке Осакаровка, Казахстан.
${weatherStr ? 'ВАЖНАЯ ПОГОДА СЕЙЧАС: ' + weatherStr : ''}
ИНФОРМАЦИЯ:
- Работаем круглосуточно 24/7
- По посёлку от 500 тг, ночной тариф с 23:00 до 07:00
- До ЖД станции 1000 тг, до Элеватора 700 тг
- Оплата наличными, каждая 10-я поездка бесплатная
ПРАВИЛА:
- Коротко — 2-3 предложения
- Язык клиента: казахский — казахский, русский — русский
- В конце предлагай написать адрес
- Будь дружелюбным
- ${weatherStr ? 'Упомяни важную погоду если уместно' : 'Погода обычная — не упоминай её'}
- Не придумывай информацию которой нет выше`
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 150, temperature: 0.7,
    });
    const reply = r.choices[0]?.message?.content?.trim();
    if (!reply) return null;
    clientCache.set(lo, reply);
    setTimeout(() => clientCache.delete(lo), 600000);
    return reply;
  } catch(e) { console.error('[smartReply:client]', e.message); return null; }
};

const getGroqDriverReply = async (text, driverName, stats, extra) => {
  const lo = (text||'').toLowerCase().trim();
  if (!lo || lo.length < 2) return null;
  try {
    const weather = await getWeather().catch(() => null);
    const weatherBrief = formatWeatherBrief(weather);
    const weatherImportant = formatWeatherForGroq(weather);
    const h = new Date().getHours();
    const tod = h>=6&&h<12?'утро':h>=12&&h<17?'день':h>=17&&h<22?'вечер':'ночь';
    const queueInfo = extra?.queuePos ? `Позиция в очереди: ${extra.queuePos}-й из ${extra.queueTotal} водителей.` : '';
    const statsInfo = stats ? `Сегодня: ${stats.completed||0} поездок, ${stats.earned||0} тг.` : '';
    const statusInfo = extra?.status === 'online' ? 'Водитель ОНЛАЙН.' : 'Водитель ОФЛАЙН.';
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — умный помощник водителя такси в *еОсакаровка Сервис*, посёлок Осакаровка.
Водителя зовут: ${driverName || 'водитель'}.
ВРЕМЯ: ${tod}
${weatherBrief ? 'ПОГОДА: ' + weatherBrief : ''}
${statusInfo}
${queueInfo}
${statsInfo}
ПРАВИЛА:
- Отвечай тепло и по-человечески как друг
- Учитывай время суток
- ${weatherImportant ? 'Погода важная — можешь упомянуть: ' + weatherImportant : 'Погода обычная — не акцентируй на ней'}
- Коротко — максимум 2 предложения
- Язык: казахский — казахский, русский — русский
- Каждый раз разный ответ`
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 150, temperature: 0.9,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[smartReply:driver]', e.message); return null; }
};

module.exports = { getGroqReply, getGroqDriverReply };
