'use strict'
/**
 * Калькулятор тарифов межгород — Осакаровский район + города
 * OSRM: реальные дороги. Формула: max(3500, мин×185), округл. до 500
 * Запуск: node tools/tariff_calculator.js
 */

const https  = require('https')
const ORIGIN = { lat: 50.5607, lon: 72.5814 }
const RATE   = 185
const MIN    = 3500
const ROUND  = 500
const SLEEP  = 280

const DESTS = [

  // ╔══════════════════════════════════════════════════╗
  // ║         ОСАКАРОВСКИЙ РАЙОН                       ║
  // ╚══════════════════════════════════════════════════╝
  { s: '══ ОСАКАРОВСКИЙ РАЙОН ══' },

  { name: 'Озёрное',               lat: 50.6687, lon: 72.5208 },
  { name: 'Ералы',                  lat: 50.6645, lon: 72.4842 },
  { name: 'Батпакты',               lat: 50.4622, lon: 72.6929 },
  { name: 'Есиль (5-ый пос.)',      lat: 50.6840, lon: 72.7215 },
  { name: 'Анар',                   lat: 50.6629, lon: 72.3918 },
  { name: 'Анаркол',                lat: 50.6477, lon: 72.3946 },
  { name: 'Центральное (4-ый)',     lat: 50.6413, lon: 72.8501 },
  { name: 'Сельстрой (3 отд.)',     lat: 50.6200, lon: 72.8300 },
  { name: 'Колхозное (8-ой)',       lat: 50.7371, lon: 72.8008 },
  { name: 'Пионерское (9-ый)',      lat: 50.6172, lon: 72.8901 },
  { name: 'Приишимское (11-ый)',    lat: 50.6159, lon: 73.0169 },
  { name: 'Ошаганды',               lat: 50.3118, lon: 72.7330 },
  { name: 'Шокай',                  lat: 50.3958, lon: 72.9972 },
  { name: 'Акпан',                  lat: 50.2656, lon: 72.6702 },
  { name: 'Карагайлы (6-ой)',       lat: 50.8048, lon: 72.9152 },
  { name: 'Коллективное',           lat: 50.7472, lon: 73.0440 },
  { name: 'Святогоровка',           lat: 50.7878, lon: 73.0827 },
  { name: 'Садовое',                lat: 50.8030, lon: 73.1200 },
  { name: 'Крещёновка',             lat: 50.6577, lon: 73.1034 },
  { name: 'Сарыозек (Вольское)',    lat: 50.4000, lon: 73.0500 },
  { name: 'Шортанды',               lat: 50.7921, lon: 72.5036 },
  { name: 'Константиновка',         lat: 50.8530, lon: 72.6951 },
  { name: 'Уызбай (Морозовка)',     lat: 50.3818, lon: 71.9559 },
  { name: 'Тельманское',            lat: 50.8289, lon: 73.2975 },
  { name: 'Мирное',                 lat: 50.4292, lon: 73.2453 },
  { name: 'Звёздное',               lat: 50.4793, lon: 73.2348 },
  { name: 'Трудовое',               lat: 50.4572, lon: 73.3201 },
  { name: 'Молодёжный пос.',        lat: 50.7222, lon: 73.5313 },
  { name: 'Белоярка',               lat: 50.9702, lon: 72.9519 },
  { name: 'Шункыркол (Богучар)',    lat: 51.1123, lon: 72.3187 },
  { name: 'Шідерті',                lat: 50.6461, lon: 73.6135 },
  { name: 'Карасу',                 lat: 51.0525, lon: 73.9499 },
  { name: 'Родниковское',           lat: 51.0446, lon: 73.9927 },
  { name: 'Кызылтасское',           lat: 51.2249, lon: 73.6440 },
  { name: 'Жуантобе',               lat: 51.1662, lon: 73.6670 },

  // Дополнительные сёла района (из официального реестра)
  { name: 'Николаевка',             lat: 50.2842, lon: 72.2883 },  // бывш. Сабыркожа, 35 км ЮЗ
  { name: 'Сункар (Скобелевка)',    lat: 50.3817, lon: 72.2194 },  // бывш. Скобелевка, 32 км ЮЗ
  { name: 'Акбулак (Пролетарское)', lat: 50.7331, lon: 73.5300 },  // бывш. Пролетарское/Тракторист
  { name: 'Иртышское',              lat: 50.3308, lon: 73.2581 },  // бывш. совхоз Казахстан
  { name: 'Дальнее',                lat: 51.1118, lon: 73.6106 },  // 95 км от Осакаровки

  // ╔══════════════════════════════════════════════════╗
  // ║   ГОРОДА — фиксированный прайс                  ║
  // ╚══════════════════════════════════════════════════╝
  { s: '══ ГОРОДА (фиксированный прайс) ══' },
  { name: 'Темиртау',  lat: 50.0567, lon: 72.9556, fix: 15000 },
  { name: 'Карагандa', lat: 49.8333, lon: 73.1667, fix: 17000 },
  { name: 'Астана',    lat: 51.1801, lon: 71.4460, fix: 18000 },
]

// ────────────────────────────────────────────────────

const fetchOSRM = (d) => new Promise(resolve => {
  https.get(
    `https://router.project-osrm.org/route/v1/driving/${ORIGIN.lon},${ORIGIN.lat};${d.lon},${d.lat}?overview=false`,
    res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => {
        try {
          const r = JSON.parse(buf).routes?.[0]
          resolve({ km: r ? +(r.distance/1000).toFixed(1) : null,
                    min: r ? Math.round(r.duration/60)    : null })
        } catch { resolve({ km: null, min: null }) }
      })
    }
  ).on('error', () => resolve({ km: null, min: null }))
})

const price = min => min
  ? Math.round(Math.max(MIN, min * RATE) / ROUND) * ROUND
  : null

const p  = (s,n) => String(s??'').padEnd(n)
const pl = (s,n) => String(s??'').padStart(n)
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  console.log('\n🗺️  ТАРИФЫ МЕЖГОРОД — Осакаровский район + города')
  console.log(`   Формула: max(${MIN}, мин × ${RATE} тг) → округл. до ${ROUND}\n`)
  const hdr = p('Населённый пункт',32) + pl('км',6) + pl('мин',5) + pl('Тариф тг',11) + '  Заметка'
  const sep = '─'.repeat(70)

  for (const d of DESTS) {
    if (d.s) { console.log(`\n${d.s}`); console.log(sep); console.log(hdr); console.log(sep); continue }
    await sleep(SLEEP)
    const { km, min: rawMin } = await fetchOSRM(d)
    const min   = d.fixMin ?? rawMin
    const pr    = d.fix ?? price(min)
    console.log(
      p(d.name, 32) +
      pl(km  ?? '—', 5) + ' ' +
      pl(min ?? '—', 4) + ' ' +
      pl(pr  ? pr.toLocaleString() : '—', 10) + '  ' +
      (d.note ?? '')
    )
  }
  console.log('\n' + sep)
  console.log(`Формула: ${RATE} тг/мин | Мин: ${MIN} тг | Округл.: ${ROUND}\n`)
})().catch(console.error)
