const wa = require('../whatsapp/greenApi');
const q = require('../db/queries');
const driverMgr = require('../modules/driverManager');
const orderEngine = require('../modules/orderEngine');
const chatRelay = require('../modules/chatRelay');
const notify = require('../modules/notificationService');
const tariff = require('../modules/tariffEngine');
const config = require('../config');
const { recognizeVoice } = require('../modules/voiceRecognizer');
const { getGroqDriverReply } = require('../modules/smartReply');
const { getWeather, formatWeatherForGroq } = require('../modules/weatherService');

const KW = {
  ONLINE:  ['на линию','на линии','выхожу','начинаю','работаю','онлайн','старт','начать','лайн','жұмыс','жұмысқа','линияға шығам','шығамын'],
  OFFLINE: ['с линии','ухожу','заканчиваю','офлайн','оффлайн','стоп','отдых','отдыхаю','перерыв','линиядан','аяқтадым'],
  ACCEPT:  ['принял','принять','беру','возьму','ok','ок','да','иду','еду','қабылдадым','аламын','принимаю','берусь','согласен'],
  ARRIVED: ['прибыл','приехал','на месте','подъехал','жду','стою','келдім','жеттім','у клиента','на адресе'],
  DONE:    ['свободен','завершил','готово','доехали','доставил','освободился','бостымын','клиент вышел','довёз','закончил'],
  FALSE:   ['ложный','нет клиента','никого нет','пусто','ложный вызов','жалған','жоқ','клиента нет'],
  SKIP:    ['пропустить','пропуск','пропускаю','следующий','өткізу'],
  STATS:   ['статистика','стат','итоги','сколько заработал','мои поездки','қанша','заработок','поездки'],
  EDIT:    ['изменить','изменить данные','сменить данные','редактировать'],
  QUEUE:   ['очередь','моя очередь','где я','позиция','кезек','кезегім'],
};

const match = (text, keywords) => keywords.some(w => text.includes(w));

