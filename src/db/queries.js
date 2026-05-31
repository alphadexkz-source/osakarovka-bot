const db = require('./index');

// ─── БЕЛЫЕ СПИСКИ КОЛОНОК (защита от SQL injection) ───────────
const ALLOWED_USER_COLS    = new Set(['name','role','language','trip_count','last_seen_date','is_blacklisted']);
const ALLOWED_DRIVER_COLS  = new Set(['full_name','car_photo_url','car_make','car_plate','car_color','status','rating','rating_count','queue_position','order_balance','skip_next','last_activity']);
const ALLOWED_TARIFF_COLS  = new Set(['name','keywords','day_price','night_price','description','is_active']);
const ALLOWED_ORDER_COLS   = new Set(['driver_id','status','cancel_reason','accepted_at','arrived_at','completed_at','cancelled_at','is_free']);

const safeSet = (updates, allowed) => {
  const keys = Object.keys(updates).filter(k => allowed.has(k));
  if (!keys.length) throw new Error('No valid columns to update');
  return { keys, vals: keys.map(k => updates[k]) };
};

// ─── USERS ────────────────────────────────────────────────────
const getUser = async (phone) => {
  const r = await db.query('SELECT * FROM users WHERE phone=$1', [phone]);
  return r.rows[0];
};
const createUser = async (phone, name='Клиент', role='client') => {
  // Санитизация: обрезаем имя до 100 символов
  const safeName = String(name).slice(0, 100);
  const r = await db.query(
    `INSERT INTO users(phone,name,role) VALUES($1,$2,$3)
     ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
    [phone, safeName, role]
  );
  return r.rows[0];
};
const updateUser = async (phone, updates) => {
  if (!Object.keys(updates).length) return getUser(phone);
  const { keys, vals } = safeSet(updates, ALLOWED_USER_COLS);
  const set = keys.map((k,i) => `${k}=$${i+2}`).join(',');
  const r = await db.query(`UPDATE users SET ${set} WHERE phone=$1 RETURNING *`, [phone,...vals]);
  return r.rows[0];
};
const incrementTripCount = async (phone) => {
  const r = await db.query('UPDATE users SET trip_count=trip_count+1 WHERE phone=$1 RETURNING trip_count', [phone]);
  return r.rows[0]?.trip_count || 0;
};
const getAllClients = async () => {
  const r = await db.query("SELECT * FROM users WHERE role='client' AND is_blacklisted=FALSE");
  return r.rows;
};
const blacklistUser = async (phone, blocked) => {
  await db.query('UPDATE users SET is_blacklisted=$2 WHERE phone=$1', [phone, blocked]);
};

// ─── DRIVERS ──────────────────────────────────────────────────
const getDriver = async (phone) => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name,u.language,u.trip_count,u.is_blacklisted
     FROM drivers d JOIN users u ON d.user_id=u.id WHERE u.phone=$1`, [phone]
  );
  return r.rows[0];
};
const getDriverById = async (id) => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id WHERE d.id=$1`, [id]
  );
  return r.rows[0];
};
const createDriver = async (userId) => {
  const r = await db.query(
    `INSERT INTO drivers(user_id,order_balance) VALUES($1,999999)
     ON CONFLICT(user_id) DO NOTHING RETURNING *`, [userId]
  );
  return r.rows[0];
};
const updateDriver = async (phone, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_DRIVER_COLS);
  const set = keys.map((k,i) => `${k}=$${i+2}`).join(',');
  const r = await db.query(
    `UPDATE drivers SET ${set} WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING *`,
    [phone,...vals]
  );
  return r.rows[0];
};
const setDriverStatus = async (phone, status) => {
  // Whitelist статусов
  const allowed = ['online','offline','busy','blocked'];
  if (!allowed.includes(status)) throw new Error(`Invalid driver status: ${status}`);
  const r = await db.query(
    `UPDATE drivers SET status=$2,last_activity=NOW()
     WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING *`, [phone, status]
  );
  return r.rows[0];
};
const getOnlineDriversQueue = async () => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online' AND d.order_balance>0 ORDER BY d.queue_position ASC`
  );
  return r.rows;
};
const getDriverQueuePosition = async (phone) => {
  const r = await db.query(
    `SELECT COUNT(*) AS pos FROM drivers d
     JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.queue_position < (
         SELECT queue_position FROM drivers WHERE user_id=(SELECT id FROM users WHERE phone=$1)
       )`, [phone]
  );
  return parseInt(r.rows[0]?.pos||0)+1;
};
const getAllDrivers = async () => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id ORDER BY d.full_name`
  );
  return r.rows;
};
const moveDriverToEndOfQueue = async (phone) => {
  const maxR = await db.query("SELECT COALESCE(MAX(queue_position),0) AS mp FROM drivers WHERE status='online'");
  const pos = (maxR.rows[0]?.mp||0)+1;
  await db.query(
    `UPDATE drivers SET queue_position=$2,last_activity=NOW()
     WHERE user_id=(SELECT id FROM users WHERE phone=$1)`, [phone, pos]
  );
};
const deductDriverBalance = async (driverId) => {
  // FIX: 999999 = бесплатный пробный период — баланс не списываем, возвращаем sentinel 999999
  const check = await db.query('SELECT order_balance FROM drivers WHERE id=$1', [driverId]);
  const bal = check.rows[0]?.order_balance;
  if (bal >= 999999) return 999999; // free trial — не списываем

  const r = await db.query(
    `UPDATE drivers SET order_balance=order_balance-1
     WHERE id=$1 AND order_balance>0 RETURNING order_balance`, [driverId]
  );
  return r.rows[0]?.order_balance; // undefined если order_balance был 0
};
const addDriverBalance = async (driverPhone, amount) => {
  const r = await db.query(
    `UPDATE drivers SET order_balance=order_balance+$2
     WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING id,order_balance`,
    [driverPhone, amount]
  );
  return r.rows[0];
};
const updateDriverRating = async (driverId, score) => {
  const r = await db.query(
    `UPDATE drivers SET rating=((rating*rating_count)+$2)/(rating_count+1),rating_count=rating_count+1
     WHERE id=$1 RETURNING rating,rating_count`, [driverId, score]
  );
  return r.rows[0];
};
const updateDriverActivity = async (phone) => {
  await db.query(
    `UPDATE drivers SET last_activity=NOW() WHERE user_id=(SELECT id FROM users WHERE phone=$1)`, [phone]
  );
};
const getInactiveDrivers = async (minutes=30) => {
  const r = await db.query(
    `SELECT d.*,u.phone FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.last_activity < NOW() - make_interval(mins => $1::int)`, [minutes]
  );
  return r.rows;
};
const getLongWaitDrivers = async (minutes=60) => {
  const r = await db.query(
    `SELECT d.*,u.phone FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.last_activity < NOW() - make_interval(mins => $1::int)
       AND NOT EXISTS(
         SELECT 1 FROM orders o WHERE o.driver_id=d.id AND o.created_at::date=CURRENT_DATE
       )`, [minutes]
  );
  return r.rows;
};
const blacklistDriver = async (phone, blocked) => {
  await db.query(
    `UPDATE drivers SET status=$2 WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone, blocked ? 'blocked' : 'offline']
  );
  await blacklistUser(phone, blocked);
};

