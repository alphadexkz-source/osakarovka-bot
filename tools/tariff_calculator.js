'use strict'
/**
 * Тарифы межгород — Осакаровский район + соседние направления
 * Фиксированные цены: из прайс-листа владельца
 * Остальные: OSRM формула max(3500, мин×185), округл. до 500
 * Запуск: node tools/tariff_calculator.js
 */

const https  = require('https')
const ORIGIN = { lat: 50.5607, lon: 72.5814 } // центр п. Осакаровка
const RATE   = 200
const MIN    = 3500
const ROUND  = 500
const SLEEP  = 280

const DESTS = [

  // ╔══════════════════════════════════════════════════╗
  // ║  НАПРАВЛЕНИЯ С ФИКСИРОВАННОЙ ЦЕНОЙ (прайс-лист) ║
  // ╚══════════════════════════════════════════════════╝
  { s: '══ ФИКСИРОВАННЫЕ ЦЕНЫ (прайс владельца) ══' },

  // — Ближние сёла (3 500 тг) —
  { name: 'Анар',                    lat: 50.6629, lon: 72.3918, fix: 3500 },
  { name: 'Озёрное',                 lat: 50.6687, lon: 72.5208, fix: 3500 },
  { name: 'Батпакты',                lat: 50.4622, lon: 72.6929, fix: 3500 },
  { name: 'Есиль (5-й пос.)',        lat: 50.6856, lon: 72.7206, fix: 3500 },
  { name: 'Сельстрой (3 отд.)',      lat: 50.6200, lon: 72.8300, fix: 3500 },

  // — 4 000 тг —
  { name: 'Ералы',                   lat: 50.6645, lon: 72.4842, fix: 4000 },

  // — 5 000 тг —
  { name: 'Центральное (4-й пос.)',  lat: 50.6413, lon: 72.8501, fix: 5000 },
  { name: 'Колхозное (8-й пос.)',    lat: 50.7356, lon: 72.8003, fix: 5000 },

  // — 6 000 тг —
  { name: 'Пионерское (9-й пос.)',   lat: 50.6172, lon: 72.8901, fix: 6000 },

  // — 7 000 тг —
  { name: 'Ошаганды',                lat: 50.3118, lon: 72.7330, fix: 7000 },
  { name: 'Карагайлы (6-й пос.)',    lat: 50.8048, lon: 72.9152, fix: 7000 },
  { name: 'Сункар (Скобелевка)',     lat: 50.3817, lon: 72.2194, fix: 7000 },
  { name: 'Аршалы (Вишнёвка)',       lat: 50.8304, lon: 72.1812, fix: 7000 },

  // — 8 000 тг —
  { name: 'Приишимское (11-й пос.)', lat: 50.6159, lon: 73.0169, fix: 8000 },

  // — 10 000 тг —
  { name: 'Садовое',                 lat: 50.8030, lon: 73.1200, fix: 10000 },
  { name: 'Крещёновка',              lat: 50.6577, lon: 73.1034, fix: 10000 },
  { name: 'Уызбай (Морозовка)',      lat: 50.3808, lon: 71.9547, fix: 10000 },

  // — 12 000 тг —
  { name: 'Николаевка',              lat: 50.2842, lon: 72.2883, fix: 12000 },
  { name: 'Шункыркол (Богучар)',     lat: 51.1123, lon: 72.3187, fix: 12000 },

  // — 15 000 тг —
  { name: 'Тельманское',             lat: 50.8289, lon: 73.2975, fix: 15000 },
  { name: 'Молодёжный',              lat: 50.7222, lon: 73.5313, fix: 15000 },
  { name: 'Киевка (Нура)',           lat: 50.2607, lon: 71.5527, fix: 15000 },

  // ╔══════════════════════════════════════════════════╗
  // ║  ОСТАЛЬНЫЕ СЁЛА РАЙОНА — расчёт по формуле      ║
  // ╚══════════════════════════════════════════════════╝
  { s: '══ ПО ФОРМУЛЕ (нет в прайсе) ══' },

  { name: 'Анаркол',                 lat: 50.6477, lon: 72.3946 },
  { name: 'Акпан',                   lat: 50.2656, lon: 72.6702 },
  { name: 'Шокай',                   lat: 50.3958, lon: 72.9972 },
  { name: 'Святогоровка',            lat: 50.7878, lon: 73.0827 },
  { name: 'Коллективное',            lat: 50.7472, lon: 73.0440 },
  { name: 'Шортанды',                lat: 50.7921, lon: 72.5036 },
  { name: 'Константиновка',          lat: 50.8530, lon: 72.6951 },
  { name: 'Сарыозек (Вольское)',     lat: 50.4000, lon: 73.0500 },
  { name: 'Акбулак (Пролетарское)',  lat: 50.7331, lon: 73.5300 },
  { name: 'Трудовое',                lat: 50.4572, lon: 73.3201 },
  { name: 'Мирное',                  lat: 50.4292, lon: 73.2453 },
  { name: 'Жулдыз (Звёздное)',       lat: 50.4825, lon: 73.2358 },
  { name: 'Иртышское',               lat: 50.3308, lon: 73.2581 },
  { name: 'Каратомар (Сенокосное)',  lat: 50.1175, lon: 73.4367 },
  { name: 'Белоярка',                lat: 50.9702, lon: 72.9519 },
  { name: 'Шідерті',                 lat: 50.6461, lon: 73.6135 },
  { name: 'Карасу',                  lat: 51.0525, lon: 73.9499 },
  { name: 'Родниковское',            lat: 51.0446, lon: 73.9927 },
  { name: 'Аманконыр (Дальнее)',     lat: 51.1118, lon: 73.6106 },
  { name: 'Кызылтасское',            lat: 51.2249, lon: 73.6440 },
  { name: 'Жуантобе',                lat: 51.1662, lon: 73.6670 },

  // ╔══════════════════════════════════════════════════╗
  // ║   ГОРОДА — фиксированный прайс                  ║
  // ╚══════════════════════════════════════════════════╝
  { s: '══ ГОРОДА (фиксированный прайс) ══' },
  { name: 'Темиртау',  lat: 50.0567, lon: 72.9556, fix: 15000 },
  { name: 'г. Карагандa', lat: 49.8333, lon: 73.1667, fix: 17000 },
  { name: 'Астана',    lat: 51.1801, lon: 71.4460, fix: 18000 },
]

