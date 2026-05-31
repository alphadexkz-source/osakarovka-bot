const q      = require('../db/queries');
const config = require('../config');

// Ночное время?
const isNight = () => {
  const h = new Date().getHours();
  const { NIGHT_START: s, NIGHT_END: e } = config;
  return s < e ? h >= s && h < e : h >= s || h < e;
};

// Нормализация текста для сравнения
const norm = (t) =>
  t.toLowerCase()
   .replace(/ё/g, 'е')
   .replace(/[^а-яa-z0-9\s]/g, ' ')
   .replace(/\s+/g, ' ')
   .trim();

// Найти тариф по ключевым словам в тексте заказа
const findTariff = async (destination) => {
  const tariffs = await q.getTariffs();
  const text = norm(destination);

  for (const t of tariffs) {
    if (!t.keywords?.length) continue;
    for (const kw of t.keywords) {
      if (text.includes(norm(kw))) return t;
    }
  }
  return null;
};

// Получить цену для направления
const getPrice = async (destination) => {
  const tariff = await findTariff(destination);
  const night  = isNight();

  if (!tariff) {
    return { price: config.CITY_PRICE, tariff: null, isCity: true, isNight: night };
  }

  const price = (night && tariff.night_price) ? tariff.night_price : tariff.day_price;
  return { price, tariff, isCity: false, isNight: night };
};

// Форматировать список тарифов для вывода
const formatTariffList = (tariffs) => {
  if (!tariffs.length) return '📋 Тарифы ещё не добавлены.';

  return tariffs
    .map((t, i) => {
      const night = t.night_price ? ` | 🌙 ${t.night_price} тг` : '';
      const keys  = (t.keywords || []).join(', ');
      return `*${i + 1}.* ${t.name}\n   💰 ${t.day_price} тг${night}\n   🔑 ${keys || '—'}`;
    })
    .join('\n\n');
};

module.exports = { findTariff, getPrice, isNight, formatTariffList };
