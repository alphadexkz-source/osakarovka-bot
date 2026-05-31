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

// ── КЛЮЧЕВЫЕ СЛОВА (одинаковые для текста и голоса) ──────────
const KW = {
  ONLINE:  ['на линию','на линии','выхожу','начинаю','работаю','онлайн','старт','начать','лайн','жұмыс','жұмысқа','линияға шығам','шығамын','работать начну','выхожу на'],
  OFFLINE: ['с линии','ухожу','заканчиваю','офлайн','стоп','отдых','отдыхаю','перерыв','линиядан','аяқтадым','заканчиваю работу','ухожу с'],
  ACCEPT:  ['принял','принять','беру','возьму','ok','ок','да','иду','еду','қабылдадым','аламын','принимаю','берусь','согласен','едем'],
  ARRIVED: ['прибыл','приехал','на месте','подъехал','жду','стою','келдім','жеттім','я у клиента','подъехал к','приехал к','у клиента','на адресе'],
  DONE:    ['свободен','завершил','готово','доехали','доставил','освободился','бостымын','поездка завершена','клиент вышел','довёз','всё','закончил','завершена'],
  FALSE:   ['ложный','нет клиента','никого нет','пусто','ложный вызов','жалған','жоқ','клиента нет','пусто на месте','никого','нет никого'],
  SKIP:    ['пропустить','пропуск','пропускаю','следующий','өткізу','өту'],
  STATS:   ['статистика','стат','итоги','сколько заработал','мои поездки','қанша','заработок','поездки','мой заработок','сколько поездок'],
  EDIT:    ['изменить','изменить данные','сменить данные','редактировать','edit'],
};

const match = (text, keywords) => keywords.some(w => text.includes(w));

