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
     WHERE d.status='online' AND d.order_balance>0 ORDER BY d.queue_position ASC`
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
  const maxR = await db.query(
    "SELECT COALESCE(MAX(queue_position),0) AS mp FROM drivers WHERE status='online'"
  )
  const pos = (maxR.rows[0]?.mp || 0) + 1
  await db.query(
    `UPDATE drivers SET queue_position=$2,last_activity=NOW()
     WHERE user_id=(SELECT id FROM users WHERE phone=$1)`,
    [phone, pos]
  )
}

const deductDriverBalance = async (driverId) => {
  // 999999 = бесплатный пробный период — баланс не списываем
  const check = await db.query('SELECT order_balance FROM drivers WHERE id=$1', [driverId])
  const bal = check.rows[0]?.order_balance
  if (bal >= 999999) return 999999

  const r = await db.query(
    `UPDATE drivers SET order_balance=order_balance-1
     WHERE id=$1 AND order_balance>0 RETURNING order_balance`,
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
       AND d.last_activity < NOW() - make_interval(mins => $1::int)`,
    [minutes]
  )
  return r.rows
}

const getLongWaitDrivers = async (minutes = 60) => {
  const r = await db.query(
    `SELECT d.*,u.phone FROM drivers d JOIN users u ON d.user_id=u.id
     WHERE d.status='online'
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

module.exports = {
  getDriver,
  getDriverById,
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
  updateDriverActivity,
  getInactiveDrivers,
  getLongWaitDrivers,
  blacklistDriver,
  setBreakUntil,
  clearBreakUntil,
  getExpiredBreaks,
}
