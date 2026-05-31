const https = require('https');
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const CITY = 'Osakarovka,KZ';
let cache = null, cacheTime = 0;
const CACHE_TTL = 30 * 60 * 1000;
function httpGet(url) {
  return new Promise((res,rej) => {
    https.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}}); }).on('error',rej);
  });
}
const getWeather = async () => {
  if (cache && Date.now() - cacheTime < CACHE_TTL) return cache;
  if (!WEATHER_API_KEY) return null;
  try {
    const data = await httpGet(`https://api.weatherapi.com/v1/current.json?key=${WEATHER_API_KEY}&q=${CITY}&lang=ru`);
    const w = data.current;
    cache = {
      temp: Math.round(w.temp_c), feels: Math.round(w.feelslike_c),
      condition: w.condition.text, wind: Math.round(w.wind_kph), humidity: w.humidity,
      isRain: w.condition.text.toLowerCase().includes('дожд') || w.precip_mm > 0,
      isSnow: w.condition.text.toLowerCase().includes('снег'),
      isWind: w.wind_kph > 30, isCold: w.temp_c < -10, isHot: w.temp_c > 30,
    };
    cacheTime = Date.now();
    return cache;
  } catch(e) { console.error('[weatherService]', e.message); return null; }
};
const formatWeatherForGroq = (w) => {
  if (!w) return '';
  let advice = '';
  if (w.isRain) advice = 'Идёт дождь — лучше на такси!';
  else if (w.isSnow) advice = 'Снегопад — дорога скользкая!';
  else if (w.isWind) advice = 'Сильный ветер на улице.';
  else if (w.isCold) advice = 'Очень холодно — оденьтесь теплее!';
  else if (w.isHot) advice = 'Очень жарко сегодня!';
  return `Погода в Осакаровке: ${w.temp}°C (ощущается ${w.feels}°C), ${w.condition}. ${advice}`.trim();
};
module.exports = { getWeather, formatWeatherForGroq };
