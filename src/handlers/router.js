const q = require('../db/queries');
const wa = require('../whatsapp/greenApi');
const clientHandler = require('./clientHandler');
const driverHandler = require('./driverHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const { newClientGreeting } = require('../modules/greetingService');

const GO_ONLINE = ['на линию','на линии','выхожу','начинаю','работаю','онлайн','старт','начать','лайн','жұмыс','жұмысқа','линияға шығам','шығамын'];

const parse = (body) => {
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
    case 'audioMessage': case 'pttMessage': mediaUrl = messageData.fileMessageData?.downloadUrl; type = 'voice'; break;
    case 'imageMessage': mediaUrl = messageData.fileMessageData?.downloadUrl; text = String(messageData.fileMessageData?.caption || ''); type = 'image'; break;
    default: text = String(messageData.textMessageData?.textMessage || ''); type = 'other';
  }
  return { phone, name, type, text: text.trim().slice(0, 500), buttonId, mediaUrl };
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

    // НОВЫЙ ПОЛЬЗОВАТЕЛЬ — только одно приветствие
    if (role === 'new' || !user) {
      await q.createUser(phone, name, 'client');
      await q.setSession(phone, 'idle', {});
      // Умное приветствие через Groq — ТОЛЬКО ОДНО сообщение
      const greeting = await newClientGreeting(name, text).catch(() => null);
      await wa.sendText(phone, greeting ||
        'Добро пожаловать в еОсакаровка Сервис!\n\nНапишите куда нужно ехать — найдём водителя.\nКаждая 10-я поездка бесплатная!'
      );
      // Если написал адрес сразу — обрабатываем
      const freshSession = await q.getSession(phone);
      return clientHandler.handle(phone, name, msg, freshSession || { state: 'idle', ctx: {} });
    }

    // ВОДИТЕЛЬ
    if (role === 'driver') {
      await q.updateDriverActivity(phone).catch(() => {});
      const driver = await q.getDriver(phone);
      const status = driver?.status || 'offline';
      // Онлайн/занят → водитель
      if (status === 'online' || status === 'busy') return driverHandler.handle(phone, msg, session);
      // В процессе регистрации → водитель
      if (session?.state?.startsWith('reg_') || session?.state?.startsWith('edit_') || session?.state === 'driver_chat') return driverHandler.handle(phone, msg, session);
      // Говорит "на линию" → водитель
      if (GO_ONLINE.some(w => lo.includes(w))) return driverHandler.handle(phone, msg, session);
      // Офлайн → клиент
      return clientHandler.handle(phone, name, msg, session);
    }

    // АДМИН
    if (role === 'admin') {
      await q.updateDriverActivity(phone).catch(() => {});
      const driver = await q.getDriver(phone);
      const status = driver?.status || 'offline';
      if (status === 'online' || status === 'busy') return driverHandler.handle(phone, msg, session);
      if (GO_ONLINE.some(w => lo.includes(w)) && driver) return driverHandler.handle(phone, msg, session);
      return clientHandler.handle(phone, name, msg, session);
    }

    // КЛИЕНТ
    return clientHandler.handle(phone, name, msg, session);

  } catch (err) {
    console.error('[Router]', err.message);
  }
};

module.exports = { route };