const handle = async (phone, msg, session) => {
  let { text, type, buttonId, mediaUrl } = msg;
  const state = session?.state || 'idle';

  try {
    // ── ГОЛОСОВЫЕ СООБЩЕНИЯ ────────────────────────────────────
    if (type === 'voice') {
      if (!mediaUrl) { await wa.sendText(phone,'🎤 Не удалось получить голосовое. Напишите команду.'); return; }
      const voiceText = await recognizeVoice(mediaUrl).catch(() => null);
      if (!voiceText || voiceText.length < 2) {
        await wa.sendText(phone,'🎤 Не удалось распознать. Напишите команду.');
        return;
      }
      const vlo = voiceText.toLowerCase().trim();
      const driver2 = await q.getDriver(phone);

      // В поездке
      if (driver2?.status === 'busy') {
        const order2 = await q.getActiveOrderByDriver(phone);
        if (order2) {
          if (match(vlo, KW.ARRIVED)) { await orderEngine.arrived(order2.id,phone); return; }
          if (match(vlo, KW.DONE))    { await orderEngine.complete(order2.id,phone); return; }
          if (match(vlo, KW.FALSE))   { await orderEngine.falseCall(order2.id,phone); return; }
        }
      }
      if (match(vlo, KW.ACCEPT)) {
        const pending2 = await q.getPendingOrderForDriver(phone);
        if (pending2) await orderEngine.accept(pending2.id,phone);
        else await wa.sendText(phone,'⚠️ Нет предложения.');
        return;
      }
      if (match(vlo, KW.SKIP))    { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone,'⏭ Пропущено.'); return; }
      if (match(vlo, KW.ONLINE))  {
        await q.clearSession(phone);
        const r2 = await driverMgr.goOnline(phone);
        if (r2.error==='no_balance') { await wa.sendText(phone,'🔴 Баланс = 0. Пополните через администратора.'); return; }
        const pos2 = await q.getDriverQueuePosition(phone);
        const cnt2 = (await q.getOnlineDriversQueue()).length;
        await wa.sendText(phone,`🟢 Вы на линии! *${pos2}-й* из *${cnt2}* водителей.\n\nЖдём заказов! 🚖`);
        return;
      }
      if (match(vlo, KW.OFFLINE)) { await driverMgr.goOffline(phone); await wa.sendText(phone,'⚫ Ушли с линии. Отдыхайте! 😊'); return; }
      if (match(vlo, KW.STATS))   {
        const stats2 = await q.getDriverTodayStats(driver2?.id);
        await notify.driverStats(phone,driver2,stats2);
        return;
      }

      // Непонятная голосовая → Groq
      const groqVoice = await getGroqDriverReply(voiceText, driver2?.full_name, null);
      await wa.sendText(phone, groqVoice || `🎤 Вы сказали: _"${voiceText}"_\n\nКоманды голосом:\n*принял, прибыл, свободен, ложный\nна линию, с линии, статистика*`);
      return;
    }

    // ── СОСТОЯНИЯ ─────────────────────────────────────────────
    if (state.startsWith('reg_'))   return await handleRegistration(phone, msg, state);
    if (state.startsWith('edit_'))  return await handleEdit(phone, msg, state);
    if (state === 'cancel_reason')  return await handleCancelReason(phone, text, session?.ctx||{});
    if (type === 'button' && buttonId) return await handleButton(phone, buttonId);
    if (state === 'driver_chat') {
      if (text?.toLowerCase() === 'стоп') { await q.clearSession(phone); await wa.sendText(phone,'↩️ Чат завершён.'); return; }
      return chatRelay.fromDriver(phone, text);
    }
    if (state === 'driver_as_client') return handleAsClient(phone, msg, session);

    const driver = await q.getDriver(phone);
    if (!driver) { await wa.sendText(phone,'❌ Водитель не найден.'); return; }
    const lo = (text||'').toLowerCase().trim();

    // ── В ПОЕЗДКЕ ─────────────────────────────────────────────
    if (driver.status === 'busy') {
      const order = await q.getActiveOrderByDriver(phone);
      if (order) {
        if (match(lo, KW.ARRIVED)) { await orderEngine.arrived(order.id,phone); return; }
        if (match(lo, KW.DONE))    { await orderEngine.complete(order.id,phone); return; }
        if (match(lo, KW.FALSE))   { await orderEngine.falseCall(order.id,phone); return; }
        // Непонятный текст в поездке → подсказка
        await wa.sendText(phone,'🚗 Вы в поездке.\n\n• *Прибыл* — приехали к клиенту\n• *Свободен* — довезли клиента\n• *Ложный* — клиента нет на месте');
        return;
      }
    }

    // ── ОСНОВНЫЕ КОМАНДЫ ──────────────────────────────────────
    if (match(lo, KW.ACCEPT)) {
      const pending = await q.getPendingOrderForDriver(phone);
      if (pending) await orderEngine.accept(pending.id,phone);
      else await wa.sendText(phone,'⚠️ Нет активного предложения.');
      return;
    }
    if (match(lo, KW.SKIP))   { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone,'⏭ Пропущено.'); return; }
    if (match(lo, KW.ONLINE)) {
      await q.clearSession(phone);
      const r = await driverMgr.goOnline(phone);
      if (r.error==='no_balance') { await wa.sendText(phone,'🔴 Баланс = 0. Обратитесь к администратору.'); return; }
      if (r.error==='in_trip')    { await wa.sendText(phone,'⚠️ Вы сейчас в поездке.'); return; }
      const pos = await q.getDriverQueuePosition(phone);
      const cnt = (await q.getOnlineDriversQueue()).length;
      await wa.sendButtons(phone,`🟢 Вы *на линии!*\nВы *${pos}-й* из *${cnt}* водителей.`,[{id:'go_offline',text:'⚫ Уйти с линии'}]);
      return;
    }
    if (match(lo, KW.OFFLINE)) {
      await driverMgr.goOffline(phone);
      await wa.sendButtons(phone,'⚫ Вы *ушли с линии*.',[{id:'go_online',text:'🟢 Выйти на линию'},{id:'order_as_client',text:'🚖 Заказать такси'}]);
      return;
    }
    if (match(lo, KW.STATS)) {
      const stats = await q.getDriverTodayStats(driver.id);
      await notify.driverStats(phone, driver, stats);
      return;
    }
    if (['очередь','моя очередь','где я','позиция','кезек','кезегім'].some(w => lo.includes(w))) {
      if (driver.status !== 'online') {
        await wa.sendText(phone, '⚫ Вы не на линии.

Напишите *«На линию»* чтобы начать.');
      } else {
        const pos = await q.getDriverQueuePosition(phone);
        const online = await q.getOnlineDriversQueue();
        await wa.sendText(phone, `🔢 *Ваша позиция в очереди:*

📍 *${pos}-й* из *${online.length}* водителей онлайн

Ждите — заказы распределяются по очереди 🚖`);
      }
      return;
    }

    if (match(lo, KW.EDIT)) {
      await wa.sendText(phone,'✏️ *Что хотите изменить?*\n\n• *имя* — изменить ФИО\n• *авто* — изменить марку и номер\n• *фото* — новое фото авто\n• *цвет* — изменить цвет авто');
      return;
    }
    if (['имя','фио','имя изменить'].includes(lo))       { await q.setSession(phone,'edit_name',{}); await wa.sendText(phone,'Введите новое *ФИО*:'); return; }
    if (['авто','машина','номер','машину'].includes(lo))  { await q.setSession(phone,'edit_car',{}); await wa.sendText(phone,'Введите *марку и номер* через запятую:'); return; }
    if (['фото','фотография','фото авто'].includes(lo))   { await q.setSession(phone,'edit_photo',{}); await wa.sendText(phone,'Отправьте новое *фото автомобиля*:'); return; }
    if (['цвет','цвет авто'].includes(lo))                { await q.setSession(phone,'edit_color',{}); await wa.sendText(phone,'Введите новый *цвет автомобиля*:'); return; }

    // Пустой текст → статистика
    if (!lo) {
      const stats = await q.getDriverTodayStats(driver.id);
      await notify.driverStats(phone, driver, stats);
      return;
    }

    // ── GROQ УМНЫЙ ОТВЕТ ──────────────────────────────────────
    const stats = await q.getDriverTodayStats(driver.id);
    const queuePos = await q.getDriverQueuePosition(driver.phone || phone).catch(()=>null);
    const onlineList = await q.getOnlineDriversQueue().catch(()=>[]);
    const groqReply = await getGroqDriverReply(text, driver.full_name, stats, {
      status: driver.status,
      queuePos: queuePos,
      queueTotal: onlineList.length
    });
    if (groqReply) {
      await wa.sendText(phone, groqReply);
    } else {
      await wa.sendButtons(phone,
        `❓ Команды:\n• *На линию* / *С линии*\n• *Статистика*\n• *Изменить данные*`,
        [driver.status==='online' ? {id:'go_offline',text:'⚫ Уйти с линии'} : {id:'go_online',text:'🟢 Выйти на линию'}]
      );
    }

  } catch (err) {
    console.error('[driverHandler]', err.message);
    await wa.sendText(phone, '❌ Произошла ошибка.').catch(()=>{});
  }
};