const handle = async (phone, msg, session) => {
  let { text, type, buttonId, mediaUrl } = msg;
  const state = session?.state || 'idle';
  try {
    if (type === 'voice') {
      if (!mediaUrl) { await wa.sendText(phone, 'Не удалось получить голосовое. Напишите команду.'); return; }
      const voiceText = await recognizeVoice(mediaUrl).catch(() => null);
      if (!voiceText || voiceText.length < 2) { await wa.sendText(phone, 'Не удалось распознать. Напишите команду.'); return; }
      const vlo = voiceText.toLowerCase().trim();
      const driver2 = await q.getDriver(phone);
      if (driver2?.status === 'busy') {
        const order2 = await q.getActiveOrderByDriver(phone);
        if (order2) {
          if (match(vlo, KW.ARRIVED)) { await orderEngine.arrived(order2.id, phone); return; }
          if (match(vlo, KW.DONE))    { await orderEngine.complete(order2.id, phone); return; }
          if (match(vlo, KW.FALSE))   { await orderEngine.falseCall(order2.id, phone); return; }
        }
      }
      if (match(vlo, KW.ACCEPT)) { const p2 = await q.getPendingOrderForDriver(phone); if (p2) await orderEngine.accept(p2.id, phone); else await wa.sendText(phone, 'Net predlozheniya.'); return; }
      if (match(vlo, KW.SKIP))   { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone, 'Propushcheno.'); return; }
      if (match(vlo, KW.ONLINE)) {
        await q.clearSession(phone);
        const r2 = await driverMgr.goOnline(phone);
        if (r2.error === 'no_balance') { await wa.sendText(phone, 'Balans = 0. Popolnite cherez admina.'); return; }
        const pos2 = await q.getDriverQueuePosition(phone);
        const cnt2 = (await q.getOnlineDriversQueue()).length;
        await wa.sendText(phone, `Vy na linii! ${pos2}-y iz ${cnt2} voditeley.`);
        return;
      }
      if (match(vlo, KW.OFFLINE)) { await driverMgr.goOffline(phone); await wa.sendText(phone, 'Ushli s linii. Otdyhayte!'); return; }
      if (match(vlo, KW.STATS))   { const stats2 = await q.getDriverTodayStats(driver2?.id); await notify.driverStats(phone, driver2, stats2); return; }
      const groqVoice = await getGroqDriverReply(voiceText, driver2?.full_name, null, { status: driver2?.status });
      await wa.sendText(phone, groqVoice || `Vy skazali: "${voiceText}"\n\nKomandy: prinyat, pribyl, svoboden, lozhnyy, na liniyu, s linii, statistika`);
      return;
    }

    if (state.startsWith('reg_'))  return await handleRegistration(phone, msg, state);
    if (state.startsWith('edit_')) return await handleEdit(phone, msg, state);
    if (state === 'cancel_reason') return await handleCancelReason(phone, text, session?.ctx || {});
    if (type === 'button' && buttonId) return await handleButton(phone, buttonId);
    if (state === 'driver_chat') {
      if ((text||'').toLowerCase() === 'стоп') { await q.clearSession(phone); await wa.sendText(phone, 'Chat zavershyon.'); return; }
      return chatRelay.fromDriver(phone, text);
    }
    if (state === 'driver_as_client') return handleAsClient(phone, msg, session);

    const driver = await q.getDriver(phone);
    if (!driver) { await wa.sendText(phone, 'Voditel ne nayden.'); return; }
    const lo = (text||'').toLowerCase().trim();

    if (driver.status === 'busy') {
      const order = await q.getActiveOrderByDriver(phone);
      if (order) {
        if (match(lo, KW.ARRIVED)) { await orderEngine.arrived(order.id, phone); return; }
        if (match(lo, KW.DONE))    { await orderEngine.complete(order.id, phone); return; }
        if (match(lo, KW.FALSE))   { await orderEngine.falseCall(order.id, phone); return; }
        await wa.sendText(phone, 'Vy v poezdke.\n\npribyl — priehali k klientu\nsvoboden — dovezli klienta\nlozhnyy — klienta net');
        return;
      }
    }

    if (match(lo, KW.ACCEPT)) { const pending = await q.getPendingOrderForDriver(phone); if (pending) await orderEngine.accept(pending.id, phone); else await wa.sendText(phone, 'Net aktivnogo predlozheniya.'); return; }
    if (match(lo, KW.SKIP))   { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone, 'Propushcheno.'); return; }

    if (match(lo, KW.ONLINE)) {
      await q.clearSession(phone);
      const r = await driverMgr.goOnline(phone);
      if (r.error === 'no_balance') { await wa.sendText(phone, 'Balans = 0. Obratites k administratoru.'); return; }
      if (r.error === 'in_trip')    { await wa.sendText(phone, 'Vy seychas v poezdke.'); return; }
      const pos = await q.getDriverQueuePosition(phone);
      const cnt = (await q.getOnlineDriversQueue()).length;
      await wa.sendButtons(phone, `Na linii! Vy ${pos}-y iz ${cnt} voditeley.`, [{ id:'go_offline', text:'Uyti s linii' }]);
      return;
    }

    if (match(lo, KW.OFFLINE)) {
      await driverMgr.goOffline(phone);
      await wa.sendButtons(phone, 'Ushli s linii.', [{ id:'go_online', text:'Vyyti na liniyu' }, { id:'order_as_client', text:'Zakazat taksi' }]);
      return;
    }

    if (match(lo, KW.STATS)) { const stats = await q.getDriverTodayStats(driver.id); await notify.driverStats(phone, driver, stats); return; }

    if (match(lo, KW.QUEUE)) {
      if (driver.status !== 'online') {
        await wa.sendText(phone, 'Vy ne na linii. Napishite Na liniyu chtoby nachat.');
      } else {
        const pos = await q.getDriverQueuePosition(phone);
        const online = await q.getOnlineDriversQueue();
        await wa.sendText(phone, `Vasha pozitsiya: ${pos}-y iz ${online.length} voditeley onlayn.`);
      }
      return;
    }

    if (match(lo, KW.EDIT)) { await wa.sendText(phone, 'Chto izmenit?\n\nimya, avto, foto, tsvet'); return; }
    if (['имя','фио'].includes(lo))  { await q.setSession(phone, 'edit_name', {}); await wa.sendText(phone, 'Vvedite novoe FIO:'); return; }
    if (['авто','номер'].includes(lo)) { await q.setSession(phone, 'edit_car', {}); await wa.sendText(phone, 'Vvedite marku i nomer:'); return; }
    if (['фото'].includes(lo))        { await q.setSession(phone, 'edit_photo', {}); await wa.sendText(phone, 'Otpravte foto avtomobilya:'); return; }
    if (['цвет'].includes(lo))        { await q.setSession(phone, 'edit_color', {}); await wa.sendText(phone, 'Vvedite tsvet avtomobilya:'); return; }

    if (!lo) { const stats = await q.getDriverTodayStats(driver.id); await notify.driverStats(phone, driver, stats); return; }

    const stats = await q.getDriverTodayStats(driver.id);
    const queuePos = await q.getDriverQueuePosition(phone).catch(() => null);
    const onlineList = await q.getOnlineDriversQueue().catch(() => []);
    const groqReply = await getGroqDriverReply(text, driver.full_name, stats, { status: driver.status, queuePos, queueTotal: onlineList.length });
    if (groqReply) {
      await wa.sendText(phone, groqReply);
    } else {
      await wa.sendButtons(phone, 'Komandy:\nNa liniyu / S linii\nStatistika\nIzmenit dannye',
        [driver.status === 'online' ? { id:'go_offline', text:'Uyti s linii' } : { id:'go_online', text:'Vyyti na liniyu' }]);
    }

  } catch (err) {
    console.error('[driverHandler]', err.message);
    await wa.sendText(phone, 'Proizoshla oshibka.').catch(() => {});
  }
};

