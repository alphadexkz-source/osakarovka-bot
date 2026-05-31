const db = require('../db/index');

// Получить избранные адреса клиента
const getFavorites = async (phone) => {
  const r = await db.query(
    `SELECT home_address, work_address, fav_address_1, fav_address_1_name 
     FROM users WHERE phone=$1`, [phone]
  );
  return r.rows[0] || {};
};

// Сохранить домашний адрес
const saveHome = async (phone, address) => {
  await db.query(
    `UPDATE users SET home_address=$2 WHERE phone=$1`, [phone, address]
  );
};

// Сохранить рабочий адрес
const saveWork = async (phone, address) => {
  await db.query(
    `UPDATE users SET work_address=$2 WHERE phone=$1`, [phone, address]
  );
};

// Сохранить избранный адрес
const saveFav = async (phone, address, name) => {
  await db.query(
    `UPDATE users SET fav_address_1=$2, fav_address_1_name=$3 WHERE phone=$1`,
    [phone, address, name]
  );
};

// Определить является ли текст командой избранного адреса
// Возвращает адрес или null
const resolveShortcut = async (phone, text) => {
  const lo = (text || '').toLowerCase().trim();
  const favs = await getFavorites(phone);

  // Домой
  if (['домой','дома','үйге','үй','домашний','домашний адрес'].includes(lo)) {
    return favs.home_address ? { address: favs.home_address, label: '🏠 Домой' } : null;
  }
  // На работу
  if (['работа','на работу','жұмыс','жұмысқа','рабочий','на работе'].includes(lo)) {
    return favs.work_address ? { address: favs.work_address, label: '🏢 На работу' } : null;
  }
  // Избранный
  if (favs.fav_address_1 && lo === (favs.fav_address_1_name || '').toLowerCase()) {
    return { address: favs.fav_address_1, label: `⭐ ${favs.fav_address_1_name}` };
  }

  return null;
};

// Текст кнопок избранного для клиента
const getFavButtons = async (phone) => {
  const favs = await getFavorites(phone);
  const buttons = [];
  if (favs.home_address) buttons.push({ id: 'fav_home', text: '🏠 Домой' });
  if (favs.work_address) buttons.push({ id: 'fav_work', text: '🏢 На работу' });
  if (favs.fav_address_1) buttons.push({ id: 'fav_1', text: `⭐ ${favs.fav_address_1_name || 'Избранное'}` });
  return buttons;
};

module.exports = { getFavorites, saveHome, saveWork, saveFav, resolveShortcut, getFavButtons };
