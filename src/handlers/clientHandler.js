const wa = require('../whatsapp/greenApi');
const q = require('../db/queries');
const db = require('../db/index');
const tariff = require('../modules/tariffEngine');
const orderEngine = require('../modules/orderEngine');
const chatRelay = require('../modules/chatRelay');
const config = require('../config');
const { isAddress, resolveAddress } = require('../modules/addressDetector');
const { recognizeVoice } = require('../modules/voiceRecognizer');
const { getGroqReply, parseScheduleTime } = require('../modules/smartReply');
const { dailyGreeting } = require('../modules/greetingService');
const favAddr = require('../modules/favoriteAddresses');

const INTERCITY = ['есиль','литвинское','литвинка','5 поселок','пятый поселок',
  'карагайлы','октябрьское','акбулак','пролетарское','озерное','приишимское',
  'колхозное','садовое','николаевка','сункар','скобелевка','шункыркол','богучар',
  'уызбай','сарыозек','вольское','сарыозен','крестовка','ошаганды','батпакты',
  'батпак','мирное','трудовое','тельманское','акпан','новый кронштадт','шидерты',
  'иртышское','звездное','дальнее','родниковское','шокай','чапаево','темиртау',
  'балхаш','астана','нурсултан','кокшетау','павлодар','петропавловск','семей'];

const isIntercity = (text) => INTERCITY.some(w => (text||'').toLowerCase().includes(w));
const CANCEL  = ['отмена','cancel','нет','жок','стоп','назад','выход','отменить','не надо'];
const CONFIRM = ['да','ok','ок','yes','подтверждаю','поехали','ия','иа'];
const isCancel  = (lo) => CANCEL.some(w => lo === w || lo.includes(w));
const isConfirm = (lo) => CONFIRM.some(w => lo === w);

const getSmartReply = (text) => {
  const lo = (text||'').toLowerCase().trim();
  if (['привет','здравствуйте','добрый','хай','hi','hello','салем','ассалам','сәлем','қайырлы'].some(w => lo === w || lo.startsWith(w+' ') || lo.startsWith(w+'!')))
    return 'Рады вас слышать! Напишите куда нужно ехать.';
  if (['машину','такси','нужна машина','заказать такси','такси керек','машина керек','нужно такси'].some(w => lo.includes(w)))
    return 'Напишите куда нужно ехать — сразу найдем водителя!';
  if (['сколько стоит','цена','тариф','почем','баға','қанша'].some(w => lo.includes(w)))
    return 'Цена от 500 тг по поселку. Напишите адрес — скажем точную цену!';
  if (['долго ждать','сколько ждать','когда приедет'].some(w => lo.includes(w)))
    return 'Водитель приедет через 3-7 минут после принятия заказа.';
  if (['ночью','ночной тариф','түнде'].some(w => lo.includes(w)))
    return 'С 23:00 до 07:00 действует ночной тариф.';
  if (['карта','безнал','каспи','kaspi'].some(w => lo.includes(w)))
    return 'Оплата наличными водителю. Безналичную оплату уточняйте у водителя.';
  if (['спасибо','рахмет','благодарю','рақмет'].some(w => lo.includes(w)))
    return 'Пожалуйста! Всегда рады помочь. Ждем вас снова!';
  if (['пока','до свидания','сау болын'].some(w => lo.includes(w)))
    return 'До свидания! Ждем вас снова в еОсакаровка Сервис!';
  if (['помощь','как заказать','help','инструкция'].some(w => lo.includes(w)))
    return 'Как заказать такси:\n1. Напишите куда нужно ехать\n2. Подтвердите заказ\n3. Ждите водителя!';
  if (['работаете','круглосуточно','открыты'].some(w => lo.includes(w)))
    return 'Да, работаем круглосуточно! Напишите куда нужно ехать.';
  if (['с вещами','с багажом','багаж'].some(w => lo.includes(w)))
    return 'Напишите куда ехать — водитель поможет с вещами!';
  if (['детское кресло','с ребенком','с детьми'].some(w => lo.includes(w)))
    return 'Напишите куда ехать и уточните у водителя наличие детского кресла.';
  if (['не знаю адрес','не знаю куда','ориентир'].some(w => lo.includes(w)))
    return 'Напишите ближайший ориентир — магазин, школу, остановку или улицу.';
  if (['что за сервис','кто вы','о компании'].some(w => lo.includes(w)))
    return 'Мы — еОсакаровка Сервис, диспетчерская служба поселка Осакаровка. Пишите адрес — найдем водителя!';
  return null;
};