// ─── TARIFFS ──────────────────────────────────────────────────
const getTariffs = async () => {
  const r = await db.query('SELECT * FROM tariffs WHERE is_active=TRUE ORDER BY name');
  return r.rows;
};
const getTariffById = async (id) => {
  const r = await db.query('SELECT * FROM tariffs WHERE id=$1', [id]);
  return r.rows[0];
};
const createTariff = async ({name,keywords,day_price,night_price,description}) => {
  const r = await db.query(
    `INSERT INTO tariffs(name,keywords,day_price,night_price,description) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name, keywords||[], day_price, night_price||null, description||null]
  );
  return r.rows[0];
};
const updateTariff = async (id, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_TARIFF_COLS);
  const set = keys.map((k,i) => `${k}=$${i+2}`).join(',');
  const r = await db.query(`UPDATE tariffs SET ${set} WHERE id=$1 RETURNING *`, [id,...vals]);
  return r.rows[0];
};
const deleteTariff = async (id) => {
  await db.query('UPDATE tariffs SET is_active=FALSE WHERE id=$1', [id]);
};

// ─── ORDERS ───────────────────────────────────────────────────
const createOrder = async ({client_id,destination,price,tariff_id,is_free}) => {
  const r = await db.query(
    `INSERT INTO orders(client_id,destination,price,tariff_id,is_free) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [client_id, destination, price, tariff_id||null, is_free||false]
  );
  return r.rows[0];
};
const getOrder = async (id) => {
  const r = await db.query(
    `SELECT o.*,u.phone AS client_phone,u.name AS client_name,
       d.id AS driver_id,d.full_name AS driver_name,d.car_make,d.car_plate,d.car_color,d.car_photo_url,
       du.phone AS driver_phone
     FROM orders o
     JOIN users u ON o.client_id=u.id
     LEFT JOIN drivers d ON o.driver_id=d.id
     LEFT JOIN users du ON d.user_id=du.id
     WHERE o.id=$1`, [id]
  );
  return r.rows[0];
};
const getActiveOrderByClient = async (phone) => {
  const r = await db.query(
    `SELECT o.* FROM orders o JOIN users u ON o.client_id=u.id
     WHERE u.phone=$1 AND o.status NOT IN('completed','cancelled')
     ORDER BY o.created_at DESC LIMIT 1`, [phone]
  );
  return r.rows[0];
};
const getActiveOrderByDriver = async (phone) => {
  const r = await db.query(
    `SELECT o.*,u.phone AS client_phone FROM orders o
     JOIN drivers d ON o.driver_id=d.id
     JOIN users u ON o.client_id=u.id
     JOIN users du ON d.user_id=du.id
     WHERE du.phone=$1 AND o.status NOT IN('completed','cancelled')
     ORDER BY o.created_at DESC LIMIT 1`, [phone]
  );
  return r.rows[0];
};
const getPendingOrderForDriver = async (phone) => {
  const session = await getSession(phone);
  const orderId = session?.ctx?.pending_order_id;
  if (!orderId) return null;
  const r = await db.query(`SELECT * FROM orders WHERE id=$1 AND status='searching'`, [orderId]);
  return r.rows[0] || null;
};
const getLastCompletedOrder = async (phone) => {
  const r = await db.query(
    `SELECT o.* FROM orders o JOIN users u ON o.client_id=u.id
     WHERE u.phone=$1 AND o.status='completed' ORDER BY o.completed_at DESC LIMIT 1`, [phone]
  );
  return r.rows[0];
};
const updateOrder = async (id, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_ORDER_COLS);
  const set = keys.map((k,i) => `${k}=$${i+2}`).join(',');
  const r = await db.query(`UPDATE orders SET ${set} WHERE id=$1 RETURNING *`, [id,...vals]);
  return r.rows[0];
};
// FIX: атомарное принятие заказа — только один водитель получит UPDATE
const atomicAcceptOrder = async (orderId, driverId) => {
  const r = await db.query(
    `UPDATE orders SET driver_id=$2, status='accepted', accepted_at=NOW()
     WHERE id=$1 AND status='searching'
     RETURNING *`,
    [orderId, driverId]
  );
  return r.rows[0]; // null если заказ уже принят кем-то другим
};
const getTodayStats = async () => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COUNT(*) FILTER(WHERE status='cancelled') AS cancelled,
            COUNT(*) AS total,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue
     FROM orders WHERE created_at::date=CURRENT_DATE`
  );
  return r.rows[0];
};
const getPeriodStats = async (days) => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COUNT(*) FILTER(WHERE status='cancelled') AS cancelled,
            COUNT(*) AS total,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue,
            COUNT(DISTINCT client_id) AS unique_clients
     FROM orders WHERE created_at >= NOW() - make_interval(days => $1::int)`, [days]
  );
  return r.rows[0];
};
const getDriverTodayStats = async (driverId) => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS earned
     FROM orders WHERE driver_id=$1 AND created_at::date=CURRENT_DATE`, [driverId]
  );
  return r.rows[0];
};
const getTopDrivers = async (days=7) => {
  const r = await db.query(
    `SELECT d.full_name,u.phone,COUNT(*) AS trips,
            COALESCE(SUM(o.price),0) AS earned,AVG(r.score) AS avg_rating
     FROM orders o
     JOIN drivers d ON o.driver_id=d.id
     JOIN users u ON d.user_id=u.id
     LEFT JOIN ratings r ON r.order_id=o.id
     WHERE o.status='completed' AND o.created_at >= NOW() - make_interval(days => $1::int)
     GROUP BY d.id,d.full_name,u.phone ORDER BY trips DESC LIMIT 5`, [days]
  );
  return r.rows;
};

// ─── SESSIONS ─────────────────────────────────────────────────
const getSession = async (phone) => {
  const r = await db.query('SELECT * FROM sessions WHERE phone=$1', [phone]);
  return r.rows[0];
};
const setSession = async (phone, state, ctx={}) => {
  await db.query(
    `INSERT INTO sessions(phone,state,ctx,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(phone) DO UPDATE SET state=EXCLUDED.state,ctx=EXCLUDED.ctx,updated_at=NOW()`,
    [phone, state, JSON.stringify(ctx)]
  );
};
const clearSession = async (phone) => setSession(phone,'idle',{});

// ─── BILLING ──────────────────────────────────────────────────
const addBillingRecord = async (driverId, amount, balanceAfter, note, adminPhone) => {
  await db.query(
    `INSERT INTO billing(driver_id,amount,balance_after,note,admin_phone) VALUES($1,$2,$3,$4,$5)`,
    [driverId, amount, balanceAfter, note, adminPhone]
  );
};

// ─── SETTINGS ─────────────────────────────────────────────────
const getSetting = async (key) => {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return r.rows[0]?.value;
};
const setSetting = async (key, value) => {
  await db.query(
    `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  );
};

