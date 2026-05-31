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

// Возвращает строку только если погода ВАЖНАЯ
const formatWeatherForGroq = (w) => {
  if (!w) return '';
  // Обычная погода — не упоминаем
  if (w.isNormal) return '';
  let advice = '';
  if (w.isRain)  advice = 'Идёт дождь — отличный повод взять такси!';
  else if (w.isSnow) advice = 'Снегопад — дорога скользкая, лучше на такси.';
  else if (w.isCold) advice = 'Сильный мороз на улице — грейтесь в машине!';
  else if (w.isHot)  advice = 'Очень жарко — такси спасёт от жары!';
  else if (w.isWind) advice = 'Сильный ветер — комфортнее в такси.';
  if (!advice) return '';
  return `${w.temp}°C, ${w.condition}. ${advice}`;
};

// Краткая погода для водителя — только температура без лишнего
const formatWeatherBrief = (w) => {
  if (!w) return '';
  if (w.isNormal) return `${w.temp}°C, ${w.condition}`;
  if (w.isRain)  return `${w.temp}°C, дождь`;
  if (w.isSnow)  return `${w.temp}°C, снег`;
  if (w.isCold)  return `${w.temp}°C, мороз`;
  if (w.isHot)   return `${w.temp}°C, жара`;
  if (w.isWind)  return `${w.temp}°C, ветер`;
  return `${w.temp}°C`;
};

module.exports = { getWeather, formatWeatherForGroq, formatWeatherBrief };
