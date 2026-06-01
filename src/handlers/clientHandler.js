const wa = require('../whatsapp/greenApi');
const q = require('../db/queries');
const db = require('../db/index');
const tariff = require('../modules/tariffEngine');
const orderEngine = require('../modules/orderEngine');
const chatRelay = require('../modules/chatRelay');
const config = require('../config');
const { isAddress, resolveAddress, findInAddresses } = require('../modules/addressDetector');
const { recognizeVoice } = require('../modules/voiceRecognizer');
const { getGroqReply, parseScheduleTime } = require('../modules/smartReply');
const { dailyGreeting } = require('../modules/greetingService');
const favAddr = require('../modules/favoriteAddresses');
const { getWeather, formatWeatherFull } = require('../modules/weatherService');

const INTERCITY = [
  // Сёла Осакаровского района
  'есиль','литвинское','литвинка','5 поселок','пятый поселок',
  'карагайлы','октябрьское','акбулак','пролетарское','озерное','приишимское',
  'колхозное','садовое','николаевка','сункар','скобелевка','шункыркол','богучар',
  'уызбай','сарыозек','вольское','сарыозен','крестовка','ошаганды','батпакты',
  'батпак','мирное','трудовое','тельманское','акпан','новый кронштадт','шидерты',
  'иртышское','звездное','дальнее','родниковское','шокай','чапаево',
  'жарлы','коктал','аккудук','токаревка','ашлы','бектас','акжар','степной',
  'михайловка','алексеевка','петровка','ивановка','новосёловка','красногорка',
  '1 поселок','2 поселок','3 поселок','4 поселок','первый поселок','второй поселок',
  // Города Карагандинской области и Казахстана
  'темиртау','балхаш','жезказган','жезқазған','сатпаев','приозёрск','каражал',
  'астана','нурсултан','нур-султан','алматы','алма-ата','шымкент',
  'кокшетау','павлодар','петропавловск','семей','усть-каменогорск','актобе',
  'костанай','атырау','актау','тараз','кызылорда','уральск',
  'абай','шахтинск','сарань','топар','карагандинск','агадырь',
];

const isIntercity = (text) => INTERCITY.some(w => (text||'').toLowerCase().includes(w));
const CANCEL  = ['отмена','cancel','нет','жок','стоп','назад','выход','отменить','не надо'];
const CONFIRM = ['да','ok','ок','yes','подтверждаю','поехали','ия','иа'];
const isCancel  = (lo) => CANCEL.some(w => lo === w || lo.includes(w));
const isConfirm = (lo) => CONFIRM.some(w => lo === w);