// ─── RATINGS ──────────────────────────────────────────────────
const saveRating = async (orderId, clientId, driverId, score) => {
  await db.query(
    `INSERT INTO ratings(order_id,client_id,driver_id,score) VALUES($1,$2,$3,$4) ON CONFLICT(order_id) DO NOTHING`,
    [orderId, clientId, driverId, score]
  );
};

// ─── FALSE CALLS ──────────────────────────────────────────────
const saveFalseCall = async (orderId, clientId, driverId, fine) => {
  const r = await db.query(
    `INSERT INTO false_calls(order_id,client_id,driver_id,fine) VALUES($1,$2,$3,$4) RETURNING *`,
    [orderId, clientId, driverId, fine]
  );
  return r.rows[0];
};
const getFalseCallCount = async (clientId) => {
  const r = await db.query('SELECT COUNT(*) AS cnt FROM false_calls WHERE client_id=$1', [clientId]);
  return parseInt(r.rows[0]?.cnt||0);
};

// ─── ADMIN BRUTE FORCE PROTECTION (в памяти) ──────────────────
const failedAdminAttempts = new Map(); // phone → { count, lockedUntil }
const checkAdminAttempt = (phone) => {
  const rec = failedAdminAttempts.get(phone);
  if (rec?.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return { locked: true, mins };
  }
  return { locked: false };
};
const recordFailedAdmin = (phone) => {
  const rec = failedAdminAttempts.get(phone) || { count: 0 };
  rec.count += 1;
  if (rec.count >= 5) rec.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 мин блокировка
  failedAdminAttempts.set(phone, rec);
  return rec.count;
};
const resetAdminAttempts = (phone) => failedAdminAttempts.delete(phone);


