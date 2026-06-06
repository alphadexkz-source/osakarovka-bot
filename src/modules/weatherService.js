const https = require('https');
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const CITY = 'Osakarovka,KZ';
let cache = null, cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;

const getWeather = async () => {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  if (!WEATHER_API_KEY) return null;
  try {
    const data = await httpGet(`https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${CITY}&lang=ru`);
    const w = data.current;
    cache = {
      temp: Math.round(w.temp_c),
      feels: Math.round(w.feelslike_c),
      condition: w.condition.text,
      wind: Math.round(w.wind_kph),
      humidity: w.humidity,
      isRain: w.condition.text.toLowerCase().includes('дожд') || w.precip_mm > 0.5,
      isSnow: w.condition.text.toLowerCase().includes('снег'),
      isWind: w.wind_kph > 35,
      isCold: w.temp_c < -15,
      isHot: w.temp_c > 35,
      isNormal: w.temp_c >= -5 && w.temp_c <= 30 && w.wind_kph <= 35 && w.precip_mm === 0,
    };
    cacheTime = Date.now();
    return cache;
  } catch(e) { console.error('[weatherService]', e.message); return null; }
};

const weatherIcon = (w) => {
  if (!w) return '🌡';
  if (w.isSnow) return '❄️';
  if (w.isRain) return '🌧';
  if (w.isCold) return '🥶';
  if (w.isHot)  return '🔥';
  if (w.isWind) return '💨';
  return '☀️';
};

// Полная погода для команды «погода» — всегда отображается
const formatWeatherFull = (w) => {
  if (!w) return null;
  const icon = weatherIcon(w);
  let advice = '';
  if (w.isRain)  advice = '☔ Захватите зонт — или возьмите такси!';
  else if (w.isSnow) advice = '🛣 Дорога скользкая. Будьте осторожны!';
  else if (w.isCold) advice = '🧥 Оденьтесь теплее. В такси теплее!';
  else if (w.isHot)  advice = '🌊 Жарко! Такси спасёт от солнца.';
  else if (w.isWind) advice = '💨 Сильный ветер — в такси комфортнее!';
  else advice = '😊 Погода отличная — приятных поездок!';
  return `${icon} *${w.temp}°C*, ощущается как *${w.feels}°C*\n🌤 ${w.condition}\n💧 Влажность: ${w.humidity}%\n💨 Ветер: ${w.wind} км/ч\n\n${advice}`;
};

// Для Groq-промптов — показываем даже при умеренной погоде
const formatWeatherForGroq = (w) => {
  if (!w) return '';
  let advice = '';
  if (w.isRain)  advice = 'Идёт дождь — отличный повод взять такси!';
  else if (w.isSnow) advice = 'Снегопад — дорога скользкая, лучше на такси.';
  else if (w.isCold) advice = 'Сильный мороз на улице — грейтесь в машине!';
  else if (w.isHot)  advice = 'Очень жарко — такси спасёт от жары!';
  else if (w.isWind) advice = 'Сильный ветер — комфортнее в такси.';
  if (!advice) return ''; // обычная погода — не упоминаем в тексте
  return `${w.temp}°C, ${w.condition}. ${advice}`;
};

// Краткая погода для водителя
const formatWeatherBrief = (w) => {
  if (!w) return '';
  const icon = weatherIcon(w);
  return `${icon} ${w.temp}°C, ${w.condition}`;
};

// ─── ПРОГНОЗ НА 7 ДНЕЙ (Open-Meteo, без ключа) ─────────────
// https://open-meteo.com — бесплатно, без регистрации
const LAT = 50.5619, LON = 72.5681;
let forecastCache = null, forecastCacheTime = 0;