const getSmartReply = (text) => {
  const lo = (text||'').toLowerCase().trim();

  if (['привет','здравствуйте','добрый','хай','hi','hello','салем','ассалам','сәлем','қайырлы',
       'доброе утро','добрый день','добрый вечер','добрый ночь','здрасте'].some(w => lo === w || lo.startsWith(w+' ') || lo.startsWith(w+'!')))
    return '👋 Добро пожаловать в *еОсакаровка Сервис*!\n\n🚖 Напишите куда нужно ехать — найдём водителя!';

  if (['машину','такси','нужна машина','заказать такси','такси керек','машина керек','нужно такси',
       'вызовите','вызов','нужен водитель','закажите','вызвать такси','заказ такси'].some(w => lo.includes(w)))
    return '🚖 Напишите *куда* нужно ехать — сразу найдём водителя!';

  if (['сколько стоит','цена','тариф','почем','баға','қанша','стоимость','прайс','расценки','сколько',
       'сколько берете','ценник'].some(w => lo.includes(w)))
    return '💰 Цена от *500 тг* по посёлку.\nНапишите адрес — скажем точную стоимость! 📍';

  if (['долго ждать','сколько ждать','когда приедет','время ожидания','как долго'].some(w => lo.includes(w)))
    return '⏱ Водитель приедет через *3–7 минут* после принятия заказа.';

  if (['ночью','ночной тариф','түнде','ночной','после 23','после полуночи','ночь'].some(w => lo.includes(w)))
    return '🌙 С *23:00 до 07:00* действует ночной тариф.\n☀️ Дневной тариф с 07:00 до 23:00.';

  if (['карта','безнал','каспи','kaspi','перевод','переводом','оплата','оплатить'].some(w => lo.includes(w)))
    return '💳 Основная оплата — *наличными* водителю.\nБезнал уточняйте у водителя при посадке.';

  if (['спасибо','рахмет','благодарю','рақмет','алғыс','благодарность'].some(w => lo.includes(w)))
    return '🙏 Пожалуйста! Всегда рады помочь.\n\nЖдём вас снова в *еОсакаровка Сервис*! 😊';

  if (['пока','до свидания','сау болын','дасвидания','до встречи'].some(w => lo.includes(w)))
    return '👋 До свидания! Удачи и до новых встреч!\n\n🚖 *еОсакаровка Сервис* всегда рядом!';

  if (['помощь','как заказать','help','инструкция','как пользоваться','команды','что умеешь'].some(w => lo.includes(w)))
    return '📋 *Как заказать такси:*\n\n1️⃣ Напишите куда нужно ехать\n2️⃣ Подтвердите заказ кнопкой\n3️⃣ Ждите — водитель приедет!\n\n🎁 Каждая *10-я поездка бесплатная!*\n🏠 Сохраните домашний адрес: напишите *"домой это [адрес]"*';

  if (['работаете','круглосуточно','открыты','режим работы','график'].some(w => lo.includes(w)))
    return '🕐 Да, работаем *круглосуточно* — 24/7!\n\n🚖 Напишите куда нужно ехать.';

  if (['с вещами','с багажом','багаж','груз','перевезти вещи','переезд'].some(w => lo.includes(w)))
    return '🧳 Конечно! Напишите куда ехать — водитель поможет с вещами.';

  if (['детское кресло','с ребенком','с детьми','ребёнок','дети'].some(w => lo.includes(w)))
    return '👶 Напишите куда ехать и уточните у водителя наличие детского кресла при посадке.';

  if (['не знаю адрес','не знаю куда','ориентир','где находится','как найти'].some(w => lo.includes(w)))
    return '📍 Напишите ближайший ориентир — магазин, школу, остановку или улицу. Водитель разберётся!';

  if (['что за сервис','кто вы','о компании','о вас','что это','расскажите о','что умеет'].some(w => lo.includes(w)))
    return '🚖 *еОсакаровка Сервис* — такси посёлка Осакаровка.\n\n✅ Работаем 24/7\n💰 От 500 тг по посёлку\n🎁 Каждая 10-я поездка бесплатно\n\nПишите адрес — найдём водителя!';

  if (['скидка','акция','бонус','промокод','бесплатно','скидки'].some(w => lo.includes(w)))
    return '🎁 *Программа лояльности:*\n\nКаждая *10-я поездка* — бесплатная!\nПригласите друга — получите бонус. 😊';

  if (['безопасно','безопасность','надёжно','проверены'].some(w => lo.includes(w)))
    return '✅ Все водители зарегистрированы в системе.\n🚖 Безопасная поездка гарантирована!';

  if (['номер водителя','телефон водителя','контакт водителя'].some(w => lo.includes(w)))
    return '📞 Данные водителя придут автоматически после принятия заказа.\n\nНапишите куда ехать! 🚖';

  if (['мой адрес','домашний адрес','сохранить адрес'].some(w => lo.includes(w)))
    return '🏠 Чтобы сохранить домашний адрес напишите:\n*"домой это [ваш адрес]"*\n\n🏢 Рабочий адрес:\n*"работа это [ваш адрес]"*\n\nПотом просто пишите *"домой"* или *"на работу"*!';

  return null;
};

