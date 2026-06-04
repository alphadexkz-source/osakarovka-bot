'use strict'
/**
 * Калькулятор тарифов — Осакаровский + Нуринский + Аршалынский районы
 * Источник маршрутов: OSRM (OpenStreetMap)
 * Формула: max(3500, минуты × 185 тг), округл. до 500
 * Запуск: node tools/tariff_calculator.js
 */

const https = require('https')

const ORIGIN       = { lat: 50.5607, lon: 72.5814 }
const RATE_PER_MIN = 185
const MIN_PRICE    = 3500
const ROUND_TO     = 500

const DESTINATIONS = [

  // ════════════════════════════════════════════════════════════
  //  ОСАКАРОВСКИЙ РАЙОН
  // ════════════════════════════════════════════════════════════
  { sect: 'ОСАКАРОВСКИЙ РАЙОН' },

  { name: 'Озёрное',               lat: 50.6687, lon: 72.5208 },
  { name: 'Ералы',                  lat: 50.6645, lon: 72.4842 },
  { name: 'Батпакты',               lat: 50.4622, lon: 72.6929 },
  { name: 'Есиль (5-ый)',           lat: 50.6840, lon: 72.7215 },
  { name: 'Анар',                   lat: 50.6629, lon: 72.3918 },
  { name: 'Анаркол',                lat: 50.6477, lon: 72.3946 },
  { name: 'Центральное (4-ый)',     lat: 50.6413, lon: 72.8501 },
  { name: 'Колхозное (8-ой)',       lat: 50.7371, lon: 72.8008 },
  { name: 'Пионерское (9-ый)',      lat: 50.6172, lon: 72.8901 },
  { name: 'Сельстрой (3 отд.)',     lat: 50.6200, lon: 72.8300 },
  { name: 'Приишимское (11-ый)',    lat: 50.6159, lon: 73.0169 },
  { name: 'Крещёновка',             lat: 50.6577, lon: 73.1034 },
  { name: 'Карагайлы (6-ой)',       lat: 50.8048, lon: 72.9152 },
  { name: 'Коллективное',           lat: 50.7472, lon: 73.0440 },
  { name: 'Святогоровка',           lat: 50.7878, lon: 73.0827 },
  { name: 'Садовое',                lat: 50.7878, lon: 73.0827 },
  { name: 'Тельманское',            lat: 50.8289, lon: 73.2975 },
  { name: 'Молодёжный',             lat: 50.7222, lon: 73.5313 },
  { name: 'Шідерті (Шидерты)',      lat: 50.6461, lon: 73.6135 },
  { name: 'Шокай',                  lat: 50.3958, lon: 72.9972 },
  { name: 'Ошаганды',               lat: 50.3118, lon: 72.7330 },
  { name: 'Акпан',                  lat: 50.2656, lon: 72.6702 },
  { name: 'Трудовое',               lat: 50.4572, lon: 73.3201 },
  { name: 'Звёздное',               lat: 50.4793, lon: 73.2348 },
  { name: 'Мирное',                 lat: 50.4292, lon: 73.2453 },
  { name: 'Сарыозек (Вольское)',    lat: 50.4000, lon: 73.0500 },
  { name: 'Карасу',                 lat: 51.0525, lon: 73.9499 },
  { name: 'Родниковское',           lat: 51.0446, lon: 73.9927 },
  { name: 'Белоярка',               lat: 50.9702, lon: 72.9519 },
  { name: 'Шункыркол (Богучар)',    lat: 51.1123, lon: 72.3187 },
  { name: 'Уызбай (Морозовка)',     lat: 50.3818, lon: 71.9559 },
  { name: 'Константиновка',         lat: 50.8530, lon: 72.6951 },
  { name: 'Шортанды',               lat: 50.7921, lon: 72.5036 },

  // ════════════════════════════════════════════════════════════
  //  АРШАЛЫНСКИЙ РАЙОН (бывш. Вишнёвский)
  //  Центр: п. Аршалы (бывш. Вишнёвка) — Акмолинская обл.
  // ════════════════════════════════════════════════════════════
  { sect: 'АРШАЛЫНСКИЙ РАЙОН (Вишнёвский)' },

  { name: 'Аршалы (Вишнёвка)',      lat: 50.8304, lon: 72.1812 },
  { name: 'Актасты',                lat: 50.7532, lon: 72.2110 },
  { name: 'Берсуат (Раздольное)',   lat: 50.6641, lon: 72.1210 },
  { name: 'Байдала',                lat: 50.6392, lon: 72.1529 },
  { name: 'Турген (Тургеневка)',    lat: 50.7601, lon: 72.3234 },
  { name: 'Красное Озеро',          lat: 50.8027, lon: 72.3832 },
  { name: 'Родники',                lat: 50.8631, lon: 72.3303 },
  { name: 'Ижевское',               lat: 50.8800, lon: 72.1508 },
  { name: 'Акбулак (Мичурино)',     lat: 50.8075, lon: 72.1141 },
  { name: 'Сункар (Скобелевка)',    lat: 50.8199, lon: 72.0538 },
  { name: 'Николаевка (Восход)',    lat: 51.0954, lon: 72.4347, fixMin: 60, note: '⚠️ плохая дорога, 60 мин' },
  { name: 'Ольгинка',               lat: 51.0776, lon: 72.6107 },
  { name: 'Сарыоба',                lat: 51.2044, lon: 72.1838 },
  { name: 'Михайловка',             lat: 51.0078, lon: 72.2729 },
  { name: 'Арнасай (Вячеславка)',   lat: 51.0056, lon: 72.0722 },
  { name: 'Жалтырколь (Мартыновка)', lat: 50.9962, lon: 71.8410 },
  { name: 'Булаксай (Нов.Владим.)', lat: 51.2871, lon: 72.0920 },
  { name: 'Жибек Жолы (Александр.)', lat: 51.0811, lon: 71.7446 },
  { name: 'Аккайын',                lat: 51.2185, lon: 71.7020 },

  // ════════════════════════════════════════════════════════════
  //  НУРИНСКИЙ РАЙОН — Карагандинская обл.
  //  Центр: п. Нура (бывш. Киевка)
  // ════════════════════════════════════════════════════════════
  { sect: 'НУРИНСКИЙ РАЙОН' },

  { name: 'Нура (Киевка)',           lat: 50.2607, lon: 71.5527 },
  { name: 'Баршино',                 lat: 50.3800, lon: 71.3500 },
  { name: 'Жараспай',                lat: 50.1800, lon: 71.3000 },
  { name: 'Майоровка',               lat: 50.3200, lon: 71.1500 },
  { name: 'Пржевальское',            lat: 50.1500, lon: 71.6500 },
  { name: 'Шубаркуль',               lat: 50.2300, lon: 71.8800 },
  { name: 'Каракаска',               lat: 50.1200, lon: 71.4000 },
  { name: 'Майбулак',                lat: 50.0500, lon: 71.5000 },
  { name: 'Изенда',                  lat: 50.3000, lon: 71.7500 },
  { name: 'Талдысай',                lat: 50.1800, lon: 71.8000 },
  { name: 'Щербаковское',            lat: 50.4000, lon: 71.4500 },
  { name: 'Кертенди',                lat: 49.9576, lon: 71.5808 },
  { name: 'Кобакол',                 lat: 49.8431, lon: 71.8787 },

  // ════════════════════════════════════════════════════════════
  //  ГОРОДА — фиксированный прайс
  // ════════════════════════════════════════════════════════════
  { sect: 'ГОРОДА (фикс. прайс)' },

  { name: 'Темиртау',                lat: 50.0567, lon: 72.9556, yourPrice: 15000 },
  { name: 'Карагандa',               lat: 49.8333, lon: 73.1667, yourPrice: 17000 },
  { name: 'Астана',                  lat: 51.1801, lon: 71.4460, yourPrice: 18000 },
]

