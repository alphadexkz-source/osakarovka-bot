const q      = require('../db/queries');
const config = require('../config');

// Выйти на линию
const goOnline = async (phone) => {
  const driver = await q.getDriver(phone);
  if (!driver)                    return { error: 'not_registered' };
  if (driver.order_balance <= 0)  return { error: 'no_balance'     };
  if (driver.status === 'busy')   return { error: 'in_trip'        };

  await q.setDriverStatus(phone, 'online');
  await q.moveDriverToEndOfQueue(phone);
  // Сбрасываем skip_next при выходе на линию
  await q.updateDriver(phone, { skip_next: false }).catch(() => {});
  return { success: true, driver };
};

// Уйти с линии
const goOffline = async (phone) => {
  await q.setDriverStatus(phone, 'offline');
  return { success: true };
};

// Следующий водитель в очереди (исключая уже предложенных)
const getNextDriver = async (excludePhones = []) => {
  const drivers = await q.getOnlineDriversQueue();

  for (const d of drivers) {
    if (excludePhones.includes(d.phone)) continue;

    // Пропустить этот заказ если skip_next = true (низкий рейтинг)
    if (d.skip_next) {
      await q.updateDriver(d.phone, { skip_next: false });
      continue;
    }
    return d;
  }
  return null;
};

// Получить всех онлайн-водителей (для режима «первый принял»)
const getAllOnline = async () => {
  return q.getOnlineDriversQueue();
};

// После завершения поездки
const afterTrip = async (phone, driverId, isFree=false) => {
  // Бесплатная поездка — баланс НЕ списывается (сервис берёт на себя)
  let newBalance;
  if (isFree) {
    const driverData = await q.getDriver(phone);
    newBalance = driverData?.order_balance ?? 1; // не трогаем баланс
  } else {
    newBalance = await q.deductDriverBalance(driverId);
  }

  if (newBalance === 0 || newBalance === undefined) {
    await q.setDriverStatus(phone, 'offline');
    return { offline: true, balance: 0 };
  }

  // Вернуть в очередь
  await q.setDriverStatus(phone, 'online');
  await q.moveDriverToEndOfQueue(phone);

  // Если рейтинг низкий — пропустить следующий заказ
  const driver = await q.getDriver(phone);
  if (driver && parseFloat(driver.rating) < config.LOW_RATING) {
    await q.updateDriver(phone, { skip_next: true });
  }

  return { offline: false, balance: newBalance };
};

// Форматировать список водителей
const formatList = (drivers) => {
  if (!drivers.length) return 'Водители не зарегистрированы.';

  const icon = { online: '🟢', busy: '🔴', offline: '⚫' };

  return drivers.map((d, i) =>
    `*${i + 1}.* ${d.full_name || 'Без имени'}\n` +
    `   ${icon[d.status] || '⚫'} ${d.status} | ⭐${Number(d.rating).toFixed(1)} | 📦${d.order_balance}\n` +
    `   📞 ${d.phone} | 🚗 ${d.car_make || '—'} ${d.car_plate || ''}`
  ).join('\n\n');
};

module.exports = { goOnline, goOffline, getNextDriver, getAllOnline, afterTrip, formatList };
