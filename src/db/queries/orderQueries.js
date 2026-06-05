const db = require('../index')
const { safeSet, ALLOWED_ORDER_COLS } = require('./utils')
const { getSession } = require('./sessionQueries')

const createOrder = async ({ client_id, destination, price, tariff_id, is_free, pickup_address, is_intercity, scheduled_time }) => {
  const status = scheduled_time ? 'scheduled' : 'searching'
  const r = await db.query(
    `INSERT INTO orders(client_id,destination,price,tariff_id,is_free,pickup_address,is_intercity,scheduled_time,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [client_id, destination, price, tariff_id || null, is_free || false, pickup_address || null, is_intercity || false, scheduled_time || null, status]
  )
  return r.rows[0]
}

// Предзаказы, время которых наступило (scheduled_time в прошлом или в течение 1 мин)
const getScheduledOrdersDue = async () => {
  const r = await db.query(
    `SELECT o.*, u.phone AS client_phone FROM orders o
     JOIN users u ON o.client_id=u.id
     WHERE o.status='scheduled'
       AND o.scheduled_time <= NOW() + INTERVAL '1 minute'`
  )
  return r.rows
}

// Предзаказы за N минут — для напоминания (не помеченные как reminded)
const getScheduledOrdersSoon = async (mins) => {
  const r = await db.query(
    `SELECT o.*, u.phone AS client_phone FROM orders o
     JOIN users u ON o.client_id=u.id
     WHERE o.status='scheduled'
       AND o.scheduled_reminder_sent = false
       AND o.scheduled_time BETWEEN NOW() AND NOW() + make_interval(mins => $1::int)`,
    [mins]
  )
  return r.rows
}

const getOrder = async (id) => {
  const r = await db.query(
    `SELECT o.*,u.phone AS client_phone,u.name AS client_name,
       d.id AS driver_id,d.full_name AS driver_name,d.car_make,d.car_plate,d.car_color,d.car_photo_url,
       du.phone AS driver_phone
     FROM orders o
     JOIN users u ON o.client_id=u.id
     LEFT JOIN drivers d ON o.driver_id=d.id
     LEFT JOIN users du ON d.user_id=du.id
     WHERE o.id=$1`,
    [id]
  )
  return r.rows[0]
}

const getActiveOrderByClient = async (phone) => {
  const r = await db.query(
    `SELECT o.* FROM orders o JOIN users u ON o.client_id=u.id
     WHERE u.phone=$1 AND o.status NOT IN('completed','cancelled')
     ORDER BY o.created_at DESC LIMIT 1`,
    [phone]
  )
  return r.rows[0]
}

const getActiveOrderByDriver = async (phone) => {
  const r = await db.query(
    `SELECT o.*,u.phone AS client_phone FROM orders o
     JOIN drivers d ON o.driver_id=d.id
     JOIN users u ON o.client_id=u.id
     JOIN users du ON d.user_id=du.id
     WHERE du.phone=$1 AND o.status NOT IN('completed','cancelled')
     ORDER BY o.created_at DESC LIMIT 1`,
    [phone]
  )
  return r.rows[0]
}

const getPendingOrderForDriver = async (phone) => {
  const session = await getSession(phone)
  const orderId = session?.ctx?.pending_order_id
  if (!orderId) return null
  const r = await db.query(`SELECT * FROM orders WHERE id=$1 AND status='searching'`, [orderId])
  return r.rows[0] || null
}

const getLastCompletedOrder = async (phone) => {
  const r = await db.query(
    `SELECT o.* FROM orders o JOIN users u ON o.client_id=u.id
     WHERE u.phone=$1 AND o.status='completed' ORDER BY o.completed_at DESC LIMIT 1`,
    [phone]
  )
  return r.rows[0]
}

const updateOrder = async (id, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_ORDER_COLS)
  const set = keys.map((k, i) => `${k}=$${i + 2}`).join(',')
  const r = await db.query(`UPDATE orders SET ${set} WHERE id=$1 RETURNING *`, [id, ...vals])
  return r.rows[0]
}

// Атомарное принятие заказа — только один водитель получит UPDATE
const atomicAcceptOrder = async (orderId, driverId) => {
  const r = await db.query(
    `UPDATE orders SET driver_id=$2, status='accepted', accepted_at=NOW()
     WHERE id=$1 AND status='searching'
     RETURNING *`,
    [orderId, driverId]
  )
  return r.rows[0]
}

const getTodayStats = async () => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COUNT(*) FILTER(WHERE status='cancelled') AS cancelled,
            COUNT(*) AS total,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue
     FROM orders WHERE created_at::date=CURRENT_DATE`
  )
  return r.rows[0]
}