const handleAsClient = async (phone, msg, session) => {
  const { text, type, buttonId } = msg;
  const ctx = session?.ctx || {};
  if (type === 'button') {
    if (buttonId === 'confirm_order') { if (!ctx.destination) return; await orderEngine.create(phone, ctx.destination, { price: ctx.price, tariff: ctx.tariff_id ? { id: ctx.tariff_id } : null }); return; }
    if (buttonId === 'cancel_new')    { await q.clearSession(phone); await wa.sendText(phone,'❌ Отменено.'); return; }
    if (buttonId === 'order_as_client') { await q.setSession(phone,'driver_as_client',{}); await wa.sendText(phone,'🚖 Куда нужно ехать?'); return; }
    if (buttonId === 'cancel_order')  { const order = await q.getActiveOrderByClient(phone); if (order) await orderEngine.cancel(order.id,'Отменён'); else { await q.clearSession(phone); await wa.sendText(phone,'❌ Нет заказа.'); } return; }
    return;
  }
  if (!text || text.length < 2) return;
  const lo = text.toLowerCase().trim();
  if (match(lo, KW.ONLINE)) {
    await q.clearSession(phone);
    const r = await driverMgr.goOnline(phone);
    if (r.error==='no_balance') { await wa.sendText(phone,'🔴 Баланс = 0.'); return; }
    const pos = await q.getDriverQueuePosition(phone);
    const cnt = (await q.getOnlineDriversQueue()).length;
    await wa.sendButtons(phone,`🟢 Вы *на линии!*\n*${pos}-й* из *${cnt}* водителей.`,[{id:'go_offline',text:'⚫ Уйти с линии'}]);
    return;
  }
  if (ctx.confirming) {
    if (['да','ок','ok','yes','поехали','иә'].includes(lo)) { await orderEngine.create(phone,ctx.destination,{price:ctx.price,tariff:ctx.tariff_id?{id:ctx.tariff_id}:null}); return; }
    if (['нет','отмена','cancel','жоқ'].includes(lo))       { await q.clearSession(phone); await wa.sendText(phone,'❌ Отменено.'); return; }
  }
  const active = await q.getActiveOrderByClient(phone);
  if (active) { await wa.sendText(phone,'⚠️ У вас уже есть активный заказ!'); return; }
  const pi = await tariff.getPrice(text);
  const nightNote = pi.isNight ? ' 🌙 *ночной тариф*' : '';
  await wa.sendButtons(phone,`🚖 *Ваш заказ:*\n\n📍 Куда: *${text}*\n💰 Цена: *${pi.price} тг*${nightNote}\n\nПодтвердить?`,[{id:'confirm_order',text:'✅ Да, поехали!'},{id:'cancel_new',text:'❌ Отмена'}]);
  await q.setSession(phone,'driver_as_client',{confirming:true,destination:text,price:pi.price,tariff_id:pi.tariff?.id||null});
};

