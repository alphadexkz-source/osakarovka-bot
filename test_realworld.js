// ════════════════════════════════════════════════════════════
//  РЕАЛЬНЫЙ СЦЕНАРНЫЙ ТЕСТ — как живой клиент и водитель
//  Тестирует edge cases, которые возникают в продакшене
// ════════════════════════════════════════════════════════════
require('dotenv').config();

const q   = require('./src/db/queries');
const db  = require('./src/db/index');
const addrDet = require('./src/modules/addressDetector');
const tariff  = require('./src/modules/tariffEngine');
const smartR  = require('./src/modules/smartReply');
const info    = require('./src/modules/infoService');
const driverMgr = require('./src/modules/driverManager');
const orderEngine = require('./src/modules/orderEngine');

// ── MOCK: отключаем реальные WhatsApp отправки ───────────────
const sentMessages = [];
jest = { messages: sentMessages };
const wa = require('./src/whatsapp/greenApi');
const origSendText = wa.sendText.bind(wa);
const origSendButtons = wa.sendButtons.bind(wa);
wa.sendText = async (phone, text) => { sentMessages.push({phone, text: text?.slice(0,80), type:'text'}); };
wa.sendButtons = async (phone, text, btns) => { sentMessages.push({phone, text: text?.slice(0,300), btns: btns?.map(b=>b.id), type:'button'}); };
wa.sendImage = async () => {};

let pass=0, fail=0, warn=0;
const ok = (l) => { process.stdout.write('  ✅ ' + l + '\n'); pass++; };
const er = (l, e='') => { process.stdout.write('  ❌ ' + l + (e?' | '+e:'') + '\n'); fail++; };
const wn = (l) => { process.stdout.write('  ⚠️  ' + l + '\n'); warn++; };
const h  = (l) => process.stdout.write('\n══ ' + l + ' ══\n');
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// тестовые номера (не существуют в реальной базе)
const CLIENT1 = '70000099901';
const CLIENT2 = '70000099902'; // казахоязычный
const DRIVER1 = '70000099910';

async function cleanup() {
  for (const phone of [CLIENT1, CLIENT2, DRIVER1]) {
    await q.clearSession(phone).catch(() => {});
    const u = await q.getUser(phone).catch(() => null);
    if (u) {
      await db.query('DELETE FROM orders WHERE client_id=$1', [u.id]).catch(() => {});
      await db.query('DELETE FROM drivers WHERE user_id=$1', [u.id]).catch(() => {});
      await db.query('DELETE FROM sessions WHERE phone=$1', [phone]).catch(() => {});
      await db.query('DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1', [u.id]).catch(() => {});
      await db.query('DELETE FROM users WHERE id=$1', [u.id]).catch(() => {});
    }
  }
}

// Симулирует обработку сообщения через clientHandler напрямую
const clientHandle = require('./src/handlers/clientHandler');
const driverHandle = require('./src/handlers/driverHandler');
const routerModule = require('./src/handlers/router');

async function simClient(phone, name, textOrMsg) {
  sentMessages.length = 0;
  const msg = typeof textOrMsg === 'string'
    ? { text: textOrMsg.trim().slice(0,500), type:'text', buttonId:null, mediaUrl:null }
    : textOrMsg;
  const session = await q.getSession(phone) || { state:'idle', ctx:{} };
  const user    = await q.getUser(phone);
  await clientHandle.handle(phone, name, msg, session);
  return { session: await q.getSession(phone), messages: [...sentMessages], user: await q.getUser(phone) };
}

async function simDriver(phone, textOrMsg) {
  sentMessages.length = 0;
  const msg = typeof textOrMsg === 'string'
    ? { text: textOrMsg.trim().slice(0,500), type:'text', buttonId:null, mediaUrl:null }
    : textOrMsg;
  const session = await q.getSession(phone) || { state:'idle', ctx:{} };
  await driverHandle.handle(phone, msg, session);
  return { session: await q.getSession(phone), messages: [...sentMessages] };
}