// ────────────────────────────────────────────────────

const DGIS_KEY = process.env.DGIS_API_KEY || '43555b4f-e473-4a21-bfdc-4f6120c52d05'

// 2GIS Routing API — такси-маршрут с учётом дорог Казахстана
// Ограничение demo-ключа: max 50 км
const fetch2GIS = (d) => new Promise(resolve => {
  const body = JSON.stringify({
    points: [
      { type: 'pedo', lon: ORIGIN.lon, lat: ORIGIN.lat },
      { type: 'pedo', lon: d.lon,      lat: d.lat      },
    ],
    transport: 'taxi',
  })
  const req = https.request({
    hostname: 'routing.api.2gis.com',
    path:     `/routing/7.0.0/global?key=${DGIS_KEY}`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let buf = ''
    res.on('data', c => buf += c)
    res.on('end', () => {
      try {
        const r = JSON.parse(buf)
        if (r.status !== 'OK' || !r.result?.[0]) { resolve(null); return }
        const route = r.result[0]
        resolve({
          km:  +(route.total_distance / 1000).toFixed(1),
          min: Math.round(route.total_duration / 60),
          src: '2GIS',
        })
      } catch { resolve(null) }
    })
  })
  req.on('error', () => resolve(null))
  req.write(body)
  req.end()
})

// OSRM fallback — для маршрутов >50 км
const fetchOSRM = (d) => new Promise(resolve => {
  https.get(
    `https://router.project-osrm.org/route/v1/driving/${ORIGIN.lon},${ORIGIN.lat};${d.lon},${d.lat}?overview=false`,
    res => {
      let buf = ''
      res.on('data', c => buf += c)
      res.on('end', () => {
        try {
          const r = JSON.parse(buf).routes?.[0]
          resolve(r ? {
            km:  +(r.distance / 1000).toFixed(1),
            min: Math.round(r.duration / 60),
            src: 'OSRM',
          } : null)
        } catch { resolve(null) }
      })
    }
  ).on('error', () => resolve(null))
})

// Основная функция: пробуем 2GIS, при ошибке — OSRM
const fetchRoute = async (d) => {
  const r2gis = await fetch2GIS(d)
  if (r2gis) return r2gis
  return await fetchOSRM(d) || { km: null, min: null, src: '?' }
}

const calcPrice = min => min
  ? Math.round(Math.max(MIN, min * RATE) / ROUND) * ROUND
  : null

const p  = (s,n) => String(s??'').padEnd(n)
const pl = (s,n) => String(s??'').padStart(n)
const sleep = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  console.log('\n🗺️  ТАРИФЫ МЕЖГОРОД — Осакаровский район')
  console.log(`   Формула: max(${MIN}, мин × ${RATE} тг) → округл. до ${ROUND}\n`)
  const hdr = p('Населённый пункт',32) + pl('км',6) + pl('мин',5) + pl('Тариф тг',11) + '  Тип'
  const sep = '─'.repeat(68)

  for (const d of DESTS) {
    if (d.s) { console.log(`\n${d.s}`); console.log(sep); console.log(hdr); console.log(sep); continue }
    await sleep(SLEEP)
    const { km, min, src } = await fetchRoute(d)
    const pr = d.fix ?? calcPrice(min)
    const type = d.fix ? 'фикс' : `формула(${src})`
    console.log(
      p(d.name, 32) +
      pl(km  ?? '—', 5) + ' ' +
      pl(min ?? '—', 4) + ' ' +
      pl(pr  ? pr.toLocaleString() : '—', 10) + '  ' + type
    )
  }
  console.log('\n' + sep)
  console.log(`Формула: ${RATE} тг/мин | Мин: ${MIN} тг | Округл.: ${ROUND}\n`)
})().catch(console.error)
