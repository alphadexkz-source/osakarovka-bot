'use strict'
/**
 * Калькулятор тарифов для межгородских поездок.
 * Использует OSRM (OpenStreetMap) для получения реального времени в пути.
 * Формула: max(3500, минуты × 185 тг)
 *
 * Запуск: node tools/tariff_calculator.js
 */

const https = require('https')

// Осакаровка — точка отправления
const ORIGIN = { lat: 50.5607, lon: 72.5814 }

// Ставка за минуту и минимальный тариф
const RATE_PER_MIN = 185
const MIN_PRICE    = 3500
const ROUND_TO     = 500  // округление до 500 тг

// Все направления с координатами
const DESTINATIONS = [
  // ── Ближние сёла (до 25 км) ──────────────────────────────────
  { name: 'Озёрное',             lat: 50.6687, lon: 72.5208, yourPrice: 3500  },
  { name: 'Ералы',               lat: 50.6645, lon: 72.4842, yourPrice: 4000  },
  { name: 'Батпакты',            lat: 50.4622, lon: 72.6929, yourPrice: 3500  },
  { name: 'Есиль (5-ый)',        lat: 50.6840, lon: 72.7215, yourPrice: 3500  },
  { name: 'Анар 1',              lat: 50.6629, lon: 72.3918, yourPrice: 3500  },
  { name: '3 отделение',         lat: 50.6412, lon: 72.8501, yourPrice: 3500  },

  // ── Средние (25–55 км) ────────────────────────────────────────
  { name: 'Центральное (4-ый)',  lat: 50.6413, lon: 72.8501, yourPrice: 5000  },
  { name: 'Колхозное (8-ой)',    lat: 50.7371, lon: 72.8008, yourPrice: 5000  },
  { name: 'Пионерское (9-ый)',   lat: 50.6172, lon: 72.8901, yourPrice: 6000  },
  { name: 'Ошаганды',            lat: 50.3118, lon: 72.7330, yourPrice: 7000  },
  { name: 'Карагайлы (6-ой)',    lat: 50.8048, lon: 72.9152, yourPrice: 7000  },
  { name: 'Аршалы (Вишнёвка)',   lat: 50.8304, lon: 72.1812, yourPrice: 7000  },
  { name: 'Шокай',               lat: 50.3958, lon: 72.9972, yourPrice: null  },
  { name: 'Приишимское (11-ый)', lat: 50.6159, lon: 73.0169, yourPrice: 8000  },
  { name: 'Крещёновка',          lat: 50.6577, lon: 73.1034, yourPrice: 10000 },
  { name: 'Святогоровка',        lat: 50.7878, lon: 73.0827, yourPrice: null  },
  { name: 'Коллективное',        lat: 50.7472, lon: 73.0440, yourPrice: null  },
  { name: 'Уызбай (Морозовка)',  lat: 50.3818, lon: 71.9559, yourPrice: 10000 },
  { name: 'Садовое',             lat: 50.7877, lon: 73.0827, yourPrice: 10000 },
  { name: 'Трудовое',            lat: 50.4572, lon: 73.3201, yourPrice: null  },
  { name: 'Звёздное',            lat: 50.4793, lon: 73.2348, yourPrice: null  },
  { name: 'Мирное',              lat: 50.4292, lon: 73.2453, yourPrice: null  },

  // ── Дальние (55–120 км) ───────────────────────────────────────
  { name: 'Сункар (Скобелевка)', lat: 50.8075, lon: 72.1141, yourPrice: 7000  },
  { name: 'Акбулак',             lat: 50.8075, lon: 72.1141, yourPrice: null  },
  { name: 'Тельманское',         lat: 50.8289, lon: 73.2975, yourPrice: 15000 },
  { name: 'Молодёжный',          lat: 50.7223, lon: 73.5313, yourPrice: 15000 },
  { name: 'Николаевка (Восход)', lat: 51.0954, lon: 72.4347, yourPrice: 12000, note: 'плохая дорога' },
  { name: 'Шункыркол (Богучар)', lat: 51.1662, lon: 73.6670, yourPrice: 12000 },
  { name: 'Шідерті (Шидерты)',   lat: 50.6461, lon: 73.6135, yourPrice: null  },
  { name: 'Карасу',              lat: 51.0525, lon: 73.9499, yourPrice: null  },
  { name: 'Родниковское',        lat: 51.0446, lon: 73.9927, yourPrice: null  },

  // ── Города (фиксированные) ────────────────────────────────────
  { name: 'Темиртау',            lat: 50.0567, lon: 72.9556, yourPrice: 15000, fixed: true },
  { name: 'Карагандa',           lat: 49.8333, lon: 73.1667, yourPrice: 17000, fixed: true },
  { name: 'Астана',              lat: 51.1801, lon: 71.4460, yourPrice: 18000, fixed: true },
  { name: 'Киевка (Нура)',       lat: 50.2607, lon: 71.5527, yourPrice: 15000, fixed: true },
]