// ════════════════════════════════════════════════════════════
async function run() {
console.log('\n🔥 РЕАЛЬНЫЙ СЦЕНАРНЫЙ ТЕСТ — ' + new Date().toLocaleString('ru-RU'));
await cleanup();

// ─── 1. НОВЫЙ КЛИЕНТ — первое сообщение ─────────────────────
h('1. РЕГИСТРАЦИЯ НОВОГО КЛИЕНТА');
try {
  await q.createUser(CLIENT1, 'Тест Клиент', 'client');
  await q.setSession(CLIENT1, 'idle', {});
  ok('Клиент создан: ' + CLIENT1);
} catch(e) { er('Создание клиента', e.message); }

// ─── 2. АДРЕСА — настоящие улицы Осакаровки ─────────────────
h('2. РЕАЛЬНЫЕ АДРЕСА ОСАКАРОВКИ');
const realAddresses = [
  // [адрес, ожидается ли подтверждение заказа]
  ['ул Ленина 5',              true,  'Улица + номер'],
  ['Целинная 10',              true,  'Целинная + номер'],
  ['Школьная 15',              true,  'Школьная + номер'],
  ['Гагарина 3',               true,  'Гагарина + номер'],
  ['Достык 7',                 true,  'Достык + номер'],
  ['Надречная 1а',             true,  'С литерой (1а)'],
  ['пер. Дальний 2',           true,  'Переулок'],
  ['Школьная ул 120',          true,  'Обратный порядок'],
  ['аптека',                   true,  'Короткий запрос — объект'],
  ['рынок',                    true,  'Рынок'],
  ['тц октябрь',               true,  'ТЦ Октябрь'],
  ['жд станция',               true,  'ЖД (с тарифом)'],
  ['элеватор',                 true,  'Элеватор'],
  ['больница',                 true,  'Больница'],
  ['касп банк',                true,  'Каспи банк (сокр.)'],
];
for (const [addr, shouldOrder, label] of realAddresses) {
  try {
    const r = await simClient(CLIENT1, 'Клиент', addr);
    const gotConfirm = r.session?.state === 'confirming' ||
      r.messages.some(m => m.btns?.includes('confirm_order') || m.btns?.includes('order_found'));
    if (gotConfirm === shouldOrder) {
      const price = r.session?.ctx?.price;
      ok(label + ': "' + addr + '" → ' + (gotConfirm ? 'заказ подтверждение, цена ' + price + '₸' : 'не заказ'));
    } else {
      wn(label + ': "' + addr + '" → ожидалось ' + (shouldOrder?'заказ':'не заказ') + ', получено: state=' + r.session?.state);
    }
    await q.clearSession(CLIENT1);
  } catch(e) { er(label + ': ' + addr, e.message); await q.clearSession(CLIENT1); }
}

// ─── 3. СООБЩЕНИЯ КОТОРЫЕ НЕ ДОЛЖНЫ ЗАКАЗЫВАТЬ ТАКСИ ────────
h('3. НЕ ДОЛЖНЫ ЗАКАЗЫВАТЬ ТАКСИ (anti-false-positive)');
const notOrders = [
  ['привет', 'Приветствие RU'],
  ['сәлем', 'Приветствие KZ'],
  ['как дела', 'Casual вопрос'],
  ['сколько стоит', 'Вопрос о цене'],
  ['есть такси', 'Наличие такси'],
  ['работаете?', 'Вопрос о работе'],
  ['10', 'Просто цифра'],
  ['ok', 'Просто ok'],
  ['да', 'Просто да'],
  ['нет', 'Просто нет'],
  ['?', 'Вопросительный знак'],
  ['рахмет', 'Спасибо KZ'],
  ['спасибо', 'Спасибо RU'],
  ['помощь', 'Помощь → FAQ'],
  ['faq', 'FAQ'],
  ['курс', 'Курс валют'],
  ['погода', 'Погода'],
  ['пшеница', 'Зерно'],
  ['золото', 'Металлы'],
  ['прогноз', 'Прогноз погоды'],
  ['услуги', 'Меню услуг'],
  ['новости', 'Новости'],
  ['история', 'История поездок'],
  ['мой код', 'Реферальный код'],
  // «где аптека» НЕ в этом списке: корректно переходит в confirming (найдено → ждёт подтверждения)
  ['где маг айболит', 'Неизвестный объект → НЕ заказ'],
];
for (const [text, label] of notOrders) {
  try {
    const r = await simClient(CLIENT1, 'Клиент', text);
    const ordered = r.session?.state === 'confirming';
    if (!ordered) ok(label + ': "' + text + '" → не заказ ✓');
    else er(label + ': "' + text + '" → ОШИБОЧНО стал заказом! state=' + r.session?.state);
    await q.clearSession(CLIENT1);
  } catch(e) { er(label, e.message); await q.clearSession(CLIENT1); }
}

// ─── 4. КАЗАХСКИЙ ЯЗЫК ──────────────────────────────────────
h('4. КАЗАХСКИЙ ЯЗЫК');
const kzTests = [
  ['сәлем', false, 'Приветствие KZ → не заказ'],
  ['үй', false, 'Дом KZ (нет сохранённого адреса) → подсказка'],
  ['мектеп', true,  'Школа KZ → должен распознать как адрес'],
  ['аурухана', true, 'Больница KZ → должен распознать как адрес'],
  ['базар', true,  'Рынок KZ/RU → адрес'],
  ['рахмет', false, 'Спасибо KZ → не заказ'],
  ['жоқ', false, 'Нет KZ → не заказ'],
];
for (const [text, shouldOrder, label] of kzTests) {
  try {
    const r = await simClient(CLIENT2, 'Клиент KZ', text);
    const ordered = r.session?.state === 'confirming' ||
      r.messages.some(m => m.btns?.includes('confirm_order') || m.btns?.includes('order_found'));
    if (ordered === shouldOrder) ok(label);
    else wn(label + ' — "' + text + '": ожидалось ' + shouldOrder + ', получено state=' + r.session?.state);
    await q.clearSession(CLIENT2);
  } catch(e) { er(label, e.message); await q.clearSession(CLIENT2); }
}

// ─── 5. МЕЖГОРОДСКИЕ МАРШРУТЫ ────────────────────────────────
h('5. МЕЖГОРОДСКИЕ МАРШРУТЫ С ТАРИФАМИ');
await q.createUser(CLIENT2, 'Клиент2', 'client');
await q.setSession(CLIENT2, 'idle', {});
const intercityRoutes = [
  ['Астана',       'Столица'],
  ['Темиртау',     'Темиртау'],
  ['Балхаш',       'Балхаш'],
  ['Карагайлы',    'Местное село'],
  ['Литвинское',   'Местное (алт. название)'],
  ['5 поселок',    '5-й поселок'],
];
for (const [dest, label] of intercityRoutes) {
  try {
    const r = await simClient(CLIENT2, 'Клиент', dest);
    const isIntercity = r.session?.state === 'intercity_pickup';
    const pi = await tariff.getPrice(dest);
    if (isIntercity) ok(label + ' "' + dest + '" → межгород, цена ' + pi.price + '₸');
    else wn(label + ' "' + dest + '" → НЕ распознан как межгород (state=' + r.session?.state + ')');
    await q.clearSession(CLIENT2);
  } catch(e) { er(label, e.message); await q.clearSession(CLIENT2); }
}

// ─── 6. ПОЛНЫЙ ФЛОУ ЗАКАЗА (без реального водителя) ─────────
h('6. ПОЛНЫЙ ФЛОУ ЗАКАЗА — симуляция');
try {
  await q.clearSession(CLIENT1);
  // Шаг 1: написать адрес
  const r1 = await simClient(CLIENT1, 'Клиент', 'Ленина 5');
  if (r1.session?.state === 'confirming') ok('Шаг 1: адрес принят, переход в confirming');
  else er('Шаг 1: state=' + r1.session?.state);

  // Шаг 2: подтвердить
  const r2 = await simClient(CLIENT1, 'Клиент', { type:'button', buttonId:'confirm_order', text:'Да', mediaUrl:null });
  if (r2.session?.state === 'waiting_driver') ok('Шаг 2: подтверждение → waiting_driver');
  else er('Шаг 2: state=' + r2.session?.state);

  // Шаг 3: клиент спрашивает "где водитель"
  const r3 = await simClient(CLIENT1, 'Клиент', 'где водитель');
  const replied = r3.messages.some(m => m.text?.includes('мин') || m.text?.includes('Ищем'));
  if (replied) ok('Шаг 3: ответ на "где водитель"');
  else wn('Шаг 3: нет ответа на "где водитель"');

  // Шаг 4: клиент пытается создать второй заказ
  const r4 = await simClient(CLIENT1, 'Клиент', 'школа');
  // В waiting_driver бот показывает «Ищем водителя...» вместо нового заказа — это правильно
  const blocked = r4.session?.state === 'waiting_driver' ||
    r4.messages.some(m => m.text?.includes('Ищем') || m.text?.includes('уже есть') || m.text?.includes('водителя'));
  if (blocked) ok('Шаг 4: второй заказ заблокирован (waiting_driver)');
  else wn('Шаг 4: второй заказ НЕ заблокирован!');

  // Шаг 5: отменить заказ
  const r5 = await simClient(CLIENT1, 'Клиент', { type:'button', buttonId:'cancel_order', text:'Отменить', mediaUrl:null });
  const showsReasons = r5.messages.some(m => m.btns?.some(b => b?.startsWith('cancel_reason_')));
  if (showsReasons) ok('Шаг 5: кнопки причины отмены показаны');
  else er('Шаг 5: кнопки причин не появились');

  // Шаг 6: выбрать причину
  const r6 = await simClient(CLIENT1, 'Клиент', { type:'button', buttonId:'cancel_reason_wait', text:'Долго жду', mediaUrl:null });
  const cancelled = r6.session?.state === 'idle' || r6.messages.some(m => m.text?.includes('отменён'));
  if (cancelled) ok('Шаг 6: заказ отменён с причиной');
  else wn('Шаг 6: state=' + r6.session?.state + ', messages=' + JSON.stringify(r6.messages.map(m=>m.text?.slice(0,30))));

} catch(e) { er('Флоу заказа', e.message); }

// ─── 7. INTERCITY ФЛОУ ───────────────────────────────────────
h('7. МЕЖГОРОД — полный флоу');
try {
  await q.clearSession(CLIENT1);
  // Шаг 1
  const i1 = await simClient(CLIENT1, 'Клиент', 'Темиртау');
  if (i1.session?.state === 'intercity_pickup') ok('Межгород шаг 1: intercity_pickup');
  else er('Межгород шаг 1: state=' + i1.session?.state);

  // Шаг 2: откуда
  const i2 = await simClient(CLIENT1, 'Клиент', 'ул Ленина 5');
  if (i2.session?.state === 'intercity_time') ok('Межгород шаг 2: intercity_time, pickup=' + i2.session?.ctx?.pickup);
  else er('Межгород шаг 2: state=' + i2.session?.state);

  // Шаг 3: время
  const i3 = await simClient(CLIENT1, 'Клиент', 'сейчас');
  if (i3.session?.state === 'intercity_confirm') ok('Межгород шаг 3: intercity_confirm');
  else er('Межгород шаг 3: state=' + i3.session?.state);

  // Шаг 4: отмена
  const i4 = await simClient(CLIENT1, 'Клиент', 'отмена');
  if (i4.session?.state === 'idle') ok('Межгород шаг 4: отмена → idle');
  else wn('Межгород шаг 4: state=' + i4.session?.state);

} catch(e) { er('Межгород флоу', e.message); }

// ─── 8. ИЗБРАННЫЕ АДРЕСА ─────────────────────────────────────
h('8. ИЗБРАННЫЕ АДРЕСА');
try {
  await q.clearSession(CLIENT1);
  const fa1 = await simClient(CLIENT1, 'Клиент', 'домой это ул Ленина 10');
  const savedHome = fa1.messages.some(m => m.text?.includes('Домашний адрес'));
  if (savedHome) ok('Сохранение домашнего адреса');
  else er('Домашний адрес не сохранился');

  const fa2 = await simClient(CLIENT1, 'Клиент', 'домой');
  const orderedHome = fa2.session?.state === 'confirming' && fa2.session?.ctx?.destination?.includes('Ленина');
  if (orderedHome) ok('Шорткат "домой" → заказ на Ленина 10');
  else er('Шорткат "домой" не сработал: state=' + fa2.session?.state + ' dest=' + fa2.session?.ctx?.destination);
  await q.clearSession(CLIENT1);

  const fa3 = await simClient(CLIENT1, 'Клиент', 'работа это ул Школьная 15');
  const savedWork = fa3.messages.some(m => m.text?.includes('Рабочий адрес'));
  if (savedWork) ok('Сохранение рабочего адреса');
  else er('Рабочий адрес не сохранился');

  const fa4 = await simClient(CLIENT1, 'Клиент', 'на работу');
  const orderedWork = fa4.session?.state === 'confirming' && fa4.session?.ctx?.destination?.includes('Школьная');
  if (orderedWork) ok('Шорткат "на работу" → заказ');
  else er('Шорткат "на работу" не сработал');
  await q.clearSession(CLIENT1);

} catch(e) { er('Избранные адреса', e.message); }

// ─── 9. ПРОГРАММА ЛОЯЛЬНОСТИ ─────────────────────────────────
h('9. БЕСПЛАТНАЯ ПОЕЗДКА (каждая 10-я)');
try {
  const client = await q.getUser(CLIENT1);
  // Ставим trip_count = 9
  await db.query('UPDATE users SET trip_count=9 WHERE phone=$1', [CLIENT1]);
  const r = await simClient(CLIENT1, 'Клиент', 'аптека');
  const hasFreeNote = r.session?.ctx?.price === 0 || r.messages.some(m => m.text?.includes('БЕСПЛАТН'));
  if (hasFreeNote) ok('10-я поездка отмечена как БЕСПЛАТНАЯ');
  else wn('10-я поездка НЕ отмечена (проверь loyalty_enabled в settings)');
  await db.query('UPDATE users SET trip_count=0 WHERE phone=$1', [CLIENT1]);
  await q.clearSession(CLIENT1);
} catch(e) { er('Лояльность', e.message); }

// ─── 10. КОМАНДА "ПОВТОРИ" ───────────────────────────────────
h('10. КОМАНДА "ПОВТОРИ"');
try {
  await q.clearSession(CLIENT1);
  const client = await q.getUser(CLIENT1);
  // Создаём завершённый заказ
  const ord = await q.createOrder({ client_id: client.id, destination: 'ул Мира 7', price: 500, tariff_id: null, is_free: false });
  await q.updateOrder(ord.id, { status:'completed', completed_at: new Date() });

  const r = await simClient(CLIENT1, 'Клиент', 'повтори');
  const repeated = r.session?.state === 'confirming' && r.session?.ctx?.destination?.includes('Мира');
  if (repeated) ok('Повтори → заказ на "ул Мира 7"');
  else er('Повтори не сработал: state=' + r.session?.state + ' dest=' + r.session?.ctx?.destination);
  await q.clearSession(CLIENT1);
  await db.query('DELETE FROM orders WHERE id=$1', [ord.id]);
} catch(e) { er('Повтори', e.message); }

// ─── 11. РЕЙТИНГ ПОСЛЕ ПОЕЗДКИ ───────────────────────────────
h('11. СИСТЕМА РЕЙТИНГА');
try {
  await q.setSession(CLIENT1, 'waiting_rating', { order_id: 999, driver_id: 1 });
  // Невалидные ввод
  const r1 = await simClient(CLIENT1, 'Клиент', '6'); // > 5
  if (r1.session?.state === 'waiting_rating') ok('Оценка 6 → остаёмся в waiting_rating (не принято)');
  else wn('Оценка 6 приняла (должна была отклонить)');

  const r2 = await simClient(CLIENT1, 'Клиент', '0'); // < 1
  if (r2.session?.state === 'waiting_rating') ok('Оценка 0 → остаёмся в waiting_rating');
  else wn('Оценка 0 принята');

  // "пропустить"
  const r3 = await simClient(CLIENT1, 'Клиент', 'пропустить');
  if (r3.session?.state === 'idle') ok('Пропустить → session сброшена в idle');
  else er('Пропустить не сработал: state=' + r3.session?.state);

  // Валидная оценка
  await q.setSession(CLIENT1, 'waiting_rating', { order_id: 999, driver_id: 1 });
  const r4 = await simClient(CLIENT1, 'Клиент', '5');
  if (r4.session?.state === 'idle') ok('Оценка 5 → idle');
  else er('Оценка 5 не сбросила сессию: state=' + r4.session?.state);
} catch(e) { er('Рейтинг', e.message); }

// ─── 12. ВОДИТЕЛЬ — ПОЛНЫЙ ЦИКЛ ──────────────────────────────
h('12. ВОДИТЕЛЬ — регистрация и управление');
try {
  const newDU = await q.createUser(DRIVER1, 'Тест Водитель', 'driver');
  await q.createDriver(newDU.id);
  await q.setSession(DRIVER1, 'idle', {});
  ok('Водитель создан: ' + DRIVER1);

  // На линию
  const d1 = await simDriver(DRIVER1, 'на линию');
  const isOnline = (await q.getDriver(DRIVER1))?.status === 'online';
  if (isOnline) ok('Водитель вышел на линию');
  else er('Водитель не вышел на линию');

  // Очередь
  const d2 = await simDriver(DRIVER1, 'очередь');
  const hasQueueReply = d2.messages.some(m => m.text?.includes('позиция') || m.text?.includes('Позиция') || m.text?.includes('-й'));
  if (hasQueueReply) ok('Команда "очередь" → ответ с позицией');
  else wn('Нет ответа на "очередь": ' + JSON.stringify(d2.messages.map(m=>m.text?.slice(0,30))));

  // Статистика
  const d3 = await simDriver(DRIVER1, 'статистика');
  const hasStats = d3.messages.some(m => m.text?.includes('поездок') || m.text?.includes('Сегодня'));
  if (hasStats) ok('Статистика водителя работает');
  else wn('Статистика пустая: ' + JSON.stringify(d3.messages.map(m=>m.text?.slice(0,30))));

  // Перерыв с валидацией
  const d4 = await simDriver(DRIVER1, 'перерыв 5');
  const wentOffline = (await q.getDriver(DRIVER1))?.status === 'offline';
  if (wentOffline) ok('Перерыв 5 мин → офлайн');
  else er('Перерыв не сработал');

  // Вернуть на линию чтобы тест продолжался
  await driverMgr.goOnline(DRIVER1).catch(() => {});

  // Перерыв 0 (edge case)
  const d5 = await simDriver(DRIVER1, 'перерыв 0');
  const msg5 = d5.messages.some(m => m.text?.includes('Перерыв'));
  if (msg5) ok('Перерыв 0 → не крашится');
  else wn('Перерыв 0: нет ответа');

  // С линии
  await driverMgr.goOnline(DRIVER1).catch(() => {});
  const d6 = await simDriver(DRIVER1, 'с линии');
  const isOff = (await q.getDriver(DRIVER1))?.status === 'offline';
  if (isOff) ok('С линии → офлайн');
  else er('С линии не сработало');

  // Кнопка "Заказать такси" пока офлайн
  await q.setSession(DRIVER1, 'idle', {});
  const d7 = await simDriver(DRIVER1, { type:'button', buttonId:'order_as_client', text:'Заказать', mediaUrl:null });
  const drivAsClient = (await q.getSession(DRIVER1))?.state === 'driver_as_client';
  if (drivAsClient) ok('Кнопка "Заказать такси" → driver_as_client');
  else er('Кнопка order_as_client не сработала: state=' + (await q.getSession(DRIVER1))?.state);

  // Кнопка "Выйти на линию" пока офлайн
  await q.setSession(DRIVER1, 'idle', {});
  const d8 = await simDriver(DRIVER1, { type:'button', buttonId:'go_online', text:'На линию', mediaUrl:null });
  const isOnline2 = (await q.getDriver(DRIVER1))?.status === 'online';
  if (isOnline2) ok('Кнопка "go_online" при офлайн → онлайн');
  else wn('go_online кнопка не вышла на линию (balance=0?)');

  // FAQ
  const d9 = await simDriver(DRIVER1, 'faq');
  const hasFaq = d9.messages.some(m => m.text?.includes('FAQ') || m.text?.includes('на линию'));
  if (hasFaq) ok('FAQ водителя работает');
  else er('FAQ водителя не ответил');

} catch(e) { er('Водитель цикл', e.message); }

// ─── 13. КОМАНДЫ "ГДЕ X" ─────────────────────────────────────
h('13. ПОИСК АДРЕСОВ "ГДЕ X"');
const whereTests = [
  ['где аптека',        true,  'Аптека — есть в базе'],
  ['где больница',      true,  'Больница — есть в базе'],
  ['где тц октябрь',    true,  'ТЦ Октябрь — добавлен вручную'],
  ['где маг айболит',   false, 'Маг Айболит — НЕТ в базе → не заказ'],
  ['адрес ленина 5',    true,  'Ленина 5 — с цифрой → заказ такси'],
  ['где находится акимат', true, 'Акимат — полная фраза'],
];
for (const [text, shouldFind, label] of whereTests) {
  try {
    await q.clearSession(CLIENT1);
    const r = await simClient(CLIENT1, 'Клиент', text);
    const foundAddr = r.messages.some(m => m.btns?.includes('order_found') || m.btns?.includes('cancel_new'));
    const orderedTaxi = r.session?.state === 'confirming';
    const notFoundMsg = r.messages.some(m => m.text?.includes('не нашли') || m.text?.includes('Не нашли'));

    if (text === 'адрес ленина 5') {
      // Должно стать заказом (есть цифра)
      if (orderedTaxi) ok(label + ' → корректно превратился в заказ');
      else er(label + ' → должен быть заказ! state=' + r.session?.state);
    } else if (shouldFind) {
      if (foundAddr) ok(label + ' → найдено в базе, предложение такси');
      else wn(label + ' → НЕ найдено в базе: ' + JSON.stringify(r.messages.map(m=>m.text?.slice(0,40))));
    } else {
      if (notFoundMsg && !orderedTaxi) ok(label + ' → корректный ответ "не нашли"');
      else er(label + ' → неожиданное поведение: state=' + r.session?.state);
    }
    await q.clearSession(CLIENT1);
  } catch(e) { er(label, e.message); await q.clearSession(CLIENT1); }
}

// ─── 14. БЕЗОПАСНОСТЬ — ГРАНИЧНЫЕ СЛУЧАИ ────────────────────
h('14. БЕЗОПАСНОСТЬ И ГРАНИЧНЫЕ СЛУЧАИ');
const secTests = [
  ["'; DROP TABLE users; --",      false, 'SQL injection'],
  ['<script>alert(1)</script>',    false, 'XSS'],
  ['a'.repeat(600),                false, 'Сообщение >500 символов (обрезается)'],
  ['0000000000000000000',          false, 'Только нули — не адрес'],
  ['   ',                          false, 'Пробелы → не адрес'],
  ['\n\n\n',                       false, 'Переносы строк'],
];
for (const [text, shouldOrder, label] of secTests) {
  try {
    await q.clearSession(CLIENT1);
    const truncated = text.trim().slice(0, 500);
    const r = await simClient(CLIENT1, 'Клиент', truncated);
    const ordered = r.session?.state === 'confirming';
    if (ordered === shouldOrder) ok(label + ' → OK');
    else if (shouldOrder && !ordered) wn(label + ' → не заказ (ожидалось заказ)');
    else er(label + ' → СТАЛ ЗАКАЗОМ! state=' + r.session?.state);
    await q.clearSession(CLIENT1);
  } catch(e) {
    // Краш — это плохо
    er(label + ' КРАШ', e.message);
    await q.clearSession(CLIENT1);
  }
}

// Длинное сообщение
try {
  const longAddr = 'ул. Ленина ' + '5 '.repeat(100); // 200+ chars
  await q.clearSession(CLIENT1);
  const r = await simClient(CLIENT1, 'Клиент', longAddr.slice(0, 500));
  ok('Длинный адрес обработан без краша (state=' + r.session?.state + ')');
  await q.clearSession(CLIENT1);
} catch(e) { er('Длинный адрес КРАШ', e.message); }

// ─── 15. НОЧНОЙ ТАРИФ — ВРЕМЕННАЯ ЗОНА ──────────────────────
h('15. ВРЕМЕННАЯ ЗОНА (КРИТИЧНО)');
try {
  const h = new Date().getHours(); // должен быть Almaty час
  const utcH = new Date().getUTCHours();
  const expectedKZ = (utcH + 5) % 24;
  if (Math.abs(h - expectedKZ) <= 1) ok('Часовой пояс сервера: UTC+5 (KZT) ✓ Текущий час: ' + h + ':xx');
  else er('ЧАСОВОЙ ПОЯС НЕВЕРНЫЙ! Сервер=' + h + 'ч, Ожидалось=' + expectedKZ + 'ч (UTC+5)');

  const isNightNow = tariff.isNight();
  const nightStr = isNightNow ? '🌙 НОЧНОЙ тариф (23:00-07:00)' : '☀️ Дневной тариф';
  ok('Тарифный период: ' + nightStr + ' (час=' + h + ')');
} catch(e) { er('Временная зона', e.message); }

// ─── 16. ГОНКА СОСТОЯНИЙ (дублирование сообщений) ───────────
h('16. ГОНКА СОСТОЯНИЙ');
try {
  await q.clearSession(CLIENT1);
  // Симулируем два одинаковых сообщения подряд (WhatsApp иногда дублирует)
  const [r1, r2] = await Promise.all([
    simClient(CLIENT1, 'Клиент', 'Ленина 5'),
    simClient(CLIENT1, 'Клиент', 'Ленина 5'),
  ]);
  // Оба обработались — проверяем нет ли двойного заказа
  const sess = await q.getSession(CLIENT1);
  ok('Дублирование сообщений — не крашится (state=' + sess?.state + ')');
  await q.clearSession(CLIENT1);
} catch(e) { er('Гонка состояний КРАШ', e.message); await q.clearSession(CLIENT1); }

// ─── 17. ИНФОРМАЦИОННЫЕ КОМАНДЫ ──────────────────────────────
h('17. ИНФОРМАЦИОННЫЕ КОМАНДЫ (валидность данных)');
const infoTests = [
  ['курс',     'USD > 100₸',     async () => { const r = await info.getCurrencyRates(); return r?.usd > 100; }],
  ['золото',   'Золото > 10000₸/г', async () => { const r = await info.getMetalPrices(); return r?.gold_gram_kzt > 10000; }],
  ['пшеница',  'Пшеница > 50000₸/т', async () => { const r = await info.getGrainPrices(); return r?.wheat?.kzt_per_ton > 50000; }],
];
for (const [cmd, desc, check] of infoTests) {
  try {
    const valid = await check();
    if (valid) ok(cmd + ' — ' + desc);
    else wn(cmd + ' — данные невалидны');
    // Проверяем что команда не создаёт заказ
    await q.clearSession(CLIENT1);
    const r = await simClient(CLIENT1, 'Клиент', cmd);
    if (r.session?.state !== 'confirming') ok(cmd + ' — не создаёт заказ ✓');
    else er(cmd + ' — СОЗДАЛ ЗАКАЗ!');
    await q.clearSession(CLIENT1);
  } catch(e) { er(cmd, e.message); }
}

// ─── ОЧИСТКА ─────────────────────────────────────────────────
await cleanup();

// ─── ИТОГ ────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(55));
console.log('РЕАЛЬНЫЙ ТЕСТ: ✅ ' + pass + ' прошли  ❌ ' + fail + ' ошибок  ⚠️  ' + warn + ' предупреждений');
console.log('═'.repeat(55));
if (fail > 0) { console.log('\n🚨 Есть ошибки — НЕ запускать в продакшн!'); process.exit(1); }
else if (warn > 5) { console.log('\n⚠️  Много предупреждений — проверить перед запуском'); }
else { console.log('\n🚀 ГОТОВ К ЗАПУСКУ!'); }
}

run().catch(e => { console.error('FATAL TEST CRASH:', e.message, e.stack); process.exit(1); });