const handleAsClient = async (phone, msg, session) => {
  const { text, type, buttonId } = msg;
  const ctx = session?.ctx || {};
  const lo = (text||'').toLowerCase().trim();
  if (type === 'button') {
    if (buttonId === 'confirm_order') { if (!ctx.destination) return; await orderEngine.create(phone, ctx.destination, { price: ctx.price, tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null }); return; }
    if (buttonId === 'cancel_new')    { await q.clearSession(phone); await wa.sendText(phone, 'Otmeneno.'); return; }
    if (buttonId === 'order_as_client') { await q.setSession(phone, 'driver_as_client', {}); await wa.sendText(phone, 'Kuda nuzhno ekhat?'); return; }
    if (buttonId === 'cancel_order')  { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id, 'Otmenyon'); else { await q.clearSession(phone); await wa.sendText(phone, 'Net zakaza.'); } return; }
    return;
  }
  if (!text || text.length < 2) return;
  if (match(lo, KW.ONLINE)) {
    await q.clearSession(phone);
    const r = await driverMgr.goOnline(phone);
    if (r.error === 'no_balance') { await wa.sendText(phone, 'Balans = 0.'); return; }
    const pos = await q.getDriverQueuePosition(phone);
    const cnt = (await q.getOnlineDriversQueue()).length;
    await wa.sendButtons(phone, `Na linii! ${pos}-y iz ${cnt}.`, [{ id:'go_offline', text:'Uyti s linii' }]);
    return;
  }
  if (ctx.confirming) {
    if (['да','ок','ok','yes','поехали','иә'].includes(lo)) { await orderEngine.create(phone, ctx.destination, { price: ctx.price, tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null }); return; }
    if (['нет','отмена','cancel','жоқ'].includes(lo))       { await q.clearSession(phone); await wa.sendText(phone, 'Otmeneno.'); return; }
  }
  const active = await q.getActiveOrderByClient(phone);
  if (active) { await wa.sendText(phone, 'U vas est aktivnyy zakaz!'); return; }
  const pi = await tariff.getPrice(text);
  const nightNote = pi.isNight ? ' (nochnoj tarif)' : '';
  await wa.sendButtons(phone, `Vash zakaz:\n\nKuda: ${text}\nTsena: ${pi.price} tg${nightNote}\n\nPodtverdit?`, [{ id:'confirm_order', text:'Da, poekhali!' }, { id:'cancel_new', text:'Otmena' }]);
  await q.setSession(phone, 'driver_as_client', { confirming: true, destination: text, price: pi.price, tariff_id: pi.tariff?.id || null });
};