// ────────────────────────────────────────────────────────────────

const fetchOSRM = (dest) => new Promise((resolve) => {
  const url = `https://router.project-osrm.org/route/v1/driving/${ORIGIN.lon},${ORIGIN.lat};${dest.lon},${dest.lat}?overview=false`
  https.get(url, (res) => {
    let data = ''
    res.on('data', c => data += c)
    res.on('end', () => {
      try {
        const r = JSON.parse(data).routes?.[0]
        resolve({
          km:  r ? Math.round(r.distance / 100) / 10 : null,
          min: r ? Math.round(r.duration / 60)       : null,
        })
      } catch { resolve({ km: null, min: null }) }
    })
  }).on('error', () => resolve({ km: null, min: null }))
})

const calcPrice = (min) => min
  ? Math.round(Math.max(MIN_PRICE, min * RATE_PER_MIN) / ROUND_TO) * ROUND_TO
  : null

const pad  = (s, n) => String(s ?? '').padEnd(n)
const padL = (s, n) => String(s ?? '').padStart(n)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
  console.log('\n🗺️  Тарифы межгород — Осакаровка + 3 района')
  console.log(`   max(${MIN_PRICE}, мин × ${RATE_PER_MIN}) → округл. до ${ROUND_TO}\n`)
  console.log(pad('Населённый пункт', 30) + padL('км', 7) + padL('мин', 6) + padL('Тариф тг', 11) + '  Заметка')
  console.log('─'.repeat(72))

  for (const dest of DESTINATIONS) {
    if (dest.sect) {
      console.log(`\n  ▶ ${dest.sect}`)
      console.log('─'.repeat(72))
      continue
    }
    await sleep(280)
    const { km, min: osrmMin } = await fetchOSRM(dest)
    const min   = dest.fixMin ?? osrmMin
    const price = dest.yourPrice ?? calcPrice(min)
    console.log(
      pad(dest.name, 30) +
      padL(km  ?? '—', 6) + ' ' +
      padL(min ?? '—', 5) + ' ' +
      padL(price ? price.toLocaleString() : '—', 10) + '  ' +
      (dest.note ?? '')
    )
  }
  console.log('\n─'.repeat(72))
  console.log(`Формула: ${RATE_PER_MIN} тг/мин | Мин: ${MIN_PRICE} тг | Округл.: ${ROUND_TO}\n`)
}

main().catch(console.error)