const handle = async (phone, name, msg, session) => {
  const { text, type, buttonId, mediaUrl } = msg;
  const state = session?.state || 'idle';
  const lo = (text||'').toLowerCase().trim();
  try {
    if (type === 'button' && buttonId) return await handleButton(phone, buttonId, session);

    if (state === 'chat_mode') {
      if (lo === 'стоп') { const order = await q.getActiveOrderByClient(phone); await q.setSession(phone, order ? 'in_trip' : 'idle', {}); await wa.sendText(phone, '💬 Чат завершён.'); return; }
      return chatRelay.fromClient(phone, text);
    }

    // ─── ОЦЕНКА ПОЕЗДКИ ───────────────────────────────────────
    if (state === 'waiting_rating') {
      const score = parseInt(lo);
      if (score >= 1 && score <= 5) {
        const ctx = session?.ctx || {};
        if (ctx.order_id && ctx.driver_id) {
          const client = await q.getUser(phone);
          await q.saveRating(ctx.order_id, client?.id, ctx.driver_id, score).catch(() => {});
          await q.updateDriverRating(ctx.driver_id, score).catch(() => {});
          const driver = await q.getDriverById(ctx.driver_id).catch(() => null);
          const stars = '⭐'.repeat(score);
          await wa.sendText(phone, stars + ' *Спасибо за оценку!*\nВаш отзыв помогает нам стать лучше. 🙏');
          if (driver?.phone) {
            const praise = score >= 4 ? '💪 Продолжайте в том же духе!' : score <= 2 ? 'Постарайтесь улучшить сервис.' : '';
            await wa.sendText(driver.phone, '📬 *Новая оценка от клиента:*\n\n' + stars + ' *' + score + ' из 5*\n\n' + praise).catch(() => {});
          }
        }
        await q.clearSession(phone);
        return;
      }
      if (['пропустить','не хочу','позже','skip','отмена','стоп'].some(w => lo.includes(w))) {
        await q.clearSession(phone);
        await wa.sendText(phone, '👌 Хорошо! Ждём вас снова. 🚖');
        return;
      }
      await wa.sendText(phone, '⭐ Напишите число от *1 до 5:*\n\n1️⃣ — плохо\n2️⃣ — так себе\n3️⃣ — нормально\n4️⃣ — хорошо\n5️⃣ — отлично\n\nИли *"пропустить"*');
      return;
    }

    // ─── ПРИЧИНА ОТМЕНЫ КЛИЕНТОМ ──────────────────────────────
    if (state === 'cancel_client_reason') {
      const ctx = session?.ctx || {};
      const reasons = { wait: 'Долго ждал водителя', plans: 'Планы изменились', address: 'Ошибся адресом' };
      const reasonKey = type === 'button' ? buttonId?.replace('cancel_reason_', '') : null;
      const reason = reasons[reasonKey] || 'Клиент отменил';
      if (ctx.order_id) await orderEngine.cancel(ctx.order_id, reason);
      else { await q.clearSession(phone); await wa.sendText(phone, '❌ Заказ отменён.'); }
      return;
    }

    if (state === 'waiting_driver') {
      if (['где','где водитель','едет','когда','статус'].some(k => lo.includes(k))) {
        const order = await q.getActiveOrderByClient(phone);
        if (order) { const mins = Math.floor((Date.now()-new Date(order.created_at))/60000); await wa.sendText(phone, '🔍 Ищем водителя уже *' + mins + ' мин...*\nКак только найдём — сразу сообщим! 🚖'); }
        return;
      }
      if (isCancel(lo)) { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id, 'Отменен клиентом'); else { await q.clearSession(phone); await wa.sendText(phone, '❌ Нет активного заказа.'); } return; }
      await wa.sendButtons(phone, '🔍 Ищем водителя...\n\nОжидайте, это займёт буквально пару минут!', [{ id:'cancel_order', text:'❌ Отменить заказ' }]);
      return;
    }

    if (state === 'in_trip') {
      await wa.sendButtons(phone, '🚗 Вы в поездке!\n\nЕсли нужно — напишите водителю:', [{ id:'chat_driver', text:'💬 Написать водителю' }]);
      return;
    }

    if (state === 'intercity_pickup') {
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return; }
      if (!text || text.length < 2) { await wa.sendText(phone, '📍 Введите адрес откуда вас забрать:'); return; }
      const ctx = session?.ctx || {};
      await q.setSession(phone, 'intercity_time', { ...ctx, pickup: text.trim() });
      await wa.sendText(phone, '📍 Откуда: *' + text.trim() + '*\n\n🕐 На какое время нужна машина?\n\nНапишите:\n• *сейчас*\n• *сегодня в 15:00*\n• *завтра в 8:00*');
      return;
    }

    if (state === 'intercity_time') {
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return; }
      if (!text || text.length < 2) { await wa.sendText(phone, '🕐 Напишите время: *сейчас* или *завтра в 8:00*'); return; }
      const ctx = session?.ctx || {};
      const parsedTime = await parseScheduleTime(text).catch(() => text);
      const isNow = parsedTime === 'сейчас';
      const timeStr = isNow ? 'Сейчас' : parsedTime;
      const pi = await tariff.getPrice(ctx.destination || '');
      await q.setSession(phone, 'intercity_confirm', { ...ctx, timeStr, isNow, price: pi.price });
      await wa.sendButtons(phone,
        '🚗 *Межгородской заказ*\n\n📍 Откуда: *' + ctx.pickup + '*\n🏁 Куда: *' + ctx.destination + '*\n🕐 Время: *' + timeStr + '*\n💰 Цена: *' + pi.price + ' тг*\n\nВсё верно?',
        [{ id:'confirm_intercity', text:'✅ Подтвердить' }, { id:'cancel_new', text:'❌ Отмена' }]
      );
      return;
    }

    if (state === 'intercity_confirm') {
      if (type === 'voice' && mediaUrl) {
        const recognized = await recognizeVoice(mediaUrl).catch(() => '');
        const rlo = (recognized||'').toLowerCase().trim();
        if (['да','иа','поехали','подтверждаю','везите'].some(w => rlo.includes(w))) {
          const f = await q.getSession(phone);
          if (f?.ctx) await orderEngine.create(phone, f.ctx.destination, { price: f.ctx.price, pickup_address: f.ctx.pickup, is_intercity: true });
          return;
        }
      }
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
      if (isConfirm(lo)) {
        const ctx = session?.ctx || {};
        await orderEngine.create(phone, ctx.destination, { price: ctx.price, pickup_address: ctx.pickup, is_intercity: true });
        return;
      }
      return;
    }

    if (state === 'confirming') {
      if (type === 'voice' && mediaUrl) {
        const recognized = await recognizeVoice(mediaUrl).catch(() => '');
        const rlo = (recognized||'').toLowerCase().trim();
        if (['да','иа','поехали','везите','едем'].some(w => rlo.includes(w))) {
          const f = await q.getSession(phone);
          if (f?.state === 'confirming') { const { destination, price, tariff_id } = f.ctx; await orderEngine.create(phone, destination, { price, tariff: tariff_id ? { id: tariff_id } : null }); }
          return;
        }
        if (isCancel(rlo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
      }
      if (isConfirm(lo)) {
        const f = await q.getSession(phone);
        if (!f || f.state !== 'confirming') return;
        const { destination, price, tariff_id } = f.ctx;
        await orderEngine.create(phone, destination, { price, tariff: tariff_id ? { id: tariff_id } : null });
        return;
      }
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return; }
      const f = await q.getSession(phone);
      if (f?.ctx?.destination) {
        await wa.sendButtons(phone,
          '🚖 *Ваш заказ:*\n\n📍 Куда: *' + f.ctx.destination + '*\n💰 Цена: *' + f.ctx.price + ' тг*\n\nВсё верно?',
          [{ id:'confirm_order', text:'✅ Да, поехали!' }, { id:'cancel_new', text:'❌ Отмена' }]);
      }
      return;
    }

    if (type === 'voice') {
      if (mediaUrl) {
        await wa.sendText(phone, '🎤 Распознаю голосовое сообщение...');
        const recognized = await recognizeVoice(mediaUrl);
        if (recognized && recognized.length >= 2) {
          const smartR = getSmartReply(recognized);
          if (smartR) { await wa.sendText(phone, smartR); return; }
          if (isIntercity(recognized)) {
            const active0 = await q.getActiveOrderByClient(phone);
            if (!active0) { await q.setSession(phone, 'intercity_pickup', { destination: recognized }); await wa.sendText(phone, '🚗 Межгородская поездка!\n🏁 Куда: *' + recognized + '*\n\n📍 Откуда вас забрать?'); }
            return;
          }
          const addr = await isAddress(recognized);
          if (addr) { const user = await q.getUser(phone); return handleNewOrder(phone, name, recognized, user); }
          const groqR = await getGroqReply(recognized).catch(() => null);
          await wa.sendText(phone, groqR || '🚖 Напишите куда нужно ехать.');
          return;
        } else { await wa.sendText(phone, '🎤 Не удалось распознать. Напишите адрес текстом.'); return; }
      }
      await wa.sendText(phone, '🚖 Напишите куда нужно ехать.');
      return;
    }

    if (!text || text.length < 2) { await wa.sendText(phone, '🚖 Напишите куда нужно ехать:'); return; }

    // ─── ПОГОДА ───────────────────────────────────────────────
    if (['погода','какая погода','прогноз','weather','ауа','ауа райы'].some(w => lo.includes(w))) {
      const w = await getWeather().catch(() => null);
      const wStr = formatWeatherFull(w);
      await wa.sendText(phone, wStr || '🌡 Данные о погоде временно недоступны.\n\nНапишите куда ехать — найдём водителя! 🚖');
      return;
    }

    // ─── FAQ КЛИЕНТА ──────────────────────────────────────────
    if (['faq','фак','инструкция','помощь','как','команды','что умеешь','как пользоваться'].some(w => lo === w || lo.startsWith(w))) {
      await wa.sendText(phone,
        '📋 *FAQ — еОсакаровка Сервис*\n\n' +
        '🚖 *Как заказать такси?*\nПросто напишите куда нужно ехать!\n\n' +
        '💰 *Цены:*\n• По посёлку от *500 тг*\n• До ЖД станции ~*1000 тг*\n• До Элеватора ~*700 тг*\n• 🌙 Ночной тариф с 23:00 до 07:00\n\n' +
        '🎁 *Бонусы:*\n• Каждая *10-я поездка — бесплатно!*\n• Пригласи друга → получи бесплатную поездку\n• Напиши *"мой код"* — узнать реферальный код\n\n' +
        '🏠 *Быстрые адреса:*\n• *"домой это [адрес]"* — сохранить дом\n• *"работа это [адрес]"* — сохранить работу\n• Потом просто *"домой"* или *"на работу"*\n\n' +
        '🔍 *Команды:*\n• *"повтори"* — повторить маршрут\n• *"история"* — мои поездки\n• *"мой код"* — реферальный код\n• *"где [место]"* — адрес любого объекта\n• *"погода"* — текущая погода\n• *"услуги"* — все услуги сервиса\n\n' +
        '📞 *Работаем 24/7 — всегда на связи!*'
      );
      return;
    }

    // ─── УСЛУГИ СЕРВИСА ───────────────────────────────────────
    if (['услуги','сервисы','что вы делаете','что предлагаете','виды услуг','что можете'].some(w => lo.includes(w))) {
      await wa.sendText(phone,
        '🏢 *еОсакаровка Сервис — наши услуги:*\n\n' +
        '🚖 *Такси* — по посёлку и межгород\nОт 500 тг, работаем 24/7\n\n' +
        '📦 *Доставка* — товары, посылки, продукты\nНапишите: *"доставка [что и куда]"*\n\n' +
        '🔧 *Мужчина на час* — мелкий ремонт, монтаж, помощь по хозяйству\nНапишите: *"мастер [что нужно сделать]"*\n\n' +
        '🚛 *Аренда техники:*\n• КАМАЗ / грузовик — вывоз мусора, переезд\n• Погрузчик\n• Ассенизатор (откачка)\n• Эвакуатор\nНапишите: *"техника [что нужно]"*\n\n' +
        '❓ Напишите нужную услугу — свяжем с исполнителем!'
      );
      return;
    }

    // ─── ЗАЯВКА НА ДОСТАВКУ ──────────────────────────────────
    if (lo.startsWith('доставка ') || lo.startsWith('доставить ')) {
      const task = text.replace(/^доставка |^доставить /i, '').trim();
      const adminPhone = await q.getSetting('admin_phone').catch(() => null);
      if (adminPhone) await wa.sendText(adminPhone, '📦 *Заявка на доставку*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {});
      await wa.sendText(phone, '📦 *Заявка на доставку принята!*\n\n📝 ' + task + '\n\n⏳ Администратор свяжется с вами в ближайшее время.');
      return;
    }

    // ─── ЗАЯВКА НА МАСТЕРА ───────────────────────────────────
    if (lo.startsWith('мастер ') || lo.startsWith('муж на час') || lo.startsWith('мужчина на час') || lo.startsWith('ремонт ')) {
      const task = text.replace(/^мастер |^муж на час|^мужчина на час|^ремонт /i, '').trim() || text;
      const adminPhone = await q.getSetting('admin_phone').catch(() => null);
      if (adminPhone) await wa.sendText(adminPhone, '🔧 *Заявка: Мастер на час*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {});
      await wa.sendText(phone, '🔧 *Заявка принята!*\n\n📝 ' + task + '\n\n⏳ Свяжемся с вами в ближайшее время.');
      return;
    }

    // ─── ЗАЯВКА НА ТЕХНИКУ ───────────────────────────────────
    if (lo.startsWith('техника ') || ['камаз','погрузчик','ассенизатор','эвакуатор','грузовик'].some(w => lo.includes(w))) {
      const task = text.trim();
      const adminPhone = await q.getSetting('admin_phone').catch(() => null);
      if (adminPhone) await wa.sendText(adminPhone, '🚛 *Заявка: Аренда техники*\n👤 Клиент: ' + phone + '\n📝 ' + task).catch(() => {});
      await wa.sendText(phone, '🚛 *Заявка на технику принята!*\n\n📝 ' + task + '\n\n⏳ Уточним детали и свяжемся с вами.');
      return;
    }

    // ─── НОВОСТИ/ОБНОВЛЕНИЯ ──────────────────────────────────
    if (['новости','обновления','что нового','апдейт','news'].some(w => lo.includes(w))) {
      await wa.sendText(phone,
        '📰 *Новости еОсакаровка Сервис:*\n\n' +
        '✅ Теперь можно оценивать поездки (⭐ 1-5)\n' +
        '🔄 Команда *"повтори"* — повторяет последний маршрут\n' +
        '🎁 Команда *"мой код"* — ваш реферальный код\n' +
        '📦 Доставка — напишите *"доставка [что куда]"*\n' +
        '🔧 Мастер на час — напишите *"мастер [задача]"*\n' +
        '🚛 Аренда техники — напишите *"техника [что]"*\n' +
        '🌤 Погода — напишите *"погода"*\n' +
        '📋 Помощь — напишите *"faq"*\n\n' +
        '🚖 *Работаем 24/7. Всегда рядом!*'
      );
      return;
    }

    // ─── ПОВТОРИТЬ ПОСЛЕДНИЙ ЗАКАЗ ────────────────────────────
    if (['повтори','повторить','снова','тот же','как прошлый раз','повтор','ещё раз','еще раз'].some(w => lo.includes(w))) {
      const lastOrder = await q.getLastCompletedOrder(phone);
      if (!lastOrder) { await wa.sendText(phone, '🚖 Прошлых поездок нет. Напишите куда ехать!'); return; }
      const user = await q.getUser(phone);
      await wa.sendText(phone, '🔄 Повторяю последний маршрут: *' + lastOrder.destination + '*');
      return handleNewOrder(phone, name, lastOrder.destination, user);
    }

    // ─── МОЙ РЕФЕРАЛЬНЫЙ КОД ─────────────────────────────────
    if (['мой код','реферал','пригласить','моя ссылка','бонусный код','реферальный','промокод','код друга'].some(w => lo.includes(w))) {
      const code = await q.getOrCreateReferralCode(phone).catch(() => null);
      if (!code) { await wa.sendText(phone, '❌ Не удалось получить код. Попробуйте позже.'); return; }
      const refStats = await q.getReferralStats(phone).catch(() => null);
      const invited = refStats?.activated || 0;
      const bonus = refStats?.bonus_trips || 0;
      await wa.sendText(phone,
        '🎁 *Ваш реферальный код:*\n\n🔑 *' + code + '*\n\n' +
        'Поделитесь кодом с другом — когда он совершит первую поездку, вы получите *бесплатную поездку!* 🎉\n\n' +
        '📊 Приглашено друзей: *' + invited + '*\n' +
        '🎫 Бонусных поездок в запасе: *' + bonus + '*'
      );
      return;
    }

    const shortcut = await favAddr.resolveShortcut(phone, lo).catch(() => null);
    if (shortcut) { const user = await q.getUser(phone); return handleNewOrder(phone, name, shortcut.address, user); }

    if (lo.startsWith('домой это ') || lo.startsWith('мой дом ')) {
      const addr = text.replace(/^домой это |^мой дом /i, '').trim();
      await favAddr.saveHome(phone, addr);
      await wa.sendText(phone, '🏠 Домашний адрес сохранён: *' + addr + '*\n\nТеперь просто напишите *"домой"* — сразу поедем! 🚖');
      return;
    }
    if (lo.startsWith('работа это ') || lo.startsWith('моя работа ')) {
      const addr = text.replace(/^работа это |^моя работа /i, '').trim();
      await favAddr.saveWork(phone, addr);
      await wa.sendText(phone, '🏢 Рабочий адрес сохранён: *' + addr + '*\n\nТеперь просто напишите *"на работу"* — сразу поедем! 🚖');
      return;
    }

    if (['история','мои поездки','поездки','тарихым','сапарым','поездка'].some(w => lo.includes(w))) {
      const userR = await q.getUser(phone);
      const hist = await db.query(`SELECT destination, price, status, created_at FROM orders WHERE client_id=$1 AND status IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 5`, [userR?.id]).then(r => r.rows).catch(() => []);
      if (!hist.length) { await wa.sendText(phone, '🚖 У вас пока нет поездок.\n\nНапишите куда ехать — начнём!'); return; }
      const lines = hist.map((h,i) => { const date = new Date(h.created_at).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}); return (i+1) + '. ' + (h.status==='completed'?'✅':'❌') + ' ' + date + ' — ' + h.destination + ' — ' + h.price + ' тг'; }).join('\n');
      const nextFree = 10 - ((userR?.trip_count||0) % 10);
      await wa.sendText(phone, '🚖 *Ваши последние поездки:*\n\n' + lines + '\n\n📊 Всего поездок: *' + (userR?.trip_count||0) + '*\n🎁 До бесплатной: *' + nextFree + '*');
      return;
    }

    // ─── ПОИСК АДРЕСА ОБЪЕКТА («где аптека», «адрес больницы») ──
    const whereRe = /^(?:где|адрес|как найти|как доехать|где находится|найди|покажи адрес)\s+(.+)/i;
    const whereMatch = lo.match(whereRe);
    if (whereMatch) {
      const objName = whereMatch[1].trim();
      const found = await findInAddresses(objName).catch(() => ({ found: false }));
      if (found.found) {
        const addrLine = found.address && found.address !== 'п. Осакаровка' ? '\n🏠 Адрес: *' + found.address + '*' : '';
        const catLine  = found.category ? '\n📂 ' + found.category : '';
        const pi = await tariff.getPrice(found.name);
        const dest = found.name + (found.address && found.address !== 'п. Осакаровка' ? ', ' + found.address : '');
        await wa.sendButtons(phone,
          '📍 *' + found.name + '*' + addrLine + catLine + '\n\nЗаказать такси туда?',
          [{ id:'order_found', text:'🚖 Да, везите туда!' }, { id:'cancel_new', text:'❌ Нет, спасибо' }]
        );
        await q.setSession(phone, 'confirming', { destination: dest, price: pi.price, tariff_id: pi.tariff?.id || null });
        return;
      }
      // Объект не найден в базе — сообщаем и НЕ падаем в handleNewOrder
      await wa.sendText(phone,
        '🔍 *"' + objName + '"* не нашли в нашей базе.\n\n' +
        'Попробуйте написать точнее или напишите адрес куда ехать — найдём водителя! 🚖'
      );
      return;
    }

    if (['есть такси','есть машина','такси есть','бар ма такси','такси бар ма','свободные водители'].some(w => lo.includes(w))) {
      const online = await q.getOnlineDriversQueue().catch(() => []);
      const cnt = online.length;
      if (cnt === 0) await wa.sendText(phone, '😔 Сейчас все водители заняты.\n⏱ Обычно ждать 5–10 минут.\n\n📍 Напишите адрес — поставим в очередь!');
      else await wa.sendText(phone, '✅ Да! Сейчас *' + cnt + '* водител' + (cnt===1?'ь':(cnt<5?'я':'ей')) + ' на линии.\n\n🚖 Напишите куда ехать!');
      return;
    }

    if (isIntercity(text)) {
      const active0 = await q.getActiveOrderByClient(phone);
      if (active0) { await wa.sendText(phone, '⚠️ У вас уже есть активный заказ!\n\nДождитесь завершения или отмените.'); return; }
      await q.setSession(phone, 'intercity_pickup', { destination: text });
      await wa.sendText(phone, '🚗 Межгородская поездка!\n🏁 Куда: *' + text + '*\n\n📍 Откуда вас забрать?\n(напишите адрес или ориентир)');
      return;
    }

    const smartReply = getSmartReply(text);
    if (smartReply) { await wa.sendText(phone, smartReply); return; }

    const user = await q.getUser(phone);
    const addr = await isAddress(text);
    if (!addr) {
      // Приветствие и Groq — только если не адрес, чтобы не дропать заказ
      const user2 = await q.getUser(phone);
      const today = new Date().toISOString().split('T')[0];
      const lastSeen = user2?.last_seen_date ? String(user2.last_seen_date).split('T')[0] : null;
      if (lastSeen !== today && (user2?.trip_count||0) >= 0) {
        await q.updateUser(phone, { last_seen_date: new Date() }).catch(() => {});
        const dayGreet = await dailyGreeting(name, text, user2?.trip_count||0).catch(() => null);
        if (dayGreet) { await wa.sendText(phone, dayGreet); return; }
      }
      const groqReply = await getGroqReply(text).catch(() => null);
      await wa.sendText(phone, groqReply || 'Напишите куда нужно ехать:');
      return;
    }
    return handleNewOrder(phone, name, text, user);

  } catch (err) {
    console.error('[clientHandler]', err.message);
    await wa.sendText(phone, 'Произошла ошибка. Попробуйте еще раз.').catch(()=>{});
  }
};

