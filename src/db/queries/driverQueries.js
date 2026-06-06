const db = require('../index')
const { safeSet, ALLOWED_DRIVER_COLS } = require('./utils')
const { blacklistUser } = require('./userQueries')

const getDriver = async (phone) => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name,u.language,u.trip_count,u.is_blacklisted
     FROM drivers d JOIN users u ON d.user_id=u.id WHERE u.phone=$1`,
    [phone]
  )
  return r.rows[0]
}

const getDriverById = async (id) => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id WHERE d.id=$1`,
    [id]
  )
  return r.rows[0]
}

const isFullyRegisteredDriver = async (phone) => {
  const driver = await getDriver(phone)
  if (!driver) return false
  return !!(driver.full_name && driver.car_plate && driver.car_make)
}

const createDriver = async (userId) => {
  const r = await db.query(
    `INSERT INTO drivers(user_id,order_balance) VALUES($1,999999)
     ON CONFLICT(user_id) DO NOTHING RETURNING *`,
    [userId]
  )
  return r.rows[0]
}

const updateDriver = async (phone, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_DRIVER_COLS)
  const set = keys.map((k, i) => `${k}=$${i + 2}`).join(',')
  const r = await db.query(
    `UPDATE drivers SET ${set} WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING *`,
    [phone, ...vals]
  )
  return r.rows[0]
}

const setDriverStatus = async (phone, status) => {
  const allowed = ['online', 'offline', 'busy', 'blocked']
  if (!allowed.includes(status)) throw new Error(`Invalid driver status: ${status}`)
  const r = await db.query(
    `UPDATE drivers SET status=$2,last_activity=NOW()
     WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING *`,
    [phone, status]
  )
  return r.rows[0]
}

const getOnlineDriversQueue = async () => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online' AND d.order_balance>0
       AND d.full_name IS NOT NULL AND d.car_plate IS NOT NULL
     ORDER BY d.queue_position ASC`
  )
  return r.rows
}

const getDriverQueuePosition = async (phone) => {
  const r = await db.query(
    `SELECT COUNT(*) AS pos FROM drivers d
     JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.queue_position < (
         SELECT queue_position FROM drivers WHERE user_id=(SELECT id FROM users WHERE phone=$1)
       )`,
    [phone]
  )
  return parseInt(r.rows[0]?.pos || 0) + 1
}

const getAllDrivers = async () => {
  const r = await db.query(
    `SELECT d.*,u.phone,u.name FROM drivers d JOIN users u ON d.user_id=u.id ORDER BY d.full_name`
  )
  return r.rows
}

const moveDriverToEndOfQueue = async (phone) => {
  // Атомарно: используем Unix-timestamp (сек) как позицию.
  // FIFO-порядок сохраняется, race condition исключён — нет отдельного SELECT.
  await db.query(
    `UPDATE drivers SET
       queue_position = EXTRACT(EPOCH FROM clock_timestamp())::int,
       last_activity  = NOW()
     WHERE user_id = (SELECT id FROM users WHERE phone=$1)`,
    [phone]
  )
}

const deductDriverBalance = async (driverId) => {
  // Атомарный UPDATE — исключает TOCTOU race condition между SELECT и UPDATE
  // 999999 = бесплатный пробный период — баланс не трогаем
  const r = await db.query(
    `UPDATE drivers SET order_balance =
       CASE WHEN order_balance >= 999999 THEN order_balance
            WHEN order_balance > 0       THEN order_balance - 1
            ELSE 0 END
     WHERE id=$1 RETURNING order_balance`,
    [driverId]
  )
  return r.rows[0]?.order_balance
}

const addDriverBalance = async (driverPhone, amount) => {
  const r = await db.query(
    `UPDATE drivers SET order_balance=order_balance+$2
     WHERE user_id=(SELECT id FROM users WHERE phone=$1) RETURNING id,order_balance`,
    [driverPhone, amount]
  )
  return r.rows[0]
}

const updateDriverRating = async (driverId, score) => {
  const r = await db.query(
    `UPDATE drivers SET rating=((rating*rating_count)+$2)/(rating_count+1),rating_count=rating_count+1
     WHERE id=$1 RETURNING rating,rating_count`,
    [driverId, score]
  )
  return r.rows[0]
}

const updateDriverActivity = async (phone) => {
  await db.query(
    `UPDATE drivers SET last_activity=NOW() WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone]
  )
}

const getInactiveDrivers = async (minutes = 30) => {
  const r = await db.query(
    `SELECT d.*,u.phone FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.full_name IS NOT NULL
       AND d.last_activity < NOW() - make_interval(mins => $1::int)`,
    [minutes]
  )
  return r.rows
}

const getLongWaitDrivers = async (minutes = 60) => {
  const r = await db.query(
    `SELECT d.*,u.phone FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
       AND d.full_name IS NOT NULL
       AND d.last_activity < NOW() - make_interval(mins => $1::int)
       AND NOT EXISTS(
         SELECT 1 FROM orders o WHERE o.driver_id=d.id AND o.created_at::date=CURRENT_DATE
       )`,
    [minutes]
  )
  return r.rows
}

const blacklistDriver = async (phone, blocked) => {
  await db.query(
    `UPDATE drivers SET status=$2 WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone, blocked ? 'blocked' : 'offline']
  )
  await blacklistUser(phone, blocked)
}

const setBreakUntil = async (phone, breakUntil) => {
  await db.query(
    `UPDATE drivers SET break_until=$2 WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone, breakUntil]
  )
}

const clearBreakUntil = async (phone) => {
  await db.query(
    `UPDATE drivers SET break_until=NULL WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone]
  )
}

const getExpiredBreaks = async () => {
  const r = await db.query(
    `SELECT u.phone, d.full_name FROM drivers d
     JOIN users u ON d.user_id=u.id
     WHERE d.status='offline'
       AND d.break_until IS NOT NULL
       AND d.break_until <= NOW()`
  )
  return r.rows
}

const resetDriverRating = async (phone) => {
  await db.query(
    `UPDATE drivers SET rating=5.0, skip_next=false
     WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone]
  )
}

module.exports = {
  getDriver,
  getDriverById,
  isFullyRegisteredDriver,
  createDriver,
  updateDriver,
  setDriverStatus,
  getOnlineDriversQueue,
  getDriverQueuePosition,
  getAllDrivers,
  moveDriverToEndOfQueue,
  deductDriverBalance,
  addDriverBalance,
  updateDriverRating,
  resetDriverRating,
  updateDriverActivity,
  getInactiveDrivers,
  getLongWaitDrivers,
  blacklistDriver,
  setBreakUntil,
  clearBreakUntil,
  getExpiredBreaks,
}