// ─── РЕФЕРАЛЬНАЯ ПРОГРАММА ────────────────────────────────────

// Генерация уникального кода: первые 2 буквы имени + 4 цифры телефона
const generateReferralCode = (name, phone) => {
  const letters = (name || 'XX').replace(/[^а-яёa-z]/gi, '').toUpperCase().slice(0, 2).padEnd(2, 'X');
  const digits  = String(phone).replace(/\D/g, '').slice(-4);
  return letters + digits;
};

const getOrCreateReferralCode = async (phone) => {
  // Вернуть существующий код
  const user = await getUser(phone);
  if (user?.referral_code) return user.referral_code;

  // Сгенерировать уникальный код
  let code = generateReferralCode(user?.name || 'КЛ', phone);
  // Если занят — добавить случайные цифры
  let attempt = 0;
  while (attempt < 10) {
    const existing = await db.query('SELECT id FROM users WHERE referral_code=$1', [code]);
    if (!existing.rows.length) break;
    code = generateReferralCode(user?.name || 'КЛ', phone) + attempt;
    attempt++;
  }

  await db.query('UPDATE users SET referral_code=$2 WHERE phone=$1', [phone, code]);
  return code;
};

const getUserByReferralCode = async (code) => {
  const r = await db.query('SELECT * FROM users WHERE referral_code=$1', [code.toUpperCase()]);
  return r.rows[0];
};

