const Groq = require('groq-sdk');
const { getWeather, formatWeatherForGroq, formatWeatherBrief } = require('./weatherService');
const { SYSTEM_CONTEXT } = require('./prompts');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

// Per-phone Groq rate limit: не более 5 вызовов в минуту
const _groqCounts = new Map();
const isGroqRateLimited = (phone) => {
  if (!phone) return false;
  const now = Date.now();
  const rec = _groqCounts.get(phone);
  if (!rec || now > rec.resetAt) {
    _groqCounts.set(phone, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  if (rec.count >= 5) return true;
  rec.count++;
  return false;
};

const getGroqReply = async (text, phone) => {
  if (isGroqRateLimited(phone)) return null;
  const lo = (text||'').toLowerCase().trim();
  if (!lo || lo.length < 2) return null;

  try {
    const weather = await getWeather().catch(() => null);
    const weatherStr = formatWeatherForGroq(weather);
    const h = new Date().getHours();
    const tod = h>=6&&h<12?'утро':h>=12&&h<17?'день':h>=17&&h<22?'вечер':'ночь';

    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: SYSTEM_CONTEXT + `

Сейчас: ${tod} в Осакаровке.
${weatherStr ? '⚠️ Погода: ' + weatherStr : ''}
Отвечай тепло, коротко (максимум 2–3 предложения), по делу.
Используй 1–2 эмодзи уместно.`
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile',
      max_tokens: 220,
      temperature: 0.75,
    });

    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.error('[smartReply:client]', e.message);
    return null;
  }
};

const getGroqDriverReply = async (text, driverName, stats, extra, phone) => {
  if (isGroqRateLimited(phone)) return null;
  const lo = (text||'').toLowerCase().trim();
  if (!lo || lo.length < 2) return null;
  try {
    const weather = await getWeather().catch(() => null);
    const weatherBrief = formatWeatherBrief(weather);
    const weatherImportant = formatWeatherForGroq(weather);
    const h = new Date().getHours();
    const tod = h>=6&&h<12?'утро':h>=12&&h<17?'день':h>=17&&h<22?'вечер':'ночь';
    const queueInfo = extra?.queuePos ? 'Позиция в очереди: ' + extra.queuePos + '-й из ' + extra.queueTotal + ' водителей.' : '';
    const statsInfo = stats ? 'Сегодня выполнено: ' + (stats.completed||0) + ' поездок, заработано: ' + Number(stats.earned||0).toLocaleString() + ' тг.' : '';
    const statusLabel = extra?.status === 'online' ? '🟢 На линии' : extra?.status === 'busy' ? '🔴 В поездке' : '⚫ Офлайн';
    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: SYSTEM_CONTEXT + '\n\n' +
          'Ты общаешься с водителем, не с клиентом.\n' +
          'Водитель: ' + (driverName||'водитель') + '. Статус: ' + statusLabel + '.\n' +
          'Время суток: ' + tod + '.\n' +
          (weatherBrief ? 'Погода: ' + weatherBrief + '.\n' : '') +
          (queueInfo ? queueInfo + '\n' : '') +
          (statsInfo ? statsInfo + '\n' : '') +
          '\nПРАВИЛА:\n' +
          '• Общайся тепло, по-братски, уважительно\n' +
          '• Максимум 2 предложения\n' +
          '• Используй 1 эмодзи если уместно\n' +
          '• Отвечай на языке водителя\n' +
          '• Если водитель жалуется на усталость — поддержи\n' +
          '• Если спрашивает про заказы — ответь на основе статистики\n' +
          (weatherImportant ? '• Погода важная (' + weatherImportant + ') — упомяни если актуально\n' : '')
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 200, temperature: 0.85,
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