const handleNewOrder = async (phone, name, text, user) => {
  if (!text || text.length < 2) return;
  const active = await q.getActiveOrderByClient(phone);
  if (active) { await wa.sendText(phone, '⚠️ У вас уже есть активный заказ!\n📍 *' + active.destination + '*\n\nДождитесь завершения или отмените его.'); return; }
  if (isIntercity(text)) {
    await q.setSession(phone, 'intercity_pickup', { destination: text });
    await wa.sendText(phone, '🚗 Межгородская поездка!\n🏁 Куда: *' + text + '*\n\n📍 Откуда вас забрать?\n(напишите адрес или ориентир)');
    return;
  }
  const resolved = await resolveAddress(text).catch(() => ({ found: false }));
  // resolved.name используем только если он содержит оригинальный текст (истинное обогащение).
  const enriched = resolved.found &&
    resolved.name.toLowerCase().includes(text.trim().toLowerCase());
  const displayAddress = enriched ? resolved.name : text.trim();
  const pi = await tariff.getPrice(text);
  const nightNote = pi.isNight ? '\n🌙 *Ночной тариф*' : '';
  const freeNote = user && (user.trip_count+1) % config.FREE_TRIP_EVERY === 0 ? '\n\n🎁 *Эта поездка будет БЕСПЛАТНОЙ!*' : '';
  await wa.sendButtons(phone,
    '🚖 *Ваш заказ:*\n\n📍 Куда: *' + displayAddress + '*\n💰 Цена: *' + pi.price + ' тг*' + nightNote + freeNote + '\n\nВсё верно?',
    [{ id:'confirm_order', text:'✅ Да, поехали!' }, { id:'cancel_new', text:'❌ Отмена' }]);
  await q.setSession(phone, 'confirming', { destination: displayAddress, price: pi.price, tariff_id: pi.tariff?.id||null });
};