const applyReferralCode = async (newUserPhone, code) => {
  // Найти реферера по коду
  const referrer = await getUserByReferralCode(code);
  if (!referrer) return { error: 'not_found' };

  const newUser = await getUser(newUserPhone);
  if (!newUser) return { error: 'user_not_found' };

  // Нельзя использовать свой код
  if (referrer.phone === newUserPhone) return { error: 'self_referral' };

  // Уже был приглашён?
  const existing = await db.query('SELECT id FROM referrals WHERE referred_id=$1', [newUser.id]);
  if (existing.rows.length) return { error: 'already_referred' };

  // Сохранить реферал — ожидаем первой поездки друга
  await db.query(
    `INSERT INTO referrals(referrer_id, referred_id, status) VALUES($1,$2,'pending')`,
    [referrer.id, newUser.id]
  );
  await db.query('UPDATE users SET referred_by=$2 WHERE id=$1', [newUser.id, referrer.id]);

  // Бонус пока НЕ начисляем — ждём завершения первой поездки друга
  return { success: true, referrer };
};

// Активировать реферал (после первой поездки нового клиента)
const activateReferral = async (newUserId) => {
  const r = await db.query(
    `UPDATE referrals SET status='activated', activated_at=NOW()
     WHERE referred_id=$1 AND status='pending'
     RETURNING referrer_id`,
    [newUserId]
  );
  if (!r.rows.length) return null; // нет реферала или уже активирован

  const referrerId = r.rows[0].referrer_id;

  // Получить телефон реферера
  const ref = await db.query('SELECT phone FROM users WHERE id=$1', [referrerId]);
  const referrerPhone = ref.rows[0]?.phone;

  // Начислить бонус рефереру согласно настройке referral_bonus
  const bonusSetting = await getSetting('referral_bonus');
  const bonusCount   = Math.max(1, parseInt(bonusSetting) || 1);
  await db.query(
    'UPDATE users SET bonus_trips=bonus_trips+$2 WHERE id=$1',
    [referrerId, bonusCount]
  );

  return { referrerPhone, referrerId };
};

// Использовать бонусную поездку
const useBonusTrip = async (phone) => {
  const r = await db.query(
    `UPDATE users SET bonus_trips=bonus_trips-1
     WHERE phone=$1 AND bonus_trips>0
     RETURNING bonus_trips`,
    [phone]
  );
  return r.rows[0]?.bonus_trips !== undefined; // true = списано
};

const getBonusTrips = async (phone) => {
  const r = await db.query('SELECT bonus_trips FROM users WHERE phone=$1', [phone]);
  return r.rows[0]?.bonus_trips || 0;
};

const getReferralStats = async (phone) => {
  const user = await getUser(phone);
  if (!user) return null;
  const r = await db.query(
    `SELECT
       COUNT(*) FILTER(WHERE status='activated') AS activated,
       COUNT(*) FILTER(WHERE status='pending')   AS pending,
       COUNT(*)                                  AS total
     FROM referrals WHERE referrer_id=$1`,
    [user.id]
  );
  return { ...r.rows[0], bonus_trips: user.bonus_trips, referral_code: user.referral_code };
};

module.exports = {
  getUser, createUser, updateUser, incrementTripCount, getAllClients, blacklistUser,
  getDriver, getDriverById, createDriver, updateDriver, setDriverStatus,
  getOnlineDriversQueue, getDriverQueuePosition, getAllDrivers, moveDriverToEndOfQueue,
  deductDriverBalance, addDriverBalance, updateDriverRating,
  updateDriverActivity, getInactiveDrivers, getLongWaitDrivers, blacklistDriver,
  getTariffs, getTariffById, createTariff, updateTariff, deleteTariff,
  createOrder, getOrder, getActiveOrderByClient, getActiveOrderByDriver,
  getPendingOrderForDriver, getLastCompletedOrder, updateOrder, atomicAcceptOrder,
  getTodayStats, getPeriodStats, getDriverTodayStats, getTopDrivers,
  getSession, setSession, clearSession,
  addBillingRecord, getSetting, setSetting, saveRating,
  saveFalseCall, getFalseCallCount,
  checkAdminAttempt, recordFailedAdmin, resetAdminAttempts,
  // referral
  getOrCreateReferralCode, getUserByReferralCode, applyReferralCode,
  activateReferral, useBonusTrip, getBonusTrips, getReferralStats,
};
