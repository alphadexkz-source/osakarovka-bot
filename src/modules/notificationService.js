const wa = require('../whatsapp/greenApi');
const q = require('../db/queries');
const { smartFarewell, detectLanguage } = require('./greetingService');

const clientSearching = async (phone, destination, price, isFree, freeReason) => {
  let p;
  if (!isFree) p = `💰 Цена: *${price} тг*`;
  else if (freeReason==='bonus') p = '🎁 *БЕСПЛАТНО* (реферальный бонус!)';
  else p = '🎁 *БЕСПЛАТНО* (ваша 10-я поездка!)';
  await wa.sendText(phone, `✅ Заказ принят!\n\n📍 Куда: *${destination}*\n${p}\n\n🔍 Ищем водителя...`);
};

const clientDriverFound = async (phone, driver) => {
  const msg = `🚗 *Водитель найден!*\n\n👤 ${driver.full_name}\n🚙 ${driver.car_make}, ${driver.car_color}\n🔢 Номер: *${driver.car_plate}*\n⏱ Прибудет через *3–7 минут*`;
  if (driver.car_photo_url) await wa.sendImage(phone, driver.car_photo_url, msg);
  else await wa.sendText(phone, msg);
  await wa.sendButtons(phone, '⬇️ Ваши действия:', [
    { id: 'chat_driver', text: '💬 Написать водителю' },
    { id: 'cancel_order', text: '❌ Отменить заказ' },
  ]);
};

const clientArrived  = async (phone) => wa.sendText(phone, `📍 *Водитель прибыл и ждёт вас!*\n\nПожалуйста, выходите. 🙌`);
const clientInTrip   = async (phone, destination) => {};

const clientCompleted = async (phone, price, isFree, destination) => {
  const db = require('../db/index');
  const user = await db.query('SELECT trip_count, bonus_trips, name, language FROM users WHERE phone=$1', [phone])
    .then(r => r.rows[0]).catch(() => null);
  const tripCount = user?.trip_count || 0;
  const freeUsed  = Math.floor(tripCount / 10);
  const nextFree  = 10 - (tripCount % 10);
  const freeLine  = isFree ? '\n🎉 *Эта поездка была бесплатной!*' : '';
  const bonusLine = (user?.bonus_trips > 0) ? `\n🎁 Бесплатных в запасе: *${user.bonus_trips}*` : '';

  // Умное прощание через Groq
  try {
    const lang = user?.language || detectLanguage('');
    const farewell = await smartFarewell(user?.name || 'Клиент', lang, tripCount, isFree);
    if (farewell) {
      await wa.sendText(phone, farewell + `\n\n📊 Поездок: *${tripCount}* | ⭐ До бесплатной: *${nextFree}*${bonusLine}`);
      return;
    }
  } catch(e) { console.error('[clientCompleted:farewell]', e.message); }

  // Фолбэк — стандартное сообщение
  await wa.sendText(phone,
    `🙏 Спасибо за поездку!${freeLine}\n\n` +
    `📊 *Ваша статистика:*\n` +
    `🚖 Поездок всего: *${tripCount}*\n` +
    `🎁 Бесплатных использовано: *${freeUsed}*${bonusLine}\n` +
    `⭐ До следующей бесплатной: *${nextFree}*\n\n` +
    `*еОсакаровка Сервис* ждёт вас снова! 😊`
  );
};

const clientNoDrivers = async (phone) => wa.sendText(phone, `😔 *Свободных водителей нет.*\nПопробуйте через несколько минут. 🙏`);
const clientCancelled = async (phone, reason='') => wa.sendText(phone, `❌ Заказ отменён${reason?': '+reason:''}.\n\nНапишите куда ехать. 🚖`);

const driverNewOrder = async (phone, order) =>
  wa.sendButtons(phone,
    `🚖 *НОВЫЙ ЗАКАЗ!*\n\n📍 Куда: *${order.destination}*\n💰 Цена: *${order.price} тг*\n👤 ${order.client_name||'Клиент'}\n\n⏱ *60 секунд* на решение\n\n✅ *принял* — принять заказ\n⏭ *пропустить* — передать следующему\n🚫 *ложный* — если приехали, а клиента нет (штраф клиенту *250 тг*)`,
    [{ id:`accept_${order.id}`, text:'✅ Принять' }, { id:`skip_${order.id}`, text:'⏭ Пропустить' }]
  );

const driverAccepted = async (phone, order) =>
  wa.sendButtons(phone,
    `✅ *Заказ принят!*\n\n📍 Везём: *${order.destination}*\n💰 Цена: *${order.price} тг*\n\nКогда приедете к клиенту — напишите: *прибыл*`,
    [{ id:`arrived_${order.id}`, text:'📍 Прибыл' }, { id:`false_${order.id}`, text:'🚫 Ложный вызов' }, { id:`chat_${order.id}`, text:'💬 Написать клиенту' }]
  );

const driverTripStarted = async (phone, order) =>
  wa.sendButtons(phone,
    `🛣 *Поездка началась!*\n📍 *${order.destination}*\n\nКогда довезёте клиента — напишите: *свободен*`,
    [{ id:`done_${order.id}`, text:'✅ Свободен' }, { id:`chat_${order.id}`, text:'💬 Написать клиенту' }]
  );

