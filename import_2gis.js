require('dotenv').config();
const https = require('https');
const DGIS_API_KEY = process.env.DGIS_API_KEY;
const SUPABASE_URL = 'https://jgnfjawqacmaqhgpsbcj.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LAT = 50.5619, LON = 72.5681;
const CATEGORIES = [
  // Торговля
  'магазин продукты','супермаркет','торговый центр','рынок','магазин одежда',
  'магазин обувь','магазин электроника','магазин стройматериалы','магазин мебель',
  'магазин автозапчасти','магазин косметика','магазин цветы','магазин спорттовары',
  'магазин канцтовары','ювелирный магазин','хозтовары',
  // Медицина
  'больница','аптека','стоматология','скорая помощь','ветеринар','медпункт',
  // Общепит
  'кафе','столовая','ресторан','бар','шашлычная','пиццерия',
  // Услуги
  'парикмахерская','салон красоты','баня','сауна','химчистка','ателье',
  'ремонт телефонов','фотостудия','типография','нотариус',
  // Транспорт и авто
  'автосервис','шиномонтаж','автомойка','азс заправочная','автовокзал',
  // Финансы
  'банк','банкомат','микрофинансирование','страхование',
  // Образование
  'школа','детский сад','колледж','библиотека','спортивная школа',
  // Госструктуры
  'акимат','полиция','казпочта','цон','налоговая','прокуратура',
  'пенсионный фонд','загс','военкомат','суд',
  // Религия и отдых
  'мечеть','церковь','спортзал','кинотеатр','бильярд','парк',
  // Промышленность
  'элеватор','нефтебаза','склад',
  // Гостиницы
  'гостиница отель',
  // Специфичные запросы для Осакаровки
  'октябрь','транзит маркет','kaspi','халык','биосфера',
];
function httpGet(url){return new Promise((res,rej)=>{https.get(url,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
function keywords(name,cat,addr){const s=new Set();const n=(name||'').toLowerCase();n.split(/\s+/).forEach(w=>{if(w.length>2)s.add(w)});s.add(n);if(cat)s.add(cat.toLowerCase());const m=(addr||'').toLowerCase().match(/ул[.\s]+([а-яё\s]+\d*)/i);if(m)s.add(m[1].trim());s.delete('');return[...s].slice(0,15)}
async function save(items){const body=JSON.stringify(items);return new Promise((res,rej)=>{const o={hostname:'jgnfjawqacmaqhgpsbcj.supabase.co',path:'/rest/v1/addresses',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),'apikey':SUPABASE_KEY,'Authorization':'Bearer '+SUPABASE_KEY,'Prefer':'resolution=merge-duplicates'}};const r=https.request(o,resp=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>resp.statusCode<300?res(true):rej(new Error(d)))});r.on('error',rej);r.write(body);r.end()})}
async function main(){
if(!DGIS_API_KEY){console.error('Нет DGIS_API_KEY');process.exit(1)}
if(!SUPABASE_KEY||SUPABASE_KEY==='СЮДА_ВСТАВЬ_КЛЮЧ'){console.error('Нет SUPABASE_SERVICE_KEY');process.exit(1)}
console.log('Старт импорта из 2GIS...\n');
const all=new Map();let reqs=0;
for(const cat of CATEGORIES){
  for(let page=1;page<=5;page++){
    const url=`https://catalog.api.2gis.com/3.0/items?q=${encodeURIComponent(cat+' Осакаровка')}&point=${LON},${LAT}&radius=5000&fields=items.point,items.address,items.rubrics&page_size=10&page=${page}&key=${DGIS_API_KEY}`;
    try{
      const data=await httpGet(url);reqs++;
      if(!data.result?.items?.length)break;
      for(const item of data.result.items){
        if(all.has(item.id))continue;
        const addr=item.address?.address_name||'п. Осакаровка';
        const category=(item.rubrics||[])[0]?.name||cat;
        const kw=keywords(item.name,category,addr);
        all.set(item.id,{name:item.name,category,address:addr,lat:item.point?.lat||null,lon:item.point?.lon||null,keywords:`{${kw.map(k=>`"${k.replace(/"/g,'\\"')}"`).join(',')}}`,source:'2gis',external_id:String(item.id),is_active:true});
      }
      if(data.result.items.length<10)break;
      await new Promise(r=>setTimeout(r,200));
    }catch(e){console.log(`  Ошибка ${cat} стр${page}: ${e.message}`);break}
    if(reqs>=950){console.log('Лимит 950 запросов');goto_save=true;break}
  }
  process.stdout.write(`${cat}: ${all.size} объектов\n`);
  if(reqs>=950)break;
}
console.log(`\nВсего объектов: ${all.size}`);
const items=[...all.values()];let saved=0;
for(let i=0;i<items.length;i+=50){
  try{await save(items.slice(i,i+50));saved+=Math.min(50,items.length-i);console.log(`Сохранено: ${saved}/${items.length}`)}
  catch(e){console.error('Ошибка сохранения:',e.message)}
}
console.log(`\nГотово! Загружено ${saved} объектов`);
}
main().catch(console.error);
