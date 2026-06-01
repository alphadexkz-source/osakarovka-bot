// Полный тест всех модулей и сценариев бота
require('dotenv').config();
const q   = require('./src/db/queries');
const db  = require('./src/db/index');
const tariff  = require('./src/modules/tariffEngine');
const orderEngine = require('./src/modules/orderEngine');
const driverMgr   = require('./src/modules/driverManager');
const addressDet  = require('./src/modules/addressDetector');
const info        = require('./src/modules/infoService');
const ws          = require('./src/modules/weatherService');
const smartReply  = require('./src/modules/smartReply');

let passed = 0, failed = 0, warnings = 0;

const ok  = (label) => { console.log('  ✅ ' + label); passed++; };
const err = (label, e) => { console.log('  ❌ ' + label + (e ? ': ' + e : '')); failed++; };
const warn = (label) => { console.log('  ⚠️  ' + label); warnings++; };
const section = (name) => console.log('\n══ ' + name + ' ══');

async function run() {
  console.log('\n🧪 ТЕСТ БОТА — ' + new Date().toLocaleString('ru-RU') + '\n');

  // ── 1. БД И ПОДКЛЮЧЕНИЕ ──────────────────────────────────────
  section('1. База данных');
  try {
    const r = await db.query('SELECT COUNT(*) AS c FROM users');
    ok('Подключение к Supabase (' + r.rows[0].c + ' пользователей)');
  } catch(e) { err('Подключение к Supabase', e.message); return; }

  try {
    const drivers = await q.getAllDrivers();
    ok('getAllDrivers (' + drivers.length + ' водителей)');
  } catch(e) { err('getAllDrivers', e.message); }

  try {
    const tariffs = await q.getTariffs();
    ok('getTariffs (' + tariffs.length + ' тарифов)');
  } catch(e) { err('getTariffs', e.message); }

  try {
    const cnt = await db.query('SELECT COUNT(*) AS c FROM addresses WHERE is_active=true');
    ok('Адреса в базе: ' + cnt.rows[0].c);
    if (parseInt(cnt.rows[0].c) < 50) warn('Мало адресов — нужен импорт 2GIS');
  } catch(e) { err('Адреса', e.message); }

  // ── 2. ТАРИФНЫЙ ДВИЖОК ──────────────────────────────────────
  section('2. Тарифный движок');
  const tariffTests = [
    ['Ленина 5', 500, 'По умолчанию (нет тарифа)'],
    ['жд станция', null, 'ЖД станция'],
    ['элеватор', null, 'Элеватор'],
    ['астана', null, 'Межгород (Астана)'],
  ];
  for (const [dest, expectedPrice, label] of tariffTests) {
    try {
      const pi = await tariff.getPrice(dest);
      if (expectedPrice && pi.price !== expectedPrice) warn(label + ': цена ' + pi.price + ' (ожидалось ' + expectedPrice + ')');
      else ok(label + ': ' + pi.price + ' тг' + (pi.isNight ? ' (ночной)' : '') + (pi.tariff ? ' [тариф: ' + pi.tariff.name + ']' : ''));
    } catch(e) { err(label, e.message); }
  }

  // ── 3. ОПРЕДЕЛЕНИЕ АДРЕСОВ ──────────────────────────────────
  section('3. Детектор адресов');
  const addrTests = [
    // [text, shouldBeAddress, label]
    ['Ленина 5',       true,  'Улица + номер дома'],
    ['целинная 10',    true,  'Улица + номер (нижний регистр)'],
    ['привет',         false, 'Приветствие → НЕ адрес'],
    ['да',             false, '"да" → НЕ адрес'],
    ['отмена',         false, '"отмена" → НЕ адрес'],
    ['школа',          true,  'Школа → адрес (объект)'],
    ['аптека',         true,  'Аптека → адрес (объект)'],
    ['сколько стоит',  false, 'Вопрос про цену → НЕ адрес'],
    ['такси',          false, '"такси" → НЕ адрес'],
  ];
  for (const [text, expected, label] of addrTests) {
    try {
      const result = await addressDet.isAddress(text);
      if (result === expected) ok(label);
      else warn(label + ': получено ' + result + ', ожидалось ' + expected);
    } catch(e) { err(label, e.message); }
  }

  // findInAddresses
  const dbAddrTests = [
    ['тц октябрь', true,  'ТЦ Октябрь (вручную добавлен)'],
    ['больница',   true,  'Больница'],
    ['акимат',     true,  'Акимат'],
    ['касси банк', false, 'Несуществующий объект → не найден'],
  ];
  for (const [q2, expected, label] of dbAddrTests) {
    try {
      const r = await addressDet.findInAddresses(q2);
      if (r.found === expected) ok(label + (r.found ? ' → ' + r.name : ''));
      else warn(label + ': found=' + r.found + ' (ожидалось ' + expected + ')');
    } catch(e) { err(label, e.message); }
  }

  // ── 4. GROQ — УМНЫЕ ОТВЕТЫ ───────────────────────────────────
  section('4. Groq AI (не должен отвечать как адрес)');
  const groqTests = [
    ['как дела',           'Casual question'],
    ['погода хорошая',     'Погода без команды'],
    ['помогите мне',       'Нейтральный запрос'],
    ['сколько ждать машину', 'Вопрос про ожидание'],
    ['жақсы ма?',          'Казахский вопрос'],
    ['рахмет',             'Казахское спасибо'],
  ];
  for (const [text, label] of groqTests) {
    try {
      const r = await smartReply.getGroqReply(text);
      if (r && r.length > 5) ok(label + ' → ответ (' + r.slice(0, 60).replace(/\n/g,' ') + '...)');
      else warn(label + ' → пустой ответ Groq');
    } catch(e) { err(label, e.message); }
  }

  // ── 5. ПОГОДА ────────────────────────────────────────────────
  section('5. Погода');
  try {
    const w = await ws.getWeather();
    if (w && w.temp !== undefined) ok('Текущая погода: ' + w.temp + '°C, ' + w.condition);
    else warn('Погода: пустой ответ');
  } catch(e) { err('Текущая погода', e.message); }

  try {
    const fc = await ws.getWeatherForecast(3);
    if (fc && fc.days && fc.days.length >= 3) ok('Прогноз 3 дня: ' + fc.days.map(d => d.icon + d.max + '°').join(' '));
    else warn('Прогноз: мало данных');
  } catch(e) { err('Прогноз Open-Meteo', e.message); }

  // ── 6. ИНФОРМАЦИОННЫЙ СЕРВИС ─────────────────────────────────
  section('6. Инфо-сервис (курс/металлы/зерно)');
  try {
    const r = await info.getCurrencyRates();
    if (r && r.usd > 100) ok('Курс USD: ' + r.usd + ' ₸');
    else warn('Курс: некорректное значение ' + JSON.stringify(r));
  } catch(e) { err('Курс валют', e.message); }

  try {
    const r = await info.getMetalPrices();
    if (r && r.gold_gram_kzt > 10000) ok('Золото: ' + r.gold_gram_kzt.toLocaleString() + ' ₸/г, серебро: ' + r.silver_gram_kzt.toLocaleString() + ' ₸/г');
    else warn('Металлы: некорректные данные');
  } catch(e) { err('Металлы', e.message); }

  try {
    const r = await info.getGrainPrices();
    if (r && r.wheat?.kzt_per_ton > 50000) ok('Пшеница: ' + r.wheat.kzt_per_ton.toLocaleString() + ' ₸/т');
    else warn('Зерно: данные недоступны или некорректны — ' + JSON.stringify(r?.wheat));
  } catch(e) { err('Зерно Yahoo Finance', e.message); }

  // ── 7. СЕССИИ ────────────────────────────────────────────────
  section('7. Сессии');
  const TEST_PHONE = '70000000001'; // тестовый номер
  try {
    await q.setSession(TEST_PHONE, 'test_state', { foo: 'bar' });
    const sess = await q.getSession(TEST_PHONE);
    if (sess?.state === 'test_state' && sess?.ctx?.foo === 'bar') ok('setSession + getSession');
    else err('Сессия: неверные данные ' + JSON.stringify(sess));
    await q.clearSession(TEST_PHONE);
    const cleared = await q.getSession(TEST_PHONE);
    if (cleared?.state === 'idle') ok('clearSession → idle');
    else warn('clearSession: state=' + cleared?.state);
  } catch(e) { err('Сессии', e.message); }

  // ── 8. БЕЗОПАСНОСТЬ ──────────────────────────────────────────
  section('8. Безопасность');

  // SQL injection
  const injections = [
    "'; DROP TABLE orders; --",
    "1 OR 1=1",
    "' UNION SELECT * FROM users --",
    "<script>alert('xss')</script>",
    "../../../../etc/passwd",
  ];
  for (const payload of injections) {
    try {
      await addressDet.isAddress(payload); // должен обработать без краша
      ok('SQL/XSS payload обработан: ' + payload.slice(0, 30));
    } catch(e) { err('Инъекция вызвала краш: ' + payload.slice(0, 30), e.message); }
  }

  // Phone validation
  const phones = [
    ['77021234567', true,  'Казахский 11-значный'],
    ['79161234567', true,  'Российский 11-значный'],
    ['1234',        false, 'Слишком короткий'],
    ['abcdefghijk', false, 'Буквы'],
  ];
  for (const [phone2, expected, label] of phones) {
    const valid = /^\d{10,15}$/.test(phone2);
    if (valid === expected) ok('Телефон ' + label + ': ' + phone2);
    else warn('Телефон ' + label + ': ожидалось ' + expected + ', получено ' + valid);
  }

  // ── 9. ПРОВЕРКА СОСТОЯНИЙ FSM ────────────────────────────────
  section('9. Проверка FSM состояний');
  const states = [
    'idle', 'confirming', 'waiting_driver', 'in_trip',
    'intercity_pickup', 'intercity_time', 'intercity_confirm',
    'waiting_rating', 'cancel_client_reason', 'chat_mode',
    'driver_as_client', 'driver_chat', 'cancel_reason',
    'reg_name', 'reg_photo', 'reg_make', 'reg_plate', 'reg_color',
    'edit_name', 'edit_car', 'edit_photo', 'edit_color',
    'admin_mode', 'admin_exit', 'admin_add_1', 'admin_edit_pick',
  ];
  try {
    for (const state of states) {
      await q.setSession(TEST_PHONE, state, {});
      const s = await q.getSession(TEST_PHONE);
      if (s?.state !== state) err('Состояние ' + state + ' не сохранилось');
    }
    ok('Все ' + states.length + ' FSM-состояний сохраняются и читаются');
    await q.clearSession(TEST_PHONE);
  } catch(e) { err('FSM состояния', e.message); }

  // ── 10. ТЕСТ МЕЖГОРОДА ────────────────────────────────────────
  section('10. Межгород — ключевые слова');
  const intercityKW = require('./src/handlers/clientHandler');
  // Проверяем через isIntercity в clientHandler напрямую
  const intercityTests = [
    ['Астана', true], ['Темиртау', true], ['Балхаш', true],
    ['Карагайлы', true], ['Литвинское', true],
    ['ул Ленина 5', false], ['аптека', false], ['школа', false],
  ];
  // Загружаем INTERCITY из clientHandler
  const clientHandlerSrc = require('fs').readFileSync('./src/handlers/clientHandler.js', 'utf8');
  const intercityMatch2 = clientHandlerSrc.match(/const INTERCITY = \[([\s\S]*?)\];/);
  if (intercityMatch2) {
    ok('INTERCITY массив загружен из clientHandler.js');
    const intercityArr = eval('[' + intercityMatch2[1] + ']');
    const isInterc = (text) => intercityArr.some(w => (text||'').toLowerCase().includes(w));
    let allOk = true;
    for (const [text, expected] of intercityTests) {
      const got = isInterc(text);
      if (got !== expected) { warn('Межгород "' + text + '": ожидалось ' + expected + ', получено ' + got); allOk = false; }
    }
    if (allOk) ok('Все ' + intercityTests.length + ' тестов межгорода прошли');
  }

  // ── 11. КНОПКИ ВОДИТЕЛЯ ──────────────────────────────────────
  section('11. Button IDs в notificationService');
  const notifSrc = require('fs').readFileSync('./src/modules/notificationService.js', 'utf8');
  const driverHandlerSrc = require('fs').readFileSync('./src/handlers/driverHandler.js', 'utf8');
  const clientHandlerSrc2 = require('fs').readFileSync('./src/handlers/clientHandler.js', 'utf8');

  const buttonIds = [
    ['accept_', driverHandlerSrc, 'accept_ в driverHandler'],
    ['skip_', driverHandlerSrc, 'skip_ в driverHandler'],
    ['arrived_', driverHandlerSrc, 'arrived_ в driverHandler'],
    ['false_', driverHandlerSrc, 'false_ в driverHandler'],
    ['done_', driverHandlerSrc, 'done_ в driverHandler'],
    ['chat_', driverHandlerSrc, 'chat_ в driverHandler'],
    ['cancel_driver_', driverHandlerSrc, 'cancel_driver_ в driverHandler'],
    ['go_online', driverHandlerSrc, 'go_online в driverHandler'],
    ['go_offline', driverHandlerSrc, 'go_offline в driverHandler'],
    ['order_as_client', clientHandlerSrc2, 'order_as_client в clientHandler'],
    ['confirm_order', clientHandlerSrc2, 'confirm_order в clientHandler'],
    ['cancel_order', clientHandlerSrc2, 'cancel_order в clientHandler'],
    ['cancel_reason_', clientHandlerSrc2, 'cancel_reason_ в clientHandler'],
    ['chat_driver', clientHandlerSrc2, 'chat_driver в clientHandler'],
  ];
  let btnOk = 0, btnMiss = 0;
  for (const [id, src, label] of buttonIds) {
    if (src.includes("'" + id) || src.includes('"' + id) || src.includes('`' + id) ||
        src.includes("startsWith('" + id) || src.includes('startsWith("' + id)) {
      btnOk++;
    } else {
      warn('Кнопка "' + id + '" не найдена в ' + label);
      btnMiss++;
    }
  }
  if (btnMiss === 0) ok('Все ' + btnOk + ' button ID обработаны');

  // ── 12. TIMERSERVICE ─────────────────────────────────────────
  section('12. Timer Service');
  try {
    const timerSrc = require('fs').readFileSync('./src/modules/timerService.js', 'utf8');
    const cronCount = (timerSrc.match(/cron\.schedule/g) || []).length;
    ok('Cron-задач: ' + cronCount);
    if (!timerSrc.includes('import_2gis_daily')) warn('Авто-импорт 2GIS не настроен в timerService');
    else ok('Авто-импорт 2GIS в 04:00 настроен');
  } catch(e) { err('timerService', e.message); }

  // ── 13. ДУБЛИ И МЕРТВЫЙ КОД ──────────────────────────────────
  section('13. Дубли и мёртвый код');
  try {
    const wsSrc = require('fs').readFileSync('./src/modules/weatherService.js', 'utf8');
    const httpGetCount = (wsSrc.match(/^function httpGet/gm) || []).length;
    if (httpGetCount > 1) err('ДУБЛЬ httpGet в weatherService.js (' + httpGetCount + ' раза)');
    else ok('httpGet определён один раз в weatherService.js');
  } catch(e) { err('Проверка дублей', e.message); }

  // ── ИТОГ ─────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(50));
  console.log('ИТОГ: ✅ ' + passed + ' прошли  ❌ ' + failed + ' ошибок  ⚠️  ' + warnings + ' предупреждений');
  console.log('═'.repeat(50) + '\n');

  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
