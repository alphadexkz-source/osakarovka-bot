/**
 * OpenStreetMap Overpass API — улицы и объекты Осакаровки
 * Бесплатно, без ключа. Endpoint: https://overpass-api.de/api/interpreter
 */
const axios = require('axios');

// Bounding box Осакаровки: south, west, north, east
const BBOX = {
  south: 50.535,
  west:  72.540,
  north: 50.595,
  east:  72.600,
};

// Несколько публичных Overpass-эндпоинтов (fallback)
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const OVERPASS_QUERY = `
[out:json][timeout:90];
(
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["amenity"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["shop"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["healthcare"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["office"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["leisure"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["tourism"];
  node(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["public_transport"="stop_position"];
  way(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["highway"]["name"];
  way(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["amenity"];
  way(${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east})["building"]["name"];
);
out body;
>;
out skel qt;
`.trim();

// Маппинг OSM тегов → человекочитаемые категории
const CATEGORY_MAP = {
  // amenity
  hospital:      'Больница',
  clinic:        'Поликлиника',
  pharmacy:      'Аптека',
  school:        'Школа',
  kindergarten:  'Детский сад',
  university:    'Университет',
  college:       'Колледж',
  restaurant:    'Ресторан',
  cafe:          'Кафе',
  fast_food:     'Фаст-фуд',
  food_court:    'Столовая',
  canteen:       'Столовая',
  bar:           'Бар',
  bank:          'Банк',
  atm:           'Банкомат',
  post_office:   'Почта',
  police:        'Полиция',
  fire_station:  'Пожарная',
  marketplace:   'Рынок',
  fuel:          'АЗС',
  parking:       'Парковка',
  bus_station:   'Автовокзал',
  place_of_worship: 'Мечеть',
  library:       'Библиотека',
  theatre:       'Театр',
  cinema:        'Кинотеатр',
  sports_centre: 'Спорткомплекс',
  stadium:       'Стадион',
  community_centre: 'Общественный центр',
  social_facility: 'Социальный объект',
  courthouse:    'Суд',
  townhall:      'Акимат',
  // shop
  supermarket:   'Супермаркет',
  convenience:   'Магазин',
  bakery:        'Пекарня',
  butcher:       'Мясной магазин',
  clothes:       'Одежда',
  electronics:   'Электроника',
  hardware:      'Хозтовары',
  hairdresser:   'Парикмахерская',
  // office
  government:    'Госучреждение',
  // leisure
  park:          'Парк',
  playground:    'Детская площадка',
  pitch:         'Спортплощадка',
  // highway
  residential:   'Улица',
  primary:       'Улица',
  secondary:     'Улица',
  tertiary:      'Улица',
  unclassified:  'Улица',
  service:       'Дорога',
  living_street: 'Улица',
};

// Ключевые слова по категории
const KEYWORD_MAP = {
  'Больница':      ['больница', 'аурухана', 'скорая', 'медицина'],
  'Поликлиника':   ['поликлиника', 'больница', 'врач', 'аурухана'],
  'Аптека':        ['аптека', 'лекарства', 'дәріхана'],
  'Школа':         ['школа', 'мектеп', 'учёба'],
  'Детский сад':   ['садик', 'детсад', 'балабақша', 'ясли'],
  'Кафе':          ['кафе', 'еда', 'кушать', 'перекус'],
  'Ресторан':      ['ресторан', 'кафе', 'еда'],
  'Столовая':      ['столовая', 'еда', 'обед'],
  'Банк':          ['банк', 'банкі', 'деньги', 'кредит'],
  'Банкомат':      ['банкомат', 'снять', 'деньги'],
  'Почта':         ['почта', 'пошт', 'посылка'],
  'Полиция':       ['полиция', 'ровд', 'милиция'],
  'Рынок':         ['рынок', 'базар', 'нарық', 'рынке'],
  'АЗС':           ['заправка', 'азс', 'бензин', 'бензостанция'],
  'Акимат':        ['акимат', 'администрация', 'әкімшілік'],
  'Мечеть':        ['мечеть', 'мешіт', 'намаз'],
  'Стадион':       ['стадион', 'спорт', 'футбол'],
  'Спортплощадка': ['спортплощадка', 'стадион', 'спорт'],
  'Парк':          ['парк', 'саябақ', 'прогулка'],
  'Супермаркет':   ['магазин', 'супермаркет', 'продукты', 'дүкен'],
  'Магазин':       ['магазин', 'продукты', 'дүкен'],
  'Автовокзал':    ['вокзал', 'автобус', 'автовокзал'],
  'Улица':         [],
};