const handleButton = async (phone, buttonId) => {
  if (buttonId === 'order_as_client') { await q.setSession(phone, 'driver_as_client', {}); await wa.sendText(phone, 'Kuda nuzhno ekhat?'); return; }
  if (buttonId === 'go_online')  { await q.clearSession(phone); const r = await driverMgr.goOnline(phone); if (r.error === 'no_balance') { await wa.sendText(phone, 'Balans = 0.'); return; } const pos = await q.getDriverQueuePosition(phone); const cnt = (await q.getOnlineDriversQueue()).length; await wa.sendButtons(phone, `Na linii! ${pos}-y iz ${cnt}`, [{ id:'go_offline', text:'Uyti s linii' }]); return; }
  if (buttonId === 'go_offline') { await driverMgr.goOffline(phone); await wa.sendButtons(phone, 'Ushli s linii.', [{ id:'go_online', text:'Vyyti na liniyu' }, { id:'order_as_client', text:'Zakazat taksi' }]); return; }
  if (buttonId.startsWith('accept_')) { const r = await orderEngine.accept(parseInt(buttonId.replace('accept_', '')), phone); if (r?.error === 'already_taken') await wa.sendText(phone, 'Uzhe prinyat drugim.'); else if (r?.error) await wa.sendText(phone, 'Zakaz nedostupen.'); return; }
  if (buttonId.startsWith('skip_'))    { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone, 'Propushcheno.'); return; }
  if (buttonId.startsWith('arrived_')) { await orderEngine.arrived(parseInt(buttonId.replace('arrived_', '')), phone); return; }
  if (buttonId.startsWith('false_'))   { await orderEngine.falseCall(parseInt(buttonId.replace('false_', '')), phone); return; }
  if (buttonId.startsWith('done_'))    { await orderEngine.complete(parseInt(buttonId.replace('done_', '')), phone); return; }
  if (buttonId.startsWith('chat_'))    { await q.setSession(phone, 'driver_chat', { order_id: parseInt(buttonId.replace('chat_', '')) }); await wa.sendText(phone, 'Chat s klientom. Vyhod: stop'); return; }
  if (buttonId === 'edit_name')  { await q.setSession(phone, 'edit_name', {}); await wa.sendText(phone, 'Vvedite novoe FIO:'); return; }
  if (buttonId === 'edit_car')   { await q.setSession(phone, 'edit_car', {}); await wa.sendText(phone, 'Vvedite marku i nomer:'); return; }
  if (buttonId === 'edit_photo') { await q.setSession(phone, 'edit_photo', {}); await wa.sendText(phone, 'Otpravte foto:'); return; }
};

