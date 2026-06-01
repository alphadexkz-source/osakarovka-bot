const https = require('https');
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const CITY = 'Osakarovka,KZ';
let cache = null, cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;

function httpGet(url) {
  return new Promise((res, rej) => {
    https.get(url, r => { let d=''; r.on('data', c => d+=c); r.on('end', () => { try { res(JSON.parse(d)) } catch(e) { rej(e) } }); }).on('error', rej);
  });
}

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

module.exports = { getWeather, formatWeatherForGroq, formatWeatherFull, formatWeatherBrief };