const normalizeOsm = (el, wayNames) => {
  const tags = el.tags || {};

  // Определяем тип объекта
  let typeTag = tags.amenity || tags.shop || tags.healthcare ||
                tags.office || tags.leisure || tags.tourism ||
                tags.public_transport || tags.highway || '';

  const name = tags.name || tags['name:ru'] || tags['name:kk'] || '';

  // Улицы — особая обработка
  if (el.type === 'way' && tags.highway) {
    if (!name) return null;
    const category = CATEGORY_MAP[tags.highway] || 'Улица';
    const addrLine = `ул. ${name}, Осакаровка`;
    return {
      name: `ул. ${name}`,
      category,
      address: addrLine.slice(0, 255),
      phone: null,
      hours: null,
      lat: null,
      lon: null,
      keywords: ['ул', name.toLowerCase(), ...name.toLowerCase().split(/\s+/).filter(w => w.length > 2)],
      source: 'osm',
      external_id: `way_${el.id}`,
    };
  }

  if (!name) return null; // без имени не добавляем

  const category = CATEGORY_MAP[typeTag] || typeTag || 'Объект';
  const street = tags['addr:street'] || '';
  const houseNum = tags['addr:housenumber'] || '';
  const address = [street, houseNum].filter(Boolean).join(' ') || 'Осакаровка';

  const baseKeywords = KEYWORD_MAP[category] || [];
  const nameWords = name.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const keywords = [...new Set([name.toLowerCase(), ...nameWords, ...baseKeywords])];

  const phone = tags.phone || tags['contact:phone'] || null;
  const hours = tags.opening_hours || null;

  return {
    name: name.slice(0, 255),
    category: category.slice(0, 100),
    address: address.slice(0, 255),
    phone: phone ? phone.slice(0, 50) : null,
    hours: hours ? hours.slice(0, 100) : null,
    lat: el.lat || null,
    lon: el.lon || null,
    keywords: keywords.slice(0, 30),
    source: 'osm',
    external_id: `${el.type}_${el.id}`,
  };
};

const fetchOverpass = async (logger) => {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'User-Agent': 'osakarovka-bot/2.0 (taxi dispatch bot, Kazakhstan)',
  };
  const body = `data=${encodeURIComponent(OVERPASS_QUERY)}`;

  for (const url of OVERPASS_ENDPOINTS) {
    try {
      logger(`[OSM] Пробуем ${url.replace('https://', '')}...`);
      const resp = await axios.post(url, body, { headers, timeout: 120000 });
      return resp.data?.elements || [];
    } catch (e) {
      logger(`[OSM] ${url.split('/')[2]}: ${e.response?.status || e.message} — пробуем следующий`);
    }
  }
  return [];
};

const collect = async (logger = console.log) => {
  logger('[OSM] Запрос к Overpass API...');

  try {
    const elements = await fetchOverpass(logger);
    logger(`[OSM] Получено элементов: ${elements.length}`);

    const results = [];
    const seen = new Set();

    for (const el of elements) {
      // Пропускаем служебные элементы (nd, member)
      if (!['node', 'way', 'relation'].includes(el.type)) continue;
      if (!el.tags || Object.keys(el.tags).length === 0) continue;

      const normalized = normalizeOsm(el);
      if (!normalized) continue;

      if (seen.has(normalized.external_id)) continue;
      seen.add(normalized.external_id);

      results.push(normalized);
    }

    logger(`[OSM] Нормализовано объектов: ${results.length}`);
    return results;
  } catch (e) {
    logger(`[OSM] Критическая ошибка: ${e.message}`);
    return [];
  }
};

module.exports = { collect };