const handleButton = async (phone, buttonId, session) => {
  if (buttonId === 'confirm_order' || buttonId === 'order_found') { const f = await q.getSession(phone); if (!f||f.state!=='confirming') return; const {destination,price,tariff_id} = f.ctx; await orderEngine.create(phone, destination, {price, tariff: tariff_id?{id:tariff_id}:null}); return; }
  if (buttonId === 'confirm_intercity') { const f = await q.getSession(phone); if (!f||f.state!=='intercity_confirm') return; const ctx = f.ctx; await orderEngine.create(phone, ctx.destination, {price: ctx.price, pickup_address: ctx.pickup, is_intercity: true}); return; }
  if (buttonId === 'cancel_new') { await q.clearSession(phone); await wa.sendText(phone, '❌ Отменено. Напишите куда ехать.'); return; }
  if (buttonId === 'cancel_order') {
    const order = await q.getActiveOrderByClient(phone);
    if (!order) { await q.clearSession(phone); await wa.sendText(phone, '❌ Нет активного заказа.'); return; }
    await q.setSession(phone, 'cancel_client_reason', { order_id: order.id });
    await wa.sendButtons(phone, '❓ *Почему отменяете заказ?*', [
      { id:'cancel_reason_wait',    text:'⏱ Долго жду' },
      { id:'cancel_reason_plans',   text:'🔄 Планы изменились' },
      { id:'cancel_reason_address', text:'📍 Ошибся адресом' },
    ]);
    return;
  }
  if (buttonId.startsWith('cancel_reason_')) {
    const reasons = { wait:'Долго ждал водителя', plans:'Планы изменились', address:'Ошибся адресом' };
    const key = buttonId.replace('cancel_reason_', '');
    const order = await q.getActiveOrderByClient(phone);
    if (order) await orderEngine.cancel(order.id, reasons[key] || 'Клиент отменил');
    else { await q.clearSession(phone); await wa.sendText(phone, '❌ Заказ отменён.'); }
    return;
  }
  if (buttonId === 'chat_driver') { const order = await q.getActiveOrderByClient(phone); if (!order) { await wa.sendText(phone,'❌ Нет активного заказа.'); return; } await q.setSession(phone,'chat_mode',{prev_state:session?.state||'idle',order_id:order.id}); await wa.sendText(phone,'💬 *Чат с водителем активирован.*\nНапишите сообщение — водитель его получит.\n\n✏️ Для выхода из чата напишите: *стоп*'); return; }
  // ─── Кнопки водителя попавшие в clientHandler (offline) ──────
  if (buttonId === 'order_as_client') { await q.setSession(phone,'driver_as_client',{}); await wa.sendText(phone,'🚖 Куда нужно ехать?'); return; }
  if (buttonId === 'go_online')  { const driverMgr = require('../modules/driverManager'); const r = await driverMgr.goOnline(phone); if (r.error === 'no_balance') { await wa.sendText(phone,'🔴 Баланс = 0. Обратитесь к администратору.'); return; } const pos = await q.getDriverQueuePosition(phone); const cnt = (await q.getOnlineDriversQueue()).length; await wa.sendButtons(phone,'🟢 *Вы на линии!*\n📋 Позиция: *'+pos+'-й* из *'+cnt+'*. Ожидайте заказы!',[{id:'go_offline',text:'⚫ Уйти с линии'}]); return; }
  if (buttonId === 'go_offline') { const driverMgr = require('../modules/driverManager'); await driverMgr.goOffline(phone); await wa.sendButtons(phone,'⚫ *Вы ушли с линии.*\n\nОтдыхайте!',[{id:'go_online',text:'🟢 Выйти на линию'},{id:'order_as_client',text:'🚖 Заказать такси'}]); return; }
};

module.exports = { handle };

