// Информационный сервис — курс валют, металлы, зерно
// Все источники бесплатны и не требуют регистрации/ключей

const https = require('https');
const http  = require('http');

const cache = new Map();
const getFromCache = (key, ttlMs) => {
  const e = cache.get(key);
  return (e && Date.now() - e.time < ttlMs) ? e.data : null;
};
const setCache = (key, data) => cache.set(key, { data, time: Date.now() });

function httpGet(url, headers = {}) {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OsakarovkaBot/1.0)', ...headers }
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try { res(JSON.parse(d)); }
        catch(e) { rej(new Error('parse: ' + d.slice(0, 80))); }
      });
    });
    req.on('error', rej);
    req.on('timeout', () => { req.destroy(); rej(new Error('timeout')); });
  });
}

// ─── КУРС ВАЛЮТ ─────────────────────────────────────────────
// Источник: github.com/fawazahmed0/exchange-api — бесплатно, без ключа
const getCurrencyRates = async () => {
  const cached = getFromCache('currency', 30 * 60 * 1000); // 30 мин
  if (cached) return cached;
  try {
    const data = await httpGet(
      'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json'
    );
    const u = data.usd;
    const kzt = u.kzt;
    const result = {
      usd:  +kzt.toFixed(1),
      eur:  u.eur ? +(kzt / u.eur).toFixed(1) : null,
      rub:  u.rub ? +(kzt / u.rub).toFixed(2) : null, // 1 RUB в KZT
      rub100: u.rub ? +(kzt / u.rub * 100).toFixed(1) : null, // 100 RUB в KZT
      cny:  u.cny ? +(kzt / u.cny).toFixed(1) : null,
      date: data.date,
    };
    setCache('currency', result);
    return result;
  } catch(e) {
    console.error('[infoService:currency]', e.message);
    return null;
  }
};

// ─── МЕТАЛЛЫ ────────────────────────────────────────────────
// Источник: тот же fawazahmed0 — XAU (золото), XAG (серебро)
const getMetalPrices = async () => {
  const cached = getFromCache('metals', 60 * 60 * 1000); // 1 час
  if (cached) return cached;
  try {
    const [dataXau, dataXag] = await Promise.all([
      httpGet('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.min.json'),
      httpGet('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xag.min.json'),
    ]);
    const result = {
      gold_usd: dataXau.xau?.usd  ? +dataXau.xau.usd.toFixed(2)  : null, // цена за тройскую унцию
      gold_kzt: dataXau.xau?.kzt  ? +dataXau.xau.kzt.toFixed(0)  : null,
      gold_gram_kzt: dataXau.xau?.kzt ? +(dataXau.xau.kzt / 31.1035).toFixed(0) : null, // за 1 грамм
      silver_usd: dataXag.xag?.usd ? +dataXag.xag.usd.toFixed(2) : null,
      silver_kzt: dataXag.xag?.kzt ? +dataXag.xag.kzt.toFixed(0) : null,
      silver_gram_kzt: dataXag.xag?.kzt ? +(dataXag.xag.kzt / 31.1035).toFixed(0) : null,
      date: dataXau.date,
    };
    setCache('metals', result);
    return result;
  } catch(e) {
    console.error('[infoService:metals]', e.message);
    return null;
  }
};

// ─── ЗЕРНО И КОРМА ──────────────────────────────────────────
// Источник: Yahoo Finance — мировые фьючерсы CBOT, без ключа
// ZW=F пшеница, ZC=F кукуруза, ZM=F соевый шрот — цены в USD центах/бушель
const getGrainPrices = async () => {
  const cached = getFromCache('grain', 4 * 60 * 60 * 1000); // 4 часа
  if (cached) return cached;
  try {
    const rates = await getCurrencyRates();
    const usdKzt = rates?.usd || 460;

    const fetchPrice = async (ticker) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
        const data = await httpGet(url);
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta?.regularMarketPrice) return null;
        return {
          price: meta.regularMarketPrice,
          currency: meta.currency,
          name: meta.longName || ticker,
        };
      } catch { return null; }
    };

    const [wheat, corn, soy] = await Promise.all([
      fetchPrice('ZW=F'),
      fetchPrice('ZC=F'),
      fetchPrice('ZM=F'),
    ]);

    // CBOT: пшеница и кукуруза в центах/бушель → USD/тонну → KZT/тонну
    const bushel_wheat_kg = 27.2155; // 1 бушель пшеницы = 27.2 кг
    const bushel_corn_kg  = 25.4012; // 1 бушель кукурузы = 25.4 кг
    const bushel_soy_kg   = 27.2155;

    const centsToKztPerTon = (cents, kgPerBushel) => {
      if (!cents) return null;
      const usdPerBushel = cents / 100;
      const usdPerTon    = usdPerBushel * (1000 / kgPerBushel);
      return Math.round(usdPerTon * usdKzt);
    };

    const result = {
      wheat: wheat ? {
        price_cents: wheat.price,
        kzt_per_ton: centsToKztPerTon(wheat.price, bushel_wheat_kg),
        usd_per_ton: wheat.price ? +(wheat.price / 100 * (1000 / bushel_wheat_kg)).toFixed(2) : null,
      } : null,
      corn: corn ? {
        price_cents: corn.price,
        kzt_per_ton: centsToKztPerTon(corn.price, bushel_corn_kg),
        usd_per_ton: corn.price ? +(corn.price / 100 * (1000 / bushel_corn_kg)).toFixed(2) : null,
      } : null,
      soy_meal: soy ? {
        price: soy.price,
        kzt_per_ton: soy.price ? Math.round(soy.price * usdKzt) : null, // шрот уже в USD/тонну
        usd_per_ton: soy.price,
      } : null,
      note: 'Мировые цены CBOT (Чикаго). Реальная цена в РК может отличаться.',
      date: new Date().toLocaleDateString('ru-RU'),
    };
    setCache('grain', result);
    return result;
  } catch(e) {
    console.error('[infoService:grain]', e.message);
    return null;
  }
};