const WMO_ICONS = {
  0:'☀️',1:'🌤',2:'⛅',3:'☁️',
  45:'🌫',48:'🌫',
  51:'🌦',53:'🌦',55:'🌧',61:'🌧',63:'🌧',65:'🌧',
  71:'❄️',73:'❄️',75:'❄️',77:'🌨',
  80:'🌦',81:'🌧',82:'⛈',
  85:'❄️',86:'❄️',
  95:'⛈',96:'⛈',99:'⛈',
};
const WMO_TEXT = {
  0:'Ясно',1:'В основном ясно',2:'Переменная облачность',3:'Пасмурно',
  45:'Туман',48:'Туман',
  51:'Лёгкая морось',53:'Морось',55:'Сильная морось',
  61:'Небольшой дождь',63:'Дождь',65:'Ливень',
  71:'Небольшой снег',73:'Снег',75:'Снегопад',77:'Снежная крупа',
  80:'Ливневый дождь',81:'Дождь',82:'Сильный ливень',
  85:'Снежный ливень',86:'Сильный снежный ливень',
  95:'Гроза',96:'Гроза с градом',99:'Сильная гроза',
};

const getWeatherForecast = async (days = 7) => {
  if (forecastCache && Date.now() - forecastCacheTime < 3 * 60 * 60 * 1000) return forecastCache;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,windspeed_10m_max,weathercode` +
      `&current_weather=true&timezone=Asia%2FAlmaty&forecast_days=${days}`;
    const data = await httpGet(url);
    const d = data.daily;
    const current = data.current_weather;
    forecastCache = {
      current: current ? {
        temp: Math.round(current.temperature),
        wind: Math.round(current.windspeed),
        code: current.weathercode,
        icon: WMO_ICONS[current.weathercode] || '🌡',
        text: WMO_TEXT[current.weathercode] || 'Переменная',
      } : null,
      days: d.time.map((date, i) => ({
        date,
        max: Math.round(d.temperature_2m_max[i]),
        min: Math.round(d.temperature_2m_min[i]),
        rain: +(d.precipitation_sum[i] || 0).toFixed(1),
        wind: Math.round(d.windspeed_10m_max[i]),
        code: d.weathercode[i],
        icon: WMO_ICONS[d.weathercode[i]] || '🌡',
        text: WMO_TEXT[d.weathercode[i]] || '',
      })),
    };
    forecastCacheTime = Date.now();
    return forecastCache;
  } catch(e) { console.error('[weatherForecast]', e.message); return null; }
};

const DAYS_RU = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
const MONTHS_RU = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];

const formatForecast = (fc, daysCount = 7) => {
  if (!fc) return '❌ Прогноз временно недоступен.';
  const lines = ['🌤 *Прогноз погоды — Осакаровка*', ''];
  if (fc.current) {
    lines.push(`Сейчас: ${fc.current.icon} *${fc.current.temp}°C*, ${fc.current.text}, ветер ${fc.current.wind} км/ч`);
    lines.push('');
  }
  fc.days.slice(0, daysCount).forEach(d => {
    const dt  = new Date(d.date + 'T12:00:00');
    const dow = DAYS_RU[dt.getDay()];
    const dm  = dt.getDate() + ' ' + MONTHS_RU[dt.getMonth()];
    const rain = d.rain > 0 ? ` 💧${d.rain}мм` : '';
    lines.push(`${d.icon} *${dow} ${dm}:* ${d.min}…${d.max}°C${rain}`);
  });
  lines.push('');
  lines.push('_Источник: Open-Meteo (обновляется каждые 3ч)_');
  return lines.join('\n');
};

function httpGet(url) {
  return new Promise((res, rej) => {
    https.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'OsakarovkaBot/1.0' }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { if (r.statusCode >= 400) { rej(new Error('HTTP ' + r.statusCode)); return; } res(JSON.parse(d)) } catch(e) { rej(e) } });
    }).on('error', rej);
  });
}

module.exports = { getWeather, getWeatherForecast, formatWeatherForGroq, formatWeatherFull, formatWeatherBrief, formatForecast };
