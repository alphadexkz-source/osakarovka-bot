const q = require('../db/queries');
const wa = require('../whatsapp/greenApi');
const clientHandler = require('./clientHandler');
const driverHandler = require('./driverHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const { newClientGreeting } = require('../modules/greetingService');

const GO_ONLINE_WORDS  = ['на линию','на линии','выхожу','начинаю','работаю','онлайн','старт','начать','лайн','жұмыс','жұмысқа','линияға шығам','шығамын'];
const GO_OFFLINE_WORDS = ['с линии','ухожу','офлайн','оффлайн','стоп','отдых','линиядан','аяқтадым','заканчиваю'];

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
    case 'textMessage':
      text = String(messageData.textMessageData?.textMessage || '');
      type = 'text'; break;
    case 'buttonsResponseMessage':
      buttonId = String(messageData.buttonsResponseMessage?.selectedButtonId || '');
      text = String(messageData.buttonsResponseMessage?.selectedButtonDisplayText || '');
      type = 'button'; break;
    case 'listResponseMessage':
      buttonId = String(messageData.listResponseMessage?.listResponseRowId || '');
      text = String(messageData.listResponseMessage?.title || '');
      type = 'button'; break;
    case 'audioMessage':
    case 'pttMessage':
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      type = 'voice'; break;
    case 'imageMessage':
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      text = String(messageData.fileMessageData?.caption || '');
      type = 'image'; break;
    default:
      text = String(messageData.textMessageData?.textMessage || '');
      type = 'other';
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
      if (GO_ONLINE_WORDS.some(w => lo.includes(w))) {
        return driverHandler.handle(phone, msg, { state: 'idle', ctx: {} });
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
      await wa.sendText(phone, `✅ Код принят!\n\n📝 Регистрация водителя (5 шагов)\n\nШаг 1/5: Введите ваше *полное имя* (ФИО):`);
      return;
    }

    if (role === 'new' || !user) return handleNew(phone, name, msg);

    // ВОДИТЕЛЬ
    if (role === 'driver') {
      const driver = await q.getDriver(phone);
      const status = driver?.status || 'offline';

      // Онлайн или занят → ВСЕГДА водитель
      if (status === 'online' || status === 'busy') {
        if (user?.role === 'driver' || user?.role === 'admin') {
          await q.updateDriverActivity(phone).catch(() => {});
        }
        return driverHandler.handle(phone, msg, session);
      }

      // Регистрация/редактирование → водитель
      if (session?.state?.startsWith('reg_') || session?.state?.startsWith('edit_') || session?.state === 'driver_chat') {
        return driverHandler.handle(phone, msg, session);
      }

      // Пишет "на линию" → водитель
      if (GO_ONLINE_WORDS.some(w => lo.includes(w))) {
        return driverHandler.handle(phone, msg, session);
      }

      // Офлайн → клиент
      return clientHandler.handle(phone, name, msg, session);
    }

    // АДМИН
    if (role === 'admin') {
      // Проверяем есть ли запись водителя и его статус
      const driver = await q.getDriver(phone);
      const driverStatus = driver?.status || 'offline';

      // Если онлайн → водительский режим
      if (driverStatus === 'online' || driverStatus === 'busy') {
        await q.updateDriverActivity(phone).catch(() => {});
        return driverHandler.handle(phone, msg, session);
      }

      // Пишет "на линию" → водитель
      if (GO_ONLINE_WORDS.some(w => lo.includes(w)) && driver) {
        return driverHandler.handle(phone, msg, session);
      }

      // Иначе → клиент
      return clientHandler.handle(phone, name, msg, session);
    }

    return clientHandler.handle(phone, name, msg, session);

  } catch (err) {
    console.error('[Router]', err.message);
  }
};

const handleNew = async (phone, name, msg) => {
  try {
    await q.createUser(phone, name, 'client');
    await q.setSession(phone, 'idle', {});
    const greeting = await newClientGreeting(name, msg.text || '').catch(() => null);
    await wa.sendText(phone, greeting ||
      `👋 Сәлем, *${name}*!\nБұл *еОсакаровка Сервис* 😊\n\n🚖 Напишите куда ехать — найдём водителя!\nМекенжайды жазыңыз — жүргізуші табамыз!`
    );
    // Новому клиенту уже отправили приветствие — не вызываем handle снова
    // чтобы не было двойного ответа
  } catch (err) {
    console.error('[handleNew]', err.message);
  }
};

module.exports = { route };