// ─── ФОРМАТИРОВАНИЕ ─────────────────────────────────────────

const formatCurrency = (r) => {
  if (!r) return '❌ Не удалось загрузить курс. Попробуйте позже.';
  const lines = [
    '💱 *Курс валют* (на ' + r.date + ')',
    '',
    '🇺🇸 *1 USD* = *' + r.usd + ' ₸*',
    r.eur  ? '🇪🇺 *1 EUR* = *' + r.eur + ' ₸*' : '',
    r.rub100 ? '🇷🇺 *100 RUB* = *' + r.rub100 + ' ₸*' : '',
    r.cny  ? '🇨🇳 *1 CNY* = *' + r.cny + ' ₸*' : '',
    '',
    '_Источник: exchangerate (обновляется ежедневно)_',
  ].filter(x => x !== '');
  return lines.join('\n');
};

const formatMetals = (r) => {
  if (!r) return '❌ Не удалось загрузить цены металлов. Попробуйте позже.';
  return [
    '🥇 *Цены на металлы* (на ' + r.date + ')',
    '',
    '🥇 *Золото:*',
    r.gold_usd  ? '  1 унция = *$' + r.gold_usd.toLocaleString() + '* | *' + (r.gold_kzt||'?').toLocaleString() + ' ₸*' : '',
    r.gold_gram_kzt ? '  1 грамм ≈ *' + r.gold_gram_kzt.toLocaleString() + ' ₸*' : '',
    '',
    '🥈 *Серебро:*',
    r.silver_usd  ? '  1 унция = *$' + r.silver_usd + '* | *' + (r.silver_kzt||'?').toLocaleString() + ' ₸*' : '',
    r.silver_gram_kzt ? '  1 грамм ≈ *' + r.silver_gram_kzt.toLocaleString() + ' ₸*' : '',
    '',
    '_Биржевые цены. Цены ювелиров выше._',
  ].filter(x => x !== '').join('\n');
};

const formatGrain = (r) => {
  if (!r) return '❌ Не удалось загрузить цены. Попробуйте позже.';
  const lines = [
    '🌾 *Мировые цены на зерно* (' + r.date + ')',
    '_Биржа CBOT, Чикаго_',
    '',
  ];
  if (r.wheat) {
    lines.push('🌾 *Пшеница:*');
    lines.push('  ~*$' + r.wheat.usd_per_ton + '/т* | ~*' + (r.wheat.kzt_per_ton||0).toLocaleString() + ' ₸/т*');
  }
  if (r.corn) {
    lines.push('🌽 *Кукуруза:*');
    lines.push('  ~*$' + r.corn.usd_per_ton + '/т* | ~*' + (r.corn.kzt_per_ton||0).toLocaleString() + ' ₸/т*');
  }
  if (r.soy_meal) {
    lines.push('🫘 *Соевый шрот:*');
    lines.push('  ~*$' + r.soy_meal.usd_per_ton + '/т* | ~*' + (r.soy_meal.kzt_per_ton||0).toLocaleString() + ' ₸/т*');
  }
  lines.push('');
  lines.push('_⚠️ ' + r.note + '_');
  return lines.join('\n');
};

module.exports = {
  getCurrencyRates, getMetalPrices, getGrainPrices,
  formatCurrency, formatMetals, formatGrain,
};
