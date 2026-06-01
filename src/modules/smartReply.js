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
        content: 'Ты — виртуальный диспетчер такси *еОсакаровка Сервис* в посёлке Осакаровка, Казахстан.\n' +
          (weatherStr ? 'ВАЖНАЯ ПОГОДА: ' + weatherStr + '\n' : '') +
          'ИНФОРМАЦИЯ:\n- Работаем 24/7\n- По посёлку от 500 тг\n- До ЖД станции 1000 тг, до Элеватора 700 тг\n- Оплата наличными, каждая 10-я поездка бесплатная\n' +
          'ПРАВИЛА:\n- Коротко — 2-3 предложения\n- Язык клиента: казахский — казахский, русский — русский\n- В конце предлагай написать адрес\n' +
          (weatherStr ? '- Упомяни погоду если уместно\n' : '- Погода обычная — не упоминай\n')
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
    const queueInfo = extra?.queuePos ? 'Позиция: ' + extra.queuePos + '-й из ' + extra.queueTotal + ' водителей.' : '';
    const statsInfo = stats ? 'Сегодня: ' + (stats.completed||0) + ' поездок, ' + (stats.earned||0) + ' тг.' : '';
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: 'Ты — умный помощник водителя такси в *еОсакаровка Сервис*, Осакаровка.\n' +
          'Водителя зовут: ' + (driverName||'водитель') + '.\n' +
          'ВРЕМЯ: ' + tod + '\n' +
          (weatherBrief ? 'ПОГОДА: ' + weatherBrief + '\n' : '') +
          (extra?.status === 'online' ? 'Водитель ОНЛАЙН.\n' : 'Водитель ОФЛАЙН.\n') +
          (queueInfo ? queueInfo + '\n' : '') +
          (statsInfo ? statsInfo + '\n' : '') +
          'ПРАВИЛА:\n- Тепло и по-человечески\n- Максимум 2 предложения\n- Язык клиента\n' +
          (weatherImportant ? '- Погода важная: ' + weatherImportant + '\n' : '- Погода обычная — не акцентируй\n')
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 150, temperature: 0.9,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[smartReply:driver]', e.message); return null; }
};

const parseScheduleTime = async (text) => {
  const lo = (text||'').toLowerCase().trim();
  if (['сейчас','немедленно','прямо сейчас','щас'].some(w => lo.includes(w))) return 'сейчас';
  if (/^\d{1,2}$/.test(lo)) return 'сегодня в ' + lo.padStart(2,'0') + ':00';
  if (/\d{1,2}:\d{2}/.test(lo)) return text.trim();
  try {
    const now = new Date();
    const h = now.getHours();
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: 'Ты парсишь время из текста клиента такси. Сейчас ' + now.toLocaleString('ru-RU',{timeZone:'Asia/Almaty'}) + '.\n' +
          'Верни ТОЛЬКО строку времени — без лишних слов:\n' +
          'сейчас / сегодня в ЧЧ:ММ / завтра в ЧЧ:ММ\n\n' +
          'Примеры:\n' +
          '"в 8 утра" → сегодня в 08:00\n' +
          '"завтра утром" → завтра в 08:00\n' +
          '"после обеда" → сегодня в 14:00\n' +
          '"вечером" → сегодня в 18:00\n' +
          '"ночью" → сегодня в 22:00\n' +
          '"через час" → сегодня в ' + String(h+1).padStart(2,'0') + ':00\n' +
          '"9" → сегодня в 09:00\n' +
          'Если непонятно → сейчас'
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 20, temperature: 0,
    });
    return r.choices[0]?.message?.content?.trim() || text;
  } catch(e) { return text; }
};

module.exports = { getGroqReply, getGroqDriverReply, parseScheduleTime };
