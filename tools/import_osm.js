/**
 * OpenStreetMap (Overpass API) → Supabase addresses
 * Вытаскивает все POI п. Осакаровка без API-ключей.
 * Запуск: node tools/import_osm.js
 */
require('dotenv').config();
const https = require('https');

const SUPABASE_URL = 'https://jgnfjawqacmaqhgpsbcj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Bbox Осакаровки: south,west,north,east
const BBOX = '50.530,72.530,50.600,72.620';

// Overpass QL — все POI поселка
const QUERY = `
[out:json][timeout:60];
(
  node["amenity"](${BBOX});
  node["shop"](${BBOX});
  node["tourism"](${BBOX});
  node["leisure"](${BBOX});
  node["office"](${BBOX});
  node["healthcare"](${BBOX});
  node["craft"](${BBOX});
  node["emergency"](${BBOX});
  node["public_transport"](${BBOX});
  node["highway"="bus_stop"](${BBOX});
  way["amenity"](${BBOX});
  way["shop"](${BBOX});
  way["building"~"school|hospital|hotel|mosque|church"](${BBOX});
  relation["amenity"](${BBOX});
);
out center tags;
`.trim();

const CATEGORY_MAP = {
  // amenity
  restaurant: 'Ресторан', cafe: 'Кафе', fast_food: 'Фастфуд',
  bar: 'Бар', pub: 'Бар',
  pharmacy: 'Аптека', hospital: 'Больница', clinic: 'Поликлиника',
  doctors: 'Врач', dentist: 'Стоматология', veterinary: 'Ветеринар',
  school: 'Школа', kindergarten: 'Детский сад', college: 'Колледж',
  university: 'Университет', library: 'Библиотека',
  bank: 'Банк', atm: 'Банкомат', bureau_de_change: 'Обменник',
  post_office: 'Почта', police: 'Полиция', fire_station: 'Пожарная',
  fuel: 'АЗС', car_wash: 'Автомойка', car_repair: 'Автосервис',
  place_of_worship: 'Религия', mosque: 'Мечеть', church: 'Церковь',
  marketplace: 'Рынок', supermarket: 'Супермаркет',
  gym: 'Спортзал', swimming_pool: 'Бассейн',
  toilets: 'Туалет', parking: 'Парковка',
  // shop
  convenience: 'Магазин', supermarket_shop: 'Супермаркет',
  clothes: 'Магазин одежды', shoes: 'Магазин обуви',
  electronics: 'Магазин электроники', hardware: 'Стройматериалы',
  furniture: 'Магазин мебели', car_parts: 'Автозапчасти',
  cosmetics: 'Магазин косметики', florist: 'Цветочный магазин',
  sports: 'Спорттовары', stationery: 'Канцтовары',
  jewelry: 'Ювелирный', bakery: 'Пекарня', butcher: 'Мясной',
  // tourism/leisure
  hotel: 'Гостиница', motel: 'Мотель', hostel: 'Хостел',
  park: 'Парк', playground: 'Детская площадка',
  // office
  government: 'Госучреждение', ngo: 'НКО',
};

const KZ = {
  'аптека': 'дәріхана', 'больница': 'аурухана', 'школа': 'мектеп',
  'магазин': 'дүкен', 'рынок': 'базар', 'мечеть': 'мешіт',
  'почта': 'пошта', 'детский сад': 'балабақша', 'парикмахерская': 'шаштараз',
};

function httpPost(hostname, path, body, headers) {
  return new Promise((res, rej) => {
    const buf = Buffer.from(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res({ status: r.statusCode, body: d }));
    });
    req.on('error', rej);
    req.write(buf);
    req.end();
  });
}

function httpGet(url) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(new Error(d.slice(0, 200))); } });
    }).on('error', rej);
  });
}

function getCategory(tags) {
  for (const key of ['amenity', 'shop', 'tourism', 'leisure', 'office', 'healthcare', 'craft', 'emergency']) {
    if (tags[key]) return CATEGORY_MAP[tags[key]] || tags[key];
  }
  if (tags.building) return CATEGORY_MAP[tags.building] || 'Здание';
  return 'Объект';
}

