/**
 * 2GIS Catalog API 3.0 — сбор объектов в Осакаровке
 * Docs: https://docs.2gis.com/ru/api/search/catalog/reference/3.0/items/get
 */
const axios = require('axios');

const DGIS_BASE = 'https://catalog.api.2gis.com/3.0';

// Центр Осакаровки: lon, lat
const CENTER = { lon: 72.5681, lat: 50.5619 };
const RADIUS = 8000; // 8 км — покрывает весь посёлок

// Категории для поиска (пустой q = все объекты в радиусе; конкретные = точные запросы)
const SEARCH_QUERIES = [
  '',           // все объекты (несколько страниц)
  'магазин',
  'аптека',
  'больница',
  'поликлиника',
  'школа',
  'детский сад',
  'кафе',
  'столовая',
  'ресторан',
  'банк',
  'банкомат',
  'почта',
  'заправка',
  'рынок',
  'акимат',
  'мечеть',
  'стадион',
  'полиция',
  'вокзал',
  'гостиница',
  'парикмахерская',
  'сервис',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Один запрос к 2GIS с пагинацией.
 * Возвращает массив сырых объектов.
 */
const fetchPage = async (apiKey, q, page) => {
  const params = {
    location: `${CENTER.lon},${CENTER.lat}`,
    radius: RADIUS,
    fields: 'items.point,items.address,items.rubrics,items.contact_groups,items.schedule',
    key: apiKey,
    page_size: 50,
    page,
    sort: 'distance',
  };
  if (q) params.q = q;

  const resp = await axios.get(`${DGIS_BASE}/items`, { params, timeout: 10000 });
  return resp.data?.result?.items || [];
};

/**
 * Нормализует один объект 2GIS в формат addresses таблицы.
 */
const normalize2gis = (item) => {
  const name = item.name || '';
  if (!name) return null;

  const rubrics = item.rubrics || [];
  const category = rubrics[0]?.name || '';

  const addrObj = item.address_name || item.address || '';
  const address = typeof addrObj === 'string' ? addrObj : (addrObj.name || addrObj.full_name || '');

  const point = item.point || {};
  const lat = point.lat || null;
  const lon = point.lon || null;

  // Телефон из contact_groups
  let phone = null;
  const contacts = item.contact_groups || [];
  for (const group of contacts) {
    for (const contact of (group.contacts || [])) {
      if (contact.type === 'phone' && contact.value) {
        phone = contact.value.replace(/\s+/g, '');
        break;
      }
    }
    if (phone) break;
  }

  // Часы работы
  let hours = null;
  if (item.schedule?.working_hours) {
    hours = item.schedule.working_hours;
  } else if (item.schedule?.is_24h) {
    hours = '24/7';
  }

  // Ключевые слова: само название + рубрики + транслитерация
  const keywords = buildKeywords(name, rubrics.map(r => r.name));

  return {
    name: name.slice(0, 255),
    category: category.slice(0, 100),
    address: address.slice(0, 255),
    phone: phone ? phone.slice(0, 50) : null,
    hours: hours ? String(hours).slice(0, 100) : null,
    lat,
    lon,
    keywords,
    source: '2gis',
    external_id: String(item.id || ''),
  };
};

/**
 * Генерирует массив ключевых слов для поиска.
 */
const buildKeywords = (name, rubrics) => {
  const words = new Set();

  const addLo = (str) => {
    if (!str) return;
    words.add(str.toLowerCase().trim());
    // Каждое слово отдельно (длиннее 2 символов)
    str.toLowerCase().split(/\s+/).filter(w => w.length > 2).forEach(w => words.add(w));
  };

  addLo(name);
  rubrics.forEach(r => addLo(r));

  // Синонимы для частых объектов
  const SYNS = {
    аптека:     ['аптека', 'лекарства', 'дәріхана'],
    школа:      ['школа', 'мектеп'],
    больница:   ['больница', 'аурухана', 'поликлиника'],
    кафе:       ['кафе', 'ресторан', 'столовая', 'еда'],
    магазин:    ['магазин', 'дүкен', 'продукты'],
    банк:       ['банк', 'банкомат', 'банкі'],
    почта:      ['почта', 'пошт'],
    заправка:   ['заправка', 'азс', 'нефтебаза'],
    рынок:      ['рынок', 'базар', 'нарық'],
    акимат:     ['акимат', 'администрация', 'әкімшілік'],
    мечеть:     ['мечеть', 'мешіт'],
    стадион:    ['стадион', 'спортплощадка'],
    полиция:    ['полиция', 'ровд'],
    вокзал:     ['вокзал', 'автовокзал', 'автобус'],
    детский:    ['садик', 'детсад', 'балабақша'],
  };
  const nameLo = name.toLowerCase();
  for (const [key, syns] of Object.entries(SYNS)) {
    if (nameLo.includes(key) || rubrics.some(r => r.toLowerCase().includes(key))) {
      syns.forEach(s => words.add(s));
    }
  }

  return [...words].filter(Boolean).slice(0, 30);
};

/**
 * Основная функция: собирает все объекты из 2GIS по всем категориям.
 * Возвращает массив нормализованных объектов.
 */
const collect = async (apiKey, logger = console.log) => {
  if (!apiKey) {
    logger('[2GIS] DGIS_API_KEY не задан, пропускаем');
    return [];
  }

  const seen = new Set();
  const results = [];

  for (const q of SEARCH_QUERIES) {
    let page = 1;
    let fetched = 0;
    logger(`[2GIS] Запрос: "${q || 'все объекты'}"...`);

    while (true) {
      try {
        const items = await fetchPage(apiKey, q, page);
        if (!items.length) break;

        for (const item of items) {
          if (!item.id || seen.has(String(item.id))) continue;
          seen.add(String(item.id));
          const normalized = normalize2gis(item);
          if (normalized && normalized.name) {
            results.push(normalized);
            fetched++;
          }
        }

        if (items.length < 50) break; // последняя страница
        page++;
        await sleep(300); // 300ms между запросами
      } catch (e) {
        if (e.response?.status === 404) break; // страниц больше нет
        logger(`[2GIS] Ошибка (${q}, стр.${page}): ${e.message}`);
        break;
      }
    }

    logger(`[2GIS]   → найдено: ${fetched}`);
    await sleep(500); // пауза между категориями
  }

  logger(`[2GIS] Итого уникальных объектов: ${results.length}`);
  return results;
};

module.exports = { collect };