const handleEdit = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg;
  if (state === 'edit_name')  { if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite FIO:'); return; } await q.updateDriver(phone, { full_name: text.trim().slice(0, 100) }); await q.clearSession(phone); await wa.sendText(phone, 'Imya obnovleno: ' + text.trim()); return; }
  if (state === 'edit_car')   { const parts = (text||'').split(',').map(s => s.trim()); if (parts.length < 2 || !parts[0] || !parts[1]) { await wa.sendText(phone, 'Format: Marka, Nomer'); return; } await q.updateDriver(phone, { car_make: parts[0].slice(0, 50), car_plate: parts[1].toUpperCase().slice(0, 20) }); await q.clearSession(phone); await wa.sendText(phone, 'Avto obnovleno!'); return; }
  if (state === 'edit_photo') { if (type !== 'image' || !mediaUrl) { await wa.sendText(phone, 'Otpravte foto:'); return; } await q.updateDriver(phone, { car_photo_url: mediaUrl }); await q.clearSession(phone); await wa.sendText(phone, 'Foto obnovleno!'); return; }
  if (state === 'edit_color') { if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite tsvet:'); return; } await q.updateDriver(phone, { car_color: text.trim().slice(0, 50) }); await q.clearSession(phone); await wa.sendText(phone, 'Tsvet obnovlyon: ' + text.trim()); return; }
};

const handleCancelReason = async (phone, text, ctx) => {
  const order = await q.getActiveOrderByDriver(phone);
  if (!order) { await q.clearSession(phone); return; }
  await orderEngine.cancel(order.id, text?.slice(0, 200) || 'Voditel otmenil');
};

const handleRegistration = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg;
  switch (state) {
    case 'reg_name':  if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite FIO:'); return; } await q.updateDriver(phone, { full_name: text.trim().slice(0, 100) }); await q.setSession(phone, 'reg_photo', {}); await wa.sendText(phone, 'Imya: ' + text.trim() + '\n\nShag 2/5: Otpravte foto avtomobilya:'); break;
    case 'reg_photo': if (type !== 'image' || !mediaUrl) { await wa.sendText(phone, 'Otpravte foto:'); return; } await q.updateDriver(phone, { car_photo_url: mediaUrl }); await q.setSession(phone, 'reg_make', {}); await wa.sendText(phone, 'Foto sohraneno!\n\nShag 3/5: Marka i model avto:'); break;
    case 'reg_make':  if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite marku:'); return; } await q.updateDriver(phone, { car_make: text.trim().slice(0, 50) }); await q.setSession(phone, 'reg_plate', {}); await wa.sendText(phone, 'Marka: ' + text.trim() + '\n\nShag 4/5: Gos. nomer:'); break;
    case 'reg_plate': if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite nomer:'); return; } await q.updateDriver(phone, { car_plate: text.trim().toUpperCase().slice(0, 20) }); await q.setSession(phone, 'reg_color', {}); await wa.sendText(phone, 'Nomer: ' + text.trim().toUpperCase() + '\n\nShag 5/5: Tsvet avto:'); break;
    case 'reg_color': if (!text || text.length < 2) { await wa.sendText(phone, 'Vvedite tsvet:'); return; }
      await q.updateDriver(phone, { car_color: text.trim().slice(0, 50) });
      await q.clearSession(phone);
      const d = await q.getDriver(phone);
      const weather = await getWeather().catch(() => null);
      const weatherStr = weather ? formatWeatherForGroq(weather) : '';
      await wa.sendText(phone,
        'Dobro pozhalovat v eOsakarovka Servis!\n\n' +
        'Voditel: ' + d.full_name + '\n' +
        'Avto: ' + d.car_make + ', ' + d.car_color + '\n' +
        'Nomer: ' + d.car_plate + '\n\n' +
        (weatherStr ? weatherStr + '\n\n' : '') +
        'Instruktsiya:\n' +
        'Na liniyu — nachat prinimat zakazy\n' +
        'S linii — zakonchit rabotu\n' +
        'Prinyat — prinyat zakaz\n' +
        'Pribyl — priehali k klientu\n' +
        'Svoboden — poezdka zavershena\n' +
        'Lozhnyy — klienta net\n' +
        'Statistika — vash zarabotok\n' +
        'Ochered — vasha pozitsiya\n\n' +
        'Vse komandy rabotayut golosom!\n\n' +
        'Napishite Na liniyu chtoby nachat!'
      );
      break;
  }
};

module.exports = { handle };