function getName(tags) {
  return tags['name:ru'] || tags.name || tags['name:kk'] || '';
}

function getAddress(tags, lat, lon) {
  const parts = [];
  if (tags['addr:street']) parts.push('ул. ' + tags['addr:street']);
  if (tags['addr:housenumber']) parts.push(tags['addr:housenumber']);
  if (parts.length) return parts.join(', ') + ', п. Осакаровка';
  return 'п. Осакаровка';
}

function keywords(name, cat) {
  const s = new Set();
  const n = (name || '').toLowerCase();
  s.add(n);
  n.split(/\s+/).forEach(w => { if (w.length > 2) s.add(w); });
  if (cat) s.add(cat.toLowerCase());
  for (const [ru, kz] of Object.entries(KZ)) {
    if (n.includes(ru) || cat.toLowerCase().includes(ru)) s.add(kz);
  }
  s.delete('');
  return [...s].filter(k => k.length > 1).slice(0, 20);
}

function toPgArray(arr) {
  return '{' + arr.map(k => '"' + k.replace(/"/g, '\\"') + '"').join(',') + '}';
}

async function queryOverpass() {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  ];

  for (const ep of endpoints) {
    try {
      console.log(`Запрос Overpass: ${ep}`);
      const resp = await httpPost(
        new URL(ep).hostname,
        new URL(ep).pathname,
        'data=' + encodeURIComponent(QUERY),
        { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'OsakarovkaBot/1.0' }
      );
      if (resp.status === 200) {
        return JSON.parse(resp.body);
      }
    } catch (e) {
      console.log(`  Ошибка ${ep}: ${e.message}`);
    }
  }
  throw new Error('Все Overpass endpoints недоступны');
}

async function saveToSupabase(rows) {
  const body = JSON.stringify(rows);
  const resp = await httpPost(
    'jgnfjawqacmaqhgpsbcj.supabase.co',
    '/rest/v1/addresses?on_conflict=external_id',
    body,
    {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Prefer': 'resolution=merge-duplicates',
    }
  );
  if (resp.status >= 300) throw new Error(resp.body);
  return true;
}

async function main() {
  if (!SUPABASE_KEY) { console.error('Нет SUPABASE_SERVICE_KEY в .env'); process.exit(1); }

  console.log('=== OSM Import для п. Осакаровка ===\n');

  const data = await queryOverpass();
  const elements = data.elements || [];
  console.log(`OSM вернул ${elements.length} элементов`);

  const rows = [];
  const seen = new Set();

  for (const el of elements) {
    const tags = el.tags || {};
    const name = getName(tags);
    if (!name) continue;

    const lat = el.lat || el.center?.lat;
    const lon = el.lon || el.center?.lon;
    const cat = getCategory(tags);
    const addr = getAddress(tags, lat, lon);
    const kw = keywords(name, cat);
    const extId = `osm_${el.type}_${el.id}`;

    if (seen.has(extId)) continue;
    seen.add(extId);

    rows.push({
      name,
      category: cat,
      address: addr,
      lat: lat || null,
      lon: lon || null,
      keywords: toPgArray(kw),
      source: 'osm',
      external_id: extId,
      is_active: true,
    });
  }

  console.log(`Именованных объектов: ${rows.length}`);

  if (rows.length === 0) {
    console.log('Нечего сохранять');
    return;
  }

  // Сохраняем батчами по 100
  let saved = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    try {
      await saveToSupabase(batch);
      saved += batch.length;
      console.log(`Сохранено: ${saved}/${rows.length}`);
    } catch (e) {
      console.error(`Ошибка батча ${i}: ${e.message.slice(0, 150)}`);
    }
  }

  console.log(`\n✅ OSM импорт завершён: ${saved} объектов`);

  // Статистика по категориям
  const cats = {};
  rows.forEach(r => { cats[r.category] = (cats[r.category] || 0) + 1; });
  console.log('\nПо категориям:');
  Object.entries(cats).sort((a,b) => b[1]-a[1]).forEach(([c,n]) => console.log(`  ${c}: ${n}`));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