const handle = async (phone, name, msg, session) => {
  const { text, type, buttonId, mediaUrl } = msg;
  const state = session?.state || 'idle';
  const lo = (text||'').toLowerCase().trim();
  try {
    if (type === 'button' && buttonId) return await handleButton(phone, buttonId, session);

    if (state === 'chat_mode') {
      if (lo === 'стоп') { const order = await q.getActiveOrderByClient(phone); await q.setSession(phone, order ? 'in_trip' : 'idle', {}); await wa.sendText(phone, 'Чат завершен.'); return; }
      return chatRelay.fromClient(phone, text);
    }

    if (state === 'waiting_driver') {
      if (['где','где водитель','едет','когда'].some(k => lo.includes(k))) {
        const order = await q.getActiveOrderByClient(phone);
        if (order) { const mins = Math.floor((Date.now()-new Date(order.created_at))/60000); await wa.sendText(phone, 'Ищем водителя уже ' + mins + ' мин...\nКак только найдем — сразу сообщим!'); }
        return;
      }
      if (isCancel(lo)) { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id, 'Отменен клиентом'); else { await q.clearSession(phone); await wa.sendText(phone, 'Нет активного заказа.'); } return; }
      await wa.sendButtons(phone, 'Ищем водителя...', [{ id:'cancel_order', text:'Отменить заказ' }]);
      return;
    }

    if (state === 'in_trip') {
      await wa.sendButtons(phone, 'Вы в поездке!', [{ id:'chat_driver', text:'Написать водителю' }]);
      return;
    }

    if (state === 'intercity_pickup') {
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
      if (!text || text.length < 2) { await wa.sendText(phone, 'Введите адрес откуда вас забрать:'); return; }
      const ctx = session?.ctx || {};
      await q.setSession(phone, 'intercity_time', { ...ctx, pickup: text.trim() });
      await wa.sendText(phone, 'Откуда: ' + text.trim() + '\n\nНа какое время нужна машина?\n\nНапишите:\n- сейчас\n- завтра в 8:00\n- сегодня в 15:00');
      return;
    }

    if (state === 'intercity_time') {
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
      if (!text || text.length < 2) { await wa.sendText(phone, 'Напишите время (сейчас / завтра в 8:00):'); return; }
      const ctx = session?.ctx || {};
      const parsedTime = await parseScheduleTime(text).catch(() => text);
      const isNow = parsedTime === 'сейчас';
      const timeStr = isNow ? 'Сейчас' : parsedTime;
      const pi = await tariff.getPrice(ctx.destination || '');
      await q.setSession(phone, 'intercity_confirm', { ...ctx, timeStr, isNow, price: pi.price });
      await wa.sendButtons(phone,
        'Межгородской заказ:\n\nОткуда: ' + ctx.pickup + '\nКуда: ' + ctx.destination + '\nВремя: ' + timeStr + '\nЦена: ' + pi.price + ' тг\n\nПодтвердить?',
        [{ id:'confirm_intercity', text:'Да, подтверждаю' }, { id:'cancel_new', text:'Отмена' }]
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
      if (isCancel(lo)) { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
      const f = await q.getSession(phone);
      if (f?.ctx?.destination) {
        await wa.sendButtons(phone,
          'Ваш заказ:\n\nКуда: ' + f.ctx.destination + '\nЦена: ' + f.ctx.price + ' тг\n\nПодтвердить?',
          [{ id:'confirm_order', text:'Да, поехали!' }, { id:'cancel_new', text:'Отмена' }]);
      }
      return;
    }

    if (type === 'voice') {
      if (mediaUrl) {
        await wa.sendText(phone, 'Распознаю голосовое...');
        const recognized = await recognizeVoice(mediaUrl);
        if (recognized && recognized.length >= 2) {
          const smartR = getSmartReply(recognized);
          if (smartR) { await wa.sendText(phone, smartR); return; }
          if (isIntercity(recognized)) {
            const active0 = await q.getActiveOrderByClient(phone);
            if (!active0) { await q.setSession(phone, 'intercity_pickup', { destination: recognized }); await wa.sendText(phone, 'Межгородская поездка!\nКуда: ' + recognized + '\n\nОткуда вас забрать?'); }
            return;
          }
          const addr = await isAddress(recognized);
          if (addr) { const user = await q.getUser(phone); return handleNewOrder(phone, name, recognized, user); }
          const groqR = await getGroqReply(recognized).catch(() => null);
          await wa.sendText(phone, groqR || 'Напишите куда нужно ехать.');
          return;
        } else { await wa.sendText(phone, 'Не удалось распознать. Напишите куда ехать.'); return; }
      }
      await wa.sendText(phone, 'Напишите куда нужно ехать.');
      return;
    }

    if (!text || text.length < 2) { await wa.sendText(phone, 'Напишите куда нужно ехать:'); return; }

    const shortcut = await favAddr.resolveShortcut(phone, lo).catch(() => null);
    if (shortcut) { const user = await q.getUser(phone); return handleNewOrder(phone, name, shortcut.address, user); }

    if (lo.startsWith('домой это ') || lo.startsWith('мой дом ')) {
      const addr = text.replace(/^домой это |^мой дом /i, '').trim();
      await favAddr.saveHome(phone, addr);
      await wa.sendText(phone, 'Домашний адрес сохранен: ' + addr + '\n\nТеперь пишите "домой" — сразу поедем!');
      return;
    }
    if (lo.startsWith('работа это ') || lo.startsWith('моя работа ')) {
      const addr = text.replace(/^работа это |^моя работа /i, '').trim();
      await favAddr.saveWork(phone, addr);
      await wa.sendText(phone, 'Рабочий адрес сохранен: ' + addr + '\n\nТеперь пишите "на работу" — сразу поедем!');
      return;
    }

    if (['история','мои поездки','поездки','тарихым','сапарым'].some(w => lo.includes(w))) {
      const userR = await q.getUser(phone);
      const hist = await db.query(`SELECT destination, price, status, created_at FROM orders WHERE client_id=$1 AND status IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 5`, [userR?.id]).then(r => r.rows).catch(() => []);
      if (!hist.length) { await wa.sendText(phone, 'У вас пока нет поездок.\n\nНапишите куда ехать!'); return; }
      const lines = hist.map((h,i) => { const date = new Date(h.created_at).toLocaleDateString('ru-RU',{day:'numeric',month:'short'}); return (i+1) + '. ' + (h.status==='completed'?'OK':'X') + ' ' + date + ' — ' + h.destination + ' — ' + h.price + ' тг'; }).join('\n');
      const nextFree = 10 - ((userR?.trip_count||0) % 10);
      await wa.sendText(phone, 'Ваши последние поездки:\n\n' + lines + '\n\nВсего поездок: ' + (userR?.trip_count||0) + '\nДо бесплатной: ' + nextFree);
      return;
    }

    if (['есть такси','есть машина','такси есть','бар ма такси','такси бар ма'].some(w => lo.includes(w))) {
      const online = await q.getOnlineDriversQueue().catch(() => []);
      const cnt = online.length;
      if (cnt === 0) await wa.sendText(phone, 'Сейчас все водители заняты.\nОбычно ждать 5-10 минут.\n\nНапишите адрес — поставим в очередь!');
      else await wa.sendText(phone, 'Да! Сейчас ' + cnt + ' водител' + (cnt===1?'ь':'я') + ' на линии.\nНапишите куда ехать!');
      return;
    }

    if (isIntercity(text)) {
      const active0 = await q.getActiveOrderByClient(phone);
      if (active0) { await wa.sendText(phone, 'У вас уже есть активный заказ!'); return; }
      await q.setSession(phone, 'intercity_pickup', { destination: text });
      await wa.sendText(phone, 'Межгородская поездка!\nКуда: ' + text + '\n\nОткуда вас забрать?\n(напишите адрес или ориентир)');
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
  if (active) { await wa.sendText(phone, 'У вас уже есть активный заказ!\n' + active.destination + '\n\nДождитесь завершения или отмените.'); return; }
  if (isIntercity(text)) {
    await q.setSession(phone, 'intercity_pickup', { destination: text });
    await wa.sendText(phone, 'Межгородская поездка!\nКуда: ' + text + '\n\nОткуда вас забрать?\n(напишите адрес или ориентир)');
    return;
  }
  const resolved = await resolveAddress(text).catch(() => ({ found: false }));
  // resolved.name используем только если он содержит оригинальный текст (истинное обогащение).
  // "школа" → "Средняя школа №2" (содержит "школа") → OK.
  // "целинная 10" → "Целинная улица" (не содержит "целинная 10") → берём оригинал.
  const enriched = resolved.found &&
    resolved.name.toLowerCase().includes(text.trim().toLowerCase());
  const displayAddress = enriched ? resolved.name : text.trim();
  const pi = await tariff.getPrice(text);
  const nightNote = pi.isNight ? ' (ночной тариф)' : '';
  const freeNote = user && (user.trip_count+1) % config.FREE_TRIP_EVERY === 0 ? '\nЭта поездка будет БЕСПЛАТНОЙ!' : '';
  await wa.sendButtons(phone,
    'Ваш заказ:\n\nКуда: ' + displayAddress + '\nЦена: ' + pi.price + ' тг' + nightNote + freeNote + '\n\nПодтвердить?',
    [{ id:'confirm_order', text:'Да, поехали!' }, { id:'cancel_new', text:'Отмена' }]);
  await q.setSession(phone, 'confirming', { destination: displayAddress, price: pi.price, tariff_id: pi.tariff?.id||null });
};

const handleButton = async (phone, buttonId, session) => {
  if (buttonId === 'confirm_order') { const f = await q.getSession(phone); if (!f||f.state!=='confirming') return; const {destination,price,tariff_id} = f.ctx; await orderEngine.create(phone, destination, {price, tariff: tariff_id?{id:tariff_id}:null}); return; }
  if (buttonId === 'confirm_intercity') { const f = await q.getSession(phone); if (!f||f.state!=='intercity_confirm') return; const ctx = f.ctx; await orderEngine.create(phone, ctx.destination, {price: ctx.price, pickup_address: ctx.pickup, is_intercity: true}); return; }
  if (buttonId === 'cancel_new') { await q.clearSession(phone); await wa.sendText(phone, 'Отменено. Напишите куда ехать.'); return; }
  if (buttonId === 'cancel_order') { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id,'Отменен'); else { await q.clearSession(phone); await wa.sendText(phone,'Нет заказа.'); } return; }
  if (buttonId === 'chat_driver') { const order = await q.getActiveOrderByClient(phone); if (!order) { await wa.sendText(phone,'Нет заказа.'); return; } await q.setSession(phone,'chat_mode',{prev_state:session?.state||'idle',order_id:order.id}); await wa.sendText(phone,'Чат с водителем активирован.\nНапишите сообщение.\n\nДля выхода: стоп'); return; }
};

module.exports = { handle };