// ────────────────────────────────────────────────────────────────

const fetchOSRM = (dest) => new Promise((resolve, reject) => {
  const url = `http://router.project-osrm.org/route/v1/driving/${ORIGIN.lon},${ORIGIN.lat};${dest.lon},${dest.lat}?overview=false`
  https.get(url.replace('http:', 'https:'), (res) => {
    let data = ''
    res.on('data', chunk => data += chunk)
    res.on('end', () => {
      try {
        const json = JSON.parse(data)
        const route = json.routes?.[0]
        resolve({
          km:  route ? Math.round(route.distance / 100) / 10 : null,
          min: route ? Math.round(route.duration / 60)       : null,
        })
      } catch (e) { resolve({ km: null, min: null }) }
    })
  }).on('error', () => resolve({ km: null, min: null }))
})

const calcPrice = (min) => {
  if (!min) return null
  const raw = Math.max(MIN_PRICE, min * RATE_PER_MIN)
  return Math.round(raw / ROUND_TO) * ROUND_TO
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

const sleep = ms => new Promise(r => setTimeout(r, ms))

const main = async () => {
  console.log('\n🗺️  Калькулятор тарифов — еОсакаровка Сервис')
  console.log(`   Формула: max(${MIN_PRICE}, мин × ${RATE_PER_MIN} тг), округл. до ${ROUND_TO}\n`)
  console.log(
    pad('Направление', 26) +
    pad('км', 7) +
    pad('мин', 6) +
    pad('Формула', 11) +
    pad('Твой прайс', 12) +
    pad('Разница', 10) +
    'Заметка'
  )
  console.log('─'.repeat(90))

  const results = []

  for (const dest of DESTINATIONS) {
    await sleep(300) // вежливая пауза между запросами
    const { km, min } = await fetchOSRM(dest)
    const formula = dest.fixed ? dest.yourPrice : calcPrice(min)
    const diff = dest.yourPrice && formula
      ? Math.round((formula - dest.yourPrice) / dest.yourPrice * 100)
      : null

    const diffStr = diff !== null
      ? (diff > 0 ? `+${diff}%` : `${diff}%`)
      : '—'

    const sign = diff === null ? '' : Math.abs(diff) <= 10 ? '✅' : diff > 0 ? '🔼' : '🔽'

    console.log(
      pad(dest.name, 26) +
      padL(km ?? '?', 5) + '  ' +
      padL(min ?? '?', 4) + '  ' +
      padL(formula ? formula.toLocaleString() : '?', 9) + '  ' +
      padL(dest.yourPrice ? dest.yourPrice.toLocaleString() : '—', 10) + '  ' +
      pad(sign + ' ' + diffStr, 10) +
      (dest.note ? dest.note : '') +
      (dest.fixed ? '[фикс]' : '')
    )

    results.push({ ...dest, km, min, formula })
  }

  console.log('─'.repeat(90))
  console.log('\n💡 Рекомендуемые тарифы для добавления в БД:')
  results
    .filter(r => !r.yourPrice && r.formula)
    .forEach(r => {
      console.log(`   INSERT: "${r.name}" → ${r.formula} тг  (${r.km} км, ${r.min} мин)`)
    })
}

main().catch(console.error)
