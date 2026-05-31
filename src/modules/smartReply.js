const Groq = require('groq-sdk');
const { getWeather, formatWeatherForGroq } = require('./weatherService');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

const clientCache = new Map();

// Умный ответ для КЛИЕНТА
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
ПОГОДА СЕЙЧАС: ${weatherStr || 'нет данных'}
ИНФОРМАЦИЯ:
- Работаем круглосуточно 24/7
- По посёлку от 500 тг (день), ночной тариф с 23:00 до 07:00
- До ЖД станции 1000 тг, до Элеватора 700 тг
- Оплата наличными, каждая 10-я поездка бесплатная 🎁
ПРАВИЛА:
- Коротко — 2-3 предложения
- Язык клиента: казахский → казахский, русский → русский
- В конце предлагай написать адрес
- Будь дружелюбным, используй эмодзи умеренно
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

// Умный ответ для ВОДИТЕЛЯ — живой бот с полным контекстом
const getGroqDriverReply = async (text, driverName, stats, extra) => {
  const lo = (text||'').toLowerCase().trim();
  if (!lo || lo.length < 2) return null;
  try {
    const weather = await getWeather().catch(() => null);
    const weatherStr = formatWeatherForGroq(weather);
    const h = new Date().getHours();
    const tod = h>=6&&h<12?'утро':h>=12&&h<17?'день':h>=17&&h<22?'вечер':'ночь';

    const queueInfo  = extra?.queuePos  ? `Позиция в очереди: ${extra.queuePos}-й из ${extra.queueTotal} водителей онлайн.` : '';
    const statsInfo  = stats ? `Сегодня: ${stats.completed||0} поездок, ${stats.earned||0} тг заработано.` : '';
    const statusInfo = extra?.status === 'online' ? 'Водитель сейчас ОНЛАЙН (на линии).' : 'Водитель сейчас ОФЛАЙН.';

    const r = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — умный помощник и друг водителя такси в *еОсакаровка Сервис*, посёлок Осакаровка, Казахстан.
Водителя зовут: ${driverName || 'водитель'}.
ВРЕМЯ СУТОК: ${tod}
ПОГОДА: ${weatherStr || 'нет данных'}
СТАТУС: ${statusInfo}
${queueInfo}
${statsInfo}

КОМАНДЫ ВОДИТЕЛЯ (объясняй если спрашивает):
- *На линию* / *С линии* — выйти/уйти с работы
- *Принял* — принять заказ
- *Прибыл* — приехал к клиенту
- *Свободен* — поездка завершена
- *Ложный* — клиента нет на месте (штраф клиенту)
- *Статистика* — заработок и поездки
- *Очередь* — позиция в очереди
- *Изменить* — изменить данные авто

УЛИЦЫ ОСАКАРОВКИ (для маршрутов):
Целинная, Школьная, Советская, Гагарина, Молодёжная, Железнодорожная, Элеваторная, Луговая, Комсомольская, Октябрьская, Первомайская, Пионерская, Достык, Болашак, Абая, Мира, Победы, Ленина, Степная, Садовая

ПРАВИЛА ОТВЕТА:
- Отвечай как живой друг-диспетчер, тепло и по-человечески
- Учитывай время суток и погоду в ответе
- Если спрашивает маршрут — опиши улицы
- Если скучает/ждёт — поддержи, упомяни погоду и очередь
- Если жалуется — посочувствуй и помоги
- Если хвалится — порадуйся за него
- Коротко — максимум 3 предложения
- Язык: казахский → казахский, русский → русский
- НЕ повторяй одно и то же каждый раз`
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile', max_tokens: 200, temperature: 0.85,
    });
    return r.choices[0]?.message?.content?.trim() || null;
  } catch(e) { console.error('[smartReply:driver]', e.message); return null; }
};

module.exports = { getGroqReply, getGroqDriverReply };
