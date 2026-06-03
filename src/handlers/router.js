const q = require('../db/queries');
const wa = require('../whatsapp/greenApi');
const clientHandler = require('./clientHandler');
const driverHandler = require('./driverHandler');
const adminHandler = require('./adminHandler');
const config = require('../config');
const { newClientGreeting } = require('../modules/greetingService');
const log = require('../logger');

// 'на линии' убрано — встречается в вопросах («сколько машин на линии»)
const GO_ONLINE = ['на линию','выхожу','начинаю','работаю','онлайн','старт','начать','жұмыс','жұмысқа','линияға шығам','шығамын'];

const DRIVER_CMDS = [
  'статистика','стат','итоги','заработок','қанша',
  'очередь','позиция','кезек',
  'принял','принять','беру','аламын','принимаю',
  'прибыл','приехал','на месте','подъехал','стою',
  'свободен','завершил','бостымын','доехали',
  'ложный','нет клиента','жалған','пропустить','пропуск','откізу',
  'faq','фак','перерыв',
];

const DRIVER_ONLY_STATES = ['driver_as_client', 'driver_chat', 'cancel_reason'];

const DRIVER_BUTTON_PREFIXES = [
  'go_online','go_offline','accept_','skip_','arrived_',
  'done_','false_','chat_','cancel_driver_','driver_cancel_',
];

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
      type = 'text';
      break;
    case 'buttonsResponseMessage':
      buttonId = String(messageData.buttonsResponseMessage?.selectedButtonId || '');
      text = String(messageData.buttonsResponseMessage?.selectedButtonDisplayText || '');
      type = 'button';
      break;
    case 'listResponseMessage':
      buttonId = String(messageData.listResponseMessage?.listResponseRowId || '');
      text = String(messageData.listResponseMessage?.title || '');
      type = 'button';
      break;
    case 'audioMessage':
    case 'pttMessage':
      mediaUrl = messageData.fileMessageData?.downloadUrl || null;
      type = 'voice';
      break;
    case 'imageMessage':
      mediaUrl = messageData.fileMessageData?.downloadUrl;
      text = String(messageData.fileMessageData?.caption || '');
      type = 'image';
      break;
    default:
      text = String(messageData.textMessageData?.textMessage || '');
      type = 'other';
  }
  return { phone, name, type, text: text.trim().slice(0, 500), buttonId, mediaUrl, messageId: body.idMessage || null };
};

// Определяет нужно ли направить сообщение от водителя в driverHandler.
// Возвращает true если надо, false если надо передать в clientHandler.
const shouldRouteAsDriver = (msg, session, driverStatus, lo) => {
  if (driverStatus === 'online' || driverStatus === 'busy') return true;

  // Голос — всегда в driverHandler (офлайн-водитель говорит «на линию» голосом)
  if (msg.type === 'voice') return true;

  // Водительские состояния FSM
  if (session?.state?.startsWith('reg_')) return true;
  if (session?.state?.startsWith('edit_')) return true;
  if (DRIVER_ONLY_STATES.includes(session?.state)) return true;

  // Кнопки водителя при offline
  if (msg.type === 'button' && msg.buttonId &&
      DRIVER_BUTTON_PREFIXES.some(p => msg.buttonId.startsWith(p))) return true;

  // Ключевые слова выхода на линию
  if (GO_ONLINE.some(w => lo.includes(w))) return true;

  // Команды водителя
  if (DRIVER_CMDS.some(w => lo.includes(w))) return true;

  return false;
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
    log.msg(phone, role, session?.state || 'idle', msg.type, msg.text);
    const lo = (text||'').toLowerCase().trim();

    // ─── АДМИН ПАНЕЛЬ ─────────────────────────────────────────
    if (session?.state === 'admin_mode' ||
        (session?.state?.startsWith('admin_') && session?.state !== 'admin_exit')) {
      return adminHandler.handle(phone, msg, session);
    }

    // ─── ВЫХОД ИЗ АДМИНКИ ─────────────────────────────────────
    if (session?.state === 'admin_exit') {
      await q.clearSession(phone);
      const driver = await q.getDriver(phone);
      if (driver && GO_ONLINE.some(w => lo.includes(w))) {
        return driverHandler.handle(phone, msg, { state: 'idle', ctx: {} });
      }
      return clientHandler.handle(phone, name, msg, { state: 'idle', ctx: {} });
    }

    // ─── КОД ВОДИТЕЛЯ ─────────────────────────────────────────
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
      await wa.sendText(phone,
        'Код принят! Добро пожаловать!\n\nРегистрация водителя (5 шагов)\n\nШаг 1/5: Введите ваше полное имя (ФИО):'
      );
      return;
    }

    // ─── НОВЫЙ ПОЛЬЗОВАТЕЛЬ ───────────────────────────────────
    if (role === 'new' || !user) {
      await q.createUser(phone, name, 'client');
      await q.setSession(phone, 'idle', {});
      await wa.sendText(phone,
        '🚖 Добро пожаловать в *еОсакаровка Сервис*!\n\n' +
        'Такси по посёлку от *500 тг*, работаем *24/7*.\n\n' +
        '📍 Просто напишите *куда нужно ехать* — найдём водителя!\n\n' +
        '🎁 Каждая *10-я поездка* — бесплатно!'
      );
      return;
    }

    // ─── ВОДИТЕЛЬ или АДМИН-ВОДИТЕЛЬ ──────────────────────────
    if (role === 'driver' || role === 'admin') {
      await q.updateDriverActivity(phone).catch(() => {});
      const driver = await q.getDriver(phone);
      const driverStatus = driver?.status || 'offline';
      const inReg = session?.state?.startsWith('reg_');

      // Заблокированный водитель — блокируем всегда
      if (driver?.status === 'blocked') {
        await wa.sendText(phone, '🚫 Ваш аккаунт заблокирован. Обратитесь к администратору.');
        return;
      }

      // Неполная регистрация — перенаправляем если не в процессе reg_
      if (!inReg && !(await q.isFullyRegisteredDriver(phone))) {
        await wa.sendText(phone, '⚠️ Завершите регистрацию водителя.\nОтправьте код водителя снова или обратитесь к администратору.');
        return;
      }

      if (driver && shouldRouteAsDriver(msg, session, driverStatus, lo)) {
        return driverHandler.handle(phone, msg, session);
      }
      return clientHandler.handle(phone, name, msg, session);
    }

    // ─── ОБЫЧНЫЙ КЛИЕНТ ───────────────────────────────────────
    return clientHandler.handle(phone, name, msg, session);

  } catch (err) {
    log.error('router', err);
  }
};

module.exports = { route };