const getPeriodStats = async (days) => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COUNT(*) FILTER(WHERE status='cancelled') AS cancelled,
            COUNT(*) AS total,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue,
            COUNT(DISTINCT client_id) AS unique_clients
     FROM orders WHERE created_at >= NOW() - make_interval(days => $1::int)`,
    [days]
  )
  return r.rows[0]
}

const getDriverTodayStats = async (driverId) => {
  const r = await db.query(
    `SELECT COUNT(*) FILTER(WHERE status='completed') AS completed,
            COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS earned
     FROM orders WHERE driver_id=$1 AND created_at::date=CURRENT_DATE`,
    [driverId]
  )
  return r.rows[0]
}

const getTopDrivers = async (days = 7) => {
  const r = await db.query(
    `SELECT d.full_name,u.phone,COUNT(*) AS trips,
            COALESCE(SUM(o.price),0) AS earned,AVG(r.score) AS avg_rating
     FROM orders o
     JOIN drivers d ON o.driver_id=d.id
     JOIN users u ON d.user_id=u.id
     LEFT JOIN ratings r ON r.order_id=o.id
     WHERE o.status='completed' AND o.created_at >= NOW() - make_interval(days => $1::int)
     GROUP BY d.id,d.full_name,u.phone ORDER BY trips DESC LIMIT 5`,
    [days]
  )
  return r.rows
}

// ─── DISPATCH STATE (персистентность таймеров диспетчеризации) ────────────────

// Сохраняем кому отправлен заказ и когда — для восстановления после рестарта
const setDispatchState = async (orderId, driverPhone) => {
  await db.query(
    `UPDATE orders SET dispatched_to=$2, dispatched_at=NOW()
     WHERE id=$1 AND status='searching'`,
    [orderId, driverPhone]
  )
}

const clearDispatchState = async (orderId) => {
  await db.query(
    `UPDATE orders SET dispatched_to=NULL, dispatched_at=NULL WHERE id=$1`,
    [orderId]
  )
}

// Возвращает заказы где водитель не ответил дольше timeoutMs
const getExpiredDispatches = async (timeoutMs) => {
  const timeoutSec = Math.floor(timeoutMs / 1000)
  const r = await db.query(
    `SELECT o.*, u.phone AS client_phone
     FROM orders o
     JOIN users u ON o.client_id=u.id
     WHERE o.status='searching'
       AND o.dispatched_to IS NOT NULL
       AND o.dispatched_at IS NOT NULL
       AND o.dispatched_at < NOW() - make_interval(secs => $1::int)`,
    [timeoutSec]
  )
  return r.rows
}

// ─── ARRIVE WARNING (предупреждение при долгом ожидании прибытия) ─────────────

const setArriveWarned = async (orderId) => {
  await db.query(
    `UPDATE orders SET arrive_warned=TRUE WHERE id=$1`,
    [orderId]
  )
}

// Возвращает принятые заказы где водитель едёт дольше warningAfterMs и ещё не предупреждали
const getUnwarnedArrivals = async (warningAfterMs) => {
  const timeoutSec = Math.floor(warningAfterMs / 1000)
  const r = await db.query(
    `SELECT o.*,
       u.phone AS client_phone,
       du.phone AS driver_phone,
       d.full_name AS driver_name
     FROM orders o
     JOIN users u ON o.client_id=u.id
     JOIN drivers d ON o.driver_id=d.id
     JOIN users du ON d.user_id=du.id
     WHERE o.status='accepted'
       AND o.accepted_at IS NOT NULL
       AND (o.arrive_warned IS NULL OR o.arrive_warned=FALSE)
       AND o.accepted_at < NOW() - make_interval(secs => $1::int)`,
    [timeoutSec]
  )
  return r.rows
}

const saveRating = async (orderId, clientId, driverId, score) => {
  await db.query(
    `INSERT INTO ratings(order_id, client_id, driver_id, score)
     VALUES($1,$2,$3,$4)
     ON CONFLICT(order_id) DO UPDATE SET score=EXCLUDED.score`,
    [orderId, clientId, driverId, score]
  )
}

const saveFalseCall = async (orderId, clientId, driverId, fine) => {
  await db.query(
    `INSERT INTO false_calls(order_id, client_id, driver_id, fine)
     VALUES($1,$2,$3,$4)`,
    [orderId, clientId, driverId ?? null, fine]
  )
}

const getFalseCallCount = async (clientId) => {
  const r = await db.query(
    `SELECT COUNT(*) AS cnt FROM false_calls WHERE client_id=$1`,
    [clientId]
  )
  return parseInt(r.rows[0]?.cnt || 0)
}

module.exports = {
  createOrder,
  getOrder,
  getActiveOrderByClient,
  getActiveOrderByDriver,
  getPendingOrderForDriver,
  getLastCompletedOrder,
  updateOrder,
  atomicAcceptOrder,
  getTodayStats,
  getPeriodStats,
  getDriverTodayStats,
  getTopDrivers,
  setDispatchState,
  clearDispatchState,
  getExpiredDispatches,
  setArriveWarned,
  getUnwarnedArrivals,
  saveRating,
  saveFalseCall,
  getFalseCallCount,
  getScheduledOrdersDue,
  getScheduledOrdersSoon,
}