const handleButton = async (phone, buttonId) => {
  if (buttonId==='order_as_client') { await q.setSession(phone,'driver_as_client',{}); await wa.sendText(phone,'🚖 Куда нужно ехать?'); return; }
  if (buttonId==='go_online')  { await q.clearSession(phone); const r=await driverMgr.goOnline(phone); if(r.error==='no_balance'){await wa.sendText(phone,'🔴 Баланс = 0.');return;} const pos=await q.getDriverQueuePosition(phone); const cnt=(await q.getOnlineDriversQueue()).length; await wa.sendButtons(phone,`🟢 На линии! *${pos}-й* из *${cnt}*`,[{id:'go_offline',text:'⚫ Уйти с линии'}]); return; }
  if (buttonId==='go_offline') { await driverMgr.goOffline(phone); await wa.sendButtons(phone,'⚫ Ушли с линии.',[{id:'go_online',text:'🟢 Выйти на линию'},{id:'order_as_client',text:'🚖 Заказать такси'}]); return; }
  if (buttonId.startsWith('accept_')) { const r=await orderEngine.accept(parseInt(buttonId.replace('accept_','')),phone); if(r?.error==='already_taken') await wa.sendText(phone,'⚡ Уже принят другим водителем.'); else if(r?.error) await wa.sendText(phone,'⚠️ Заказ недоступен.'); return; }
  if (buttonId.startsWith('skip_'))    { await q.moveDriverToEndOfQueue(phone); await wa.sendText(phone,'⏭ Пропущено.'); return; }
  if (buttonId.startsWith('arrived_')) { await orderEngine.arrived(parseInt(buttonId.replace('arrived_','')),phone); return; }
  if (buttonId.startsWith('false_'))   { await orderEngine.falseCall(parseInt(buttonId.replace('false_','')),phone); return; }
  if (buttonId.startsWith('done_'))    { await orderEngine.complete(parseInt(buttonId.replace('done_','')),phone); return; }
  if (buttonId.startsWith('chat_'))    { await q.setSession(phone,'driver_chat',{order_id:parseInt(buttonId.replace('chat_',''))}); await wa.sendText(phone,'💬 Чат с клиентом. Выход: *стоп*'); return; }
  if (buttonId==='edit_name')  { await q.setSession(phone,'edit_name',{}); await wa.sendText(phone,'Введите новое *ФИО*:'); return; }
  if (buttonId==='edit_car')   { await q.setSession(phone,'edit_car',{}); await wa.sendText(phone,'Введите *марку и номер*:'); return; }
  if (buttonId==='edit_photo') { await q.setSession(phone,'edit_photo',{}); await wa.sendText(phone,'Отправьте *фото автомобиля*:'); return; }
};