const driverTimeout       = async (phone) => wa.sendText(phone, `⏱ Время вышло. Заказ передан следующему.`);
const driverBalanceLow    = async (phone, bal) => { if(bal>0&&bal<=5) await wa.sendText(phone, `⚠️ Осталось *${bal} заказов*. Пополните баланс у администратора.`); };
const driverBalanceEmpty  = async (phone) => wa.sendText(phone, `🔴 *Баланс исчерпан!*\n\nВы переведены в Офлайн.\nОбратитесь к администратору.`);
const driverInactiveOffline = async (phone) => wa.sendText(phone, `😴 Офлайн — 30 мин без активности.\n\nНапишите *«На линию»* чтобы продолжить.`);
const driverLongWait      = async (phone) => wa.sendText(phone, `ℹ️ Вы уже час на линии, но заказов ещё не было.\nТихий день — так бывает. Вы в очереди, заказы придут! 🙂`);

const driverStats = async (phone, driver, stats) => {
  const icons  = {online:'🟢',busy:'🔴',offline:'⚫',blocked:'🚫'};
  const labels = {online:'На линии',busy:'В поездке',offline:'Офлайн',blocked:'Заблокирован'};
  const db = require('../db/index');
  const week = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed, COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS earned FROM orders WHERE driver_id=$1 AND created_at >= NOW() - INTERVAL '7 days'`,
    [driver.id]
  ).then(r => r.rows[0]).catch(() => ({completed:0,earned:0}));
  const month = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed, COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS earned FROM orders WHERE driver_id=$1 AND created_at >= NOW() - INTERVAL '30 days'`,
    [driver.id]
  ).then(r => r.rows[0]).catch(() => ({completed:0,earned:0}));
  const ranking = await db.query(
    `SELECT driver_id, COUNT(*) AS trips FROM orders WHERE status='completed' AND created_at >= NOW() - INTERVAL '30 days' GROUP BY driver_id ORDER BY trips DESC`,
  ).then(r => r.rows).catch(() => []);
  const myPos = ranking.findIndex(r => parseInt(r.driver_id) === parseInt(driver.id));
  const rankLine = myPos >= 0 ? `🏆 Рейтинг: *${myPos+1}-е место* из ${ranking.length} водителей` : `🏆 Рейтинг: ещё нет данных`;
  const avgDay = month.completed > 0 ? Math.round(Number(month.earned) / 30) : 0;
  const bestDay = await db.query(
    `SELECT DATE(created_at) AS day, COUNT(*) AS trips, COALESCE(SUM(price),0) AS earned FROM orders WHERE driver_id=$1 AND status='completed' AND created_at >= NOW() - INTERVAL '7 days' GROUP BY day ORDER BY trips DESC LIMIT 1`,
    [driver.id]
  ).then(r => r.rows[0]).catch(() => null);
  const bestDayLine = bestDay ? `📅 Лучший день: *${new Date(bestDay.day).toLocaleDateString('ru-RU',{weekday:'short',day:'numeric',month:'short'})}* — ${bestDay.trips} поездок, ${Number(bestDay.earned).toLocaleString()} тг` : '';
  const bal = driver.order_balance >= 999999 ? '∞ (пробный период)' : `${driver.order_balance} заказов`;
  await wa.sendText(phone,
    `📊 *Статистика — ${driver.full_name}*\n\n` +
    `*Сегодня:*\n🚖 ${stats.completed||0} поездок | 💰 ${Number(stats.earned||0).toLocaleString()} тг\n\n` +
    `*За 7 дней:*\n🚖 ${week.completed||0} поездок | 💰 ${Number(week.earned||0).toLocaleString()} тг\n${bestDayLine ? bestDayLine+'\n' : ''}` +
    `\n*За 30 дней:*\n🚖 ${month.completed||0} поездок | 💰 ${Number(month.earned||0).toLocaleString()} тг\n📈 Средний заработок: *${avgDay.toLocaleString()} тг/день*\n\n` +
    `${rankLine}\n📦 Баланс: *${bal}*\n${icons[driver.status]||'⚫'} ${labels[driver.status]||'Офлайн'}`
  );
};

const falseCallClient = async (phone, fine, total) => {
  const warn = total>=3 ? `\n\n⚠️ У вас уже *${total}* ложных вызова. При повторении — блокировка.` : '';
  await wa.sendText(phone, `🚫 *Ложный вызов*\n\nВодитель прибыл, но вас не было.\n💸 Штраф: *${fine} тг* — оплата при следующей поездке.${warn}\n\nЧтобы заказать — напишите куда ехать.`);
};
const falseCallDriver = async (phone, fine) => wa.sendText(phone, `✅ Зафиксировано.\n💸 Клиент должен штраф *${fine} тг*.\n\nВы снова в очереди.`);
const falseCallAdmin  = async (adminPhone, clientPhone, driverName, fine) => {
  if (!adminPhone) return;
  await wa.sendText(adminPhone, `⚠️ *Ложный вызов*\n👤 Клиент: ${clientPhone}\n🚗 Водитель: ${driverName}\n💸 Штраф: ${fine} тг`);
};

const broadcast = async (role, message) => {
  const list = role==='driver' ? await q.getAllDrivers() : await q.getAllClients();
  let sent = 0;
  for (const u of list) {
    await wa.sendText(u.phone, `📢 *Объявление:*\n\n${message}`);
    sent++;
    await new Promise(r=>setTimeout(r,600));
  }
  return sent;
};

module.exports = {
  clientSearching, clientDriverFound, clientArrived, clientInTrip,
  clientCompleted, clientNoDrivers, clientCancelled,
  driverNewOrder, driverAccepted, driverTripStarted,
  driverTimeout, driverBalanceLow, driverBalanceEmpty,
  driverInactiveOffline, driverLongWait, driverStats,
  falseCallClient, falseCallDriver, falseCallAdmin,
  broadcast,
};
