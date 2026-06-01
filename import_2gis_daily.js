require('dotenv').config();
const https = require('https');
const fs = require('fs');

const DGIS_API_KEY = process.env.DGIS_API_KEY;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LAT = 50.5619, LON = 72.5681;
const RADIUS = 4000;
const STATE_FILE = '/home/alphadexkz/osakarovka-bot/logs/2gis_state.json';

const CATEGORIES = [
 'магазин продукты','супермаркет','аптека','кафе','столовая','банк',
 'школа','больница','парикмахерская','салон красоты','автосервис',
 'шиномонтаж','автомойка','азс заправочная станция','рынок базар',
 'гостиница','стоматология','ветеринар','детский сад','колледж',
 'акимат','полиция','казпочта почта','цон центр обслуживания населения',
 'налоговая инспекция','прокуратура','пенсионный фонд','социальная защита',
 'загс','военкомат','школа','детский сад ясли','спортивная школа секция',
 'гостиница отель','ремонт телефонов','ателье ремонт одежды',
 'ритуальные услуги','нотариус','юридические услуги','фотостудия',
 'типография','химчистка','спортзал фитнес','бильярд','библиотека',
 'мечеть','церковь','элеватор','нефтебаза',
 'магазин одежда','магазин обувь','магазин электроника',
 'магазин стройматериалы','магазин мебель','магазин автозапчасти',
 'магазин косметика','магазин цветы','магазин спорттовары',
 'магазин зоотовары','магазин канцтовары','магазин ювелирный',
];

const KZ = {
 'аптека':'дәріхана','больница':'аурухана','школа':'мектеп',
 'магазин':'дүкен','рынок':'базар','мечеть':'мешіт',
 'почта':'пошта','детский сад':'балабақша','парикмахерская':'шаштараз',
};

function httpGet(url) {
 return new Promise((res, rej) => {
   https.get(url, r => {
     let d = '';
     r.on('data', c => d += c);
     r.on('end', () => { try { res(JSON.parse(d)) } catch(e) { rej(e) } });
   }).on('error', rej);
 });
}

function extractFullAddress(item) {
 if (item.address_name) return `${item.address_name}, п. Осакаровка`;
 if (item.address) {
   if (item.address.components && item.address.components.length > 0) {
     const comp = item.address.components.find(c => c.type === 'street_number' || c.street);
     if (comp) {
       const street = comp.street || '';
       const number = comp.number || '';
       if (street && number) return `ул. ${street}, ${number}, п. Осакаровка`;
       if (street) return `ул. ${street}, п. Осакаровка`;
     }
   }
   if (item.address.address_name) return `${item.address.address_name}, п. Осакаровка`;
 }
 return 'п. Осакаровка';
}

function extractStreetName(item) {
 if (item.address?.components) {
   const comp = item.address.components.find(c => c.street);
   if (comp?.street) return comp.street.replace(/\s*улица\s*/i, '').trim();
 }
 return null;
}

function keywords(name, cat, streetName) {
 const s = new Set();
 const n = (name || '').toLowerCase().trim();
 s.add(n);
 n.split(/\s+/).forEach(w => { if (w.length > 2) s.add(w); });
 if (cat) cat.toLowerCase().split(/[\s,]+/).forEach(w => { if (w.length > 2) s.add(w); });
 if (streetName) {
   const st = streetName.toLowerCase();
   s.add(st);
   s.add('ул ' + st);
   s.add('улица ' + st);
 }
 for (const [ru, kz] of Object.entries(KZ)) {
   if (n.includes(ru) || (cat || '').toLowerCase().includes(ru)) s.add(kz);
 }
 s.delete('');
 return [...s].filter(k => k.length > 1).slice(0, 20);
}

function inOsak(item) {
 return JSON.stringify(item).toLowerCase().includes('осакаровк');
}

async function save(items) {
 const body = JSON.stringify(items);
 return new Promise((res, rej) => {
   const o = {
     hostname: 'jgnfjawqacmaqhgpsbcj.supabase.co',
     path: '/rest/v1/addresses?on_conflict=external_id',
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'Content-Length': Buffer.byteLength(body),
       'apikey': SUPABASE_KEY,
       'Authorization': 'Bearer ' + SUPABASE_KEY,
       'Prefer': 'resolution=merge-duplicates'
     }
   };
   const r = https.request(o, resp => {
     let d = '';
     resp.on('data', c => d += c);
     resp.on('end', () => resp.statusCode < 300 ? res(true) : rej(new Error(d)));
   });
   r.on('error', rej);
   r.write(body);
   r.end();
 });
}

function loadState() {
 try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
 catch(e) { return { lastIndex: -1, total: 0 }; }
}

function saveState(s) {
 fs.mkdirSync('/home/alphadexkz/osakarovka-bot/logs', { recursive: true });
 fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function main() {
 if (!DGIS_API_KEY) { console.error('Нет DGIS_API_KEY'); process.exit(1); }
 if (!SUPABASE_KEY) { console.error('Нет SUPABASE_SERVICE_KEY'); process.exit(1); }

 const state = loadState();
 const idx = (state.lastIndex + 1) % CATEGORIES.length;
 const cat = CATEGORIES[idx];
 const today = new Date().toISOString().split('T')[0];

 console.log(`[${today}] День ${idx + 1}/${CATEGORIES.length}: "${cat}"`);

 const all = new Map();

 for (let page = 1; page <= 5; page++) {
   const url = `https://catalog.api.2gis.com/3.0/items?` +
     `q=${encodeURIComponent(cat)}` +
     `&point=${LON},${LAT}` +
     `&radius=${RADIUS}` +
     `&fields=items.point,items.address,items.rubrics,items.address_name,items.full_address_name` +
     `&page_size=10&page=${page}` +
     `&key=${DGIS_API_KEY}`;

   try {
     const data = await httpGet(url);
     if (!data.result?.items?.length) break;

     let added = 0;
     for (const item of data.result.items) {
       if (!inOsak(item) || all.has(item.id)) continue;
       const fullAddress = extractFullAddress(item);
       const streetName  = extractStreetName(item);
       const category    = (item.rubrics || [])[0]?.name || cat;
       const kw          = keywords(item.name, category, streetName);
       all.set(item.id, {
         name:        item.name,
         category:    category,
         address:     fullAddress,
         lat:         item.point?.lat || null,
         lon:         item.point?.lon || null,
         keywords:    `{${kw.map(k => `"${k.replace(/"/g, '\\"')}"`).join(',')}}`,
         source:      '2gis',
         external_id: String(item.id),
         is_active:   true
       });
       added++;
     }

     console.log(`  стр.${page}: +${added}`);
     if (data.result.items.length < 10) break;
     await new Promise(r => setTimeout(r, 400));

   } catch(e) {
     console.log(`  ошибка стр.${page}: ${e.message}`);
     break;
   }
 }

 const items = [...all.values()];
 console.log(`  Найдено: ${items.length}`);

 if (items.length > 0) {
   try {
     await save(items);
     state.total = (state.total || 0) + items.length;
     console.log(`  ✅ Сохранено! Всего: ~${state.total}`);
   } catch(e) {
     console.error(`  ❌ ${e.message}`);
   }
 }

 state.lastIndex = idx;
 state.lastRun   = today;
 saveState(state);

 console.log(idx === CATEGORIES.length - 1
   ? `\n🔄 Все ${CATEGORIES.length} категорий! Завтра заново.`
   : `Завтра: "${CATEGORIES[idx + 1]}"`
 );
}

main().catch(console.error);