const handleEdit = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg;
  if (state==='edit_name')  { if(!text||text.length<2){await wa.sendText(phone,'❌ Введите ФИО:');return;} await q.updateDriver(phone,{full_name:text.trim().slice(0,100)}); await q.clearSession(phone); await wa.sendText(phone,'✅ Имя обновлено: *'+text.trim()+'*'); return; }
  if (state==='edit_car')   { const parts=(text||'').split(',').map(s=>s.trim()); if(parts.length<2||!parts[0]||!parts[1]){await wa.sendText(phone,'❌ Формат: Марка, Номер');return;} await q.updateDriver(phone,{car_make:parts[0].slice(0,50),car_plate:parts[1].toUpperCase().slice(0,20)}); await q.clearSession(phone); await wa.sendText(phone,'✅ Авто обновлено!'); return; }
  if (state==='edit_photo') { if(type!=='image'||!mediaUrl){await wa.sendText(phone,'📸 Отправьте фото:');return;} await q.updateDriver(phone,{car_photo_url:mediaUrl}); await q.clearSession(phone); await wa.sendText(phone,'✅ Фото обновлено!'); return; }
  if (state==='edit_color') { if(!text||text.length<2){await wa.sendText(phone,'❌ Введите цвет:');return;} await q.updateDriver(phone,{car_color:text.trim().slice(0,50)}); await q.clearSession(phone); await wa.sendText(phone,'✅ Цвет обновлён: *'+text.trim()+'*'); return; }
};

const handleCancelReason = async (phone, text, ctx) => {
  const order = await q.getActiveOrderByDriver(phone);
  if (!order) { await q.clearSession(phone); return; }
  await orderEngine.cancel(order.id, text?.slice(0,200)||'Водитель отменил');
};

const handleRegistration = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg;
  switch(state) {
    case 'reg_name':  if(!text||text.length<2){await wa.sendText(phone,'❌ Введите ФИО:');return;} await q.updateDriver(phone,{full_name:text.trim().slice(0,100)}); await q.setSession(phone,'reg_photo',{}); await wa.sendText(phone,'✅ Имя: *'+text.trim()+'*\n\n📸 Шаг 2/5: Отправьте *фото автомобиля*:'); break;
    case 'reg_photo': if(type!=='image'||!mediaUrl){await wa.sendText(phone,'📸 Отправьте фото:');return;} await q.updateDriver(phone,{car_photo_url:mediaUrl}); await q.setSession(phone,'reg_make',{}); await wa.sendText(phone,'✅ Фото сохранено!\n\n🚗 Шаг 3/5: *Марка и модель* авто:'); break;
    case 'reg_make':  if(!text||text.length<2){await wa.sendText(phone,'❌ Введите марку:');return;} await q.updateDriver(phone,{car_make:text.trim().slice(0,50)}); await q.setSession(phone,'reg_plate',{}); await wa.sendText(phone,'✅ Марка: *'+text.trim()+'*\n\n🔢 Шаг 4/5: *Гос. номер*:'); break;
    case 'reg_plate': if(!text||text.length<2){await wa.sendText(phone,'❌ Введите номер:');return;} await q.updateDriver(phone,{car_plate:text.trim().toUpperCase().slice(0,20)}); await q.setSession(phone,'reg_color',{}); await wa.sendText(phone,'✅ Номер: *'+text.trim().toUpperCase()+'*\n\n🎨 Шаг 5/5: *Цвет* авто:'); break;
    case 'reg_color': if(!text||text.length<2){await wa.sendText(phone,'❌ Введите цвет:');return;} await q.updateDriver(phone,{car_color:text.trim().slice(0,50)}); await q.clearSession(phone); const d=await q.getDriver(phone); await wa.sendText(phone,'🎉 *Регистрация завершена!*\n\n👤 '+d.full_name+'\n🚗 '+d.car_make+', '+d.car_color+'\n🔢 '+d.car_plate+'\n\nНапишите *«На линию»* чтобы начать! 🚀'); break;
  }
};

module.exports = { handle };
