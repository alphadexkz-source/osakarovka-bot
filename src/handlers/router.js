const q = require('../db/queries');
const wa = require('../whatsapp/greenApi');
const clientHandler = require('./clientHandler');
const driverHandler = require('./driverHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const { newClientGreeting } = require('../modules/greetingService');

// 'на линии' убрано — встречается в вопросах («сколько машин на линии»)
// 'лайн' убрано — слишком короткое, срабатывает на чужих словах
const GO_ONLINE = ['на линию','выхожу','начинаю','работаю','онлайн','старт','начать','жұмыс','жұмысқа','линияға шығам','шығамын'];

const parse = (body) => {
  console.log('[WEBHOOK TYPE]', body.typeWebhook, body.senderData?.sender);
  if (body.typeWebhook !== 'incomingMessageReceived') return null;
  const { senderData, messageData } = body;
  if (!senderData?.sender || !messageData) return null;
  const phone = senderData.sender.replace('@c.us', '');
  if (senderData.sender.includes('@g.us')) return null;
  const name = String(senderData.senderName || 'Пользователь').slice(0, 100);
  let type = 'text', text = '', buttonId = null, mediaUrl = null;
  switch (messageData.typeMessage) {
    case 'textMessage': text = String(messageData.textMessageData?.textMessage || ''); type = 'text'; break;
    case 'buttonsResponseMessage': buttonId = String(messageData.buttonsResponseMessage?.selectedButtonId || ''); text = String(messageData.buttonsResponseMessage?.selectedButtonDisplayText || ''); type = 'button'; break;
    case 'listResponseMessage': buttonId = String(messageData.listResponseMessage?.listResponseRowId || ''); text = String(messageData.listResponseMessage?.title || ''); type = 'button'; break;
    case 'audioMessage': case 'pttMessage': mediaUrl = messageData.fileMessageData?.downloadUrl || null; type = 'voice'; break;
    case 'imageMessage': mediaUrl = messageData.fileMessageData?.downloadUrl; text = String(messageData.fileMessageData?.caption || ''); type = 'image'; break;
    default: text = String(messageData.textMessageData?.textMessage || ''); type = 'other';
  }
  return { phone, name, type, text: text.trim().slice(0, 500), buttonId, mediaUrl, messageId: body.idMessage || null };
};

const route = async (body) => {
  try {
    const msg = parse(body);
    if (!msg) return;
    const { phone, name, text } = msg;
    if (!/^\d{10,15}$/.test(phone)) return;

    const user = await q.getUser(phone);
    if (user?.is_blacklisted) return;

    if (text.startsWith('/admin')) return adminHandler.login(phone, text);

    const session = await q.getSession(phone);
    const role = user?.role || 'new';
    console.log(`[MSG] ${phone} role=${role} state=${session?.state||'idle'} type=${msg.type} text="${(msg.text||'').slice(0,40)}"`);
    const lo = (text||'').toLowerCase().trim();

    // АДМИН ПАНЕЛЬ
    if (session?.state === 'admin_mode' || (session?.state?.startsWith('admin_') && session?.state !== 'admin_exit')) {
      return adminHandler.handle(phone, msg, session);
    }

    // ВЫХОД ИЗ АДМИНКИ
    if (session?.state === 'admin_exit') {
      await q.clearSession(phone);
      if (GO_ONLINE.some(w => lo.includes(w))) {
        const driver = await q.getDriver(phone);
        if (driver) return driverHandler.handle(phone, msg, { state: 'idle', ctx: {} });
      }
      return clientHandler.handle(phone, name, msg, { state: 'idle', ctx: {} });
    }

    // КОД ВОДИТЕЛЯ
    const isDriverCode = text.toUpperCase().trim() === config.DRIVER_CODE.toUpperCase();
    if (isDriverCode && role !== 'driver') {
      if (role === 'new' || !user) {
        const newUser = await q.createUser(phone, name, 'driver');
        await q.createDriver(newUser.id);
      } else {
        await q.updateUser(phone, { role: 'driver' });
        const updated = await q.getUser(phone);
        await q.createDriver(updated.id).catch(() => {});
      }
      await q.setSession(phone, 'reg_name', {});
      await wa.sendText(phone, 'Код принят! Добро пожаловать!\n\nРегистрация водителя (5 шагов)\n\nШаг 1/5: Введите ваше полное имя (ФИО):');
      return;
    }

    // НОВЫЙ ПОЛЬЗОВАТЕЛЬ
    if (role === 'new' || !user) {
      await q.createUser(phone, name, 'client');
      await q.setSession(phone, 'idle', {});
      const greeting = await newClientGreeting(name, text).catch(() => null);
      await wa.sendText(phone, greeting ||
        'Добро пожаловать в еОсакаровка Сервис!\n\nНапишите куда нужно ехать — найдём водителя.\nКаждая 10-я поездка бесплатная!'
      );
      const freshSession = await q.getSession(phone);
      return clientHandler.handle(phone, name, msg, freshSession || { state: 'idle', ctx: {} });
    }

    // ВОДИТЕЛЬ
    if (role === 'driver') {
      await q.updateDriverActivity(phone).catch(() => {});
      const driver = await q.getDriver(phone);
      const status = driver?.status || 'offline';
      if (status === 'online' || status === 'busy') return driverHandler.handle(phone, msg, session);
      // FIX: голосовые всегда идут в driverHandler (offline-водитель говорит «на линию» голосом)
      if (msg.type === 'voice') return driverHandler.handle(phone, msg, session);
      // FIX: driver_as_client и cancel_reason — состояния водителя, не клиента
      const driverOnlyStates = ['driver_as_client', 'driver_chat', 'cancel_reason'];
      if (session?.state?.startsWith('reg_') ||
          session?.state?.startsWith('edit_') ||
          driverOnlyStates.includes(session?.state)) return driverHandler.handle(phone, msg, session);
      // FIX: кнопки водителя при offline — в driverHandler
      const driverButtonPfx = ['go_online','go_offline','accept_','skip_','arrived_','done_','false_','chat_','cancel_driver_','driver_cancel_'];
      if (msg.type === 'button' && msg.buttonId && driverButtonPfx.some(p => msg.buttonId.startsWith(p)))
        return driverHandler.handle(phone, msg, session);
      if (GO_ONLINE.some(w => lo.includes(w))) return driverHandler.handle(phone, msg, session);
      return clientHandler.handle(phone, name, msg, session);
    }

    // АДМИН
    if (role === 'admin') {
      await q.updateDriverActivity(phone).catch(() => {});
      const driver = await q.getDriver(phone);
      const status = driver?.status || 'offline';
      if (status === 'online' || status === 'busy') return driverHandler.handle(phone, msg, session);
      // FIX: голос от офлайн-админа-водителя → driverHandler
      if (msg.type === 'voice' && driver) return driverHandler.handle(phone, msg, session);
      // FIX: если админ-водитель в режиме driver_as_client — в driverHandler
      if (['driver_as_client', 'driver_chat', 'cancel_reason'].includes(session?.state) && driver)
        return driverHandler.handle(phone, msg, session);
      if (GO_ONLINE.some(w => lo.includes(w)) && driver) return driverHandler.handle(phone, msg, session);
      return clientHandler.handle(phone, name, msg, session);
    }

    return clientHandler.handle(phone, name, msg, session);

  } catch (err) {
    console.error('[Router]', err.message);
  }
};

module.exports = { route };
