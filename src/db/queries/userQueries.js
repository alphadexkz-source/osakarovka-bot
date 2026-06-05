const db = require('../index')
const { safeSet, ALLOWED_USER_COLS } = require('./utils')

const getUser = async (phone) => {
  const r = await db.query('SELECT * FROM users WHERE phone=$1', [phone])
  return r.rows[0]
}

const createUser = async (phone, name = 'Клиент', role = 'client') => {
  const safeName = String(name).slice(0, 100)
  const r = await db.query(
    `INSERT INTO users(phone,name,role) VALUES($1,$2,$3)
     ON CONFLICT(phone) DO UPDATE SET name=EXCLUDED.name RETURNING *`,
    [phone, safeName, role]
  )
  return r.rows[0]
}

const updateUser = async (phone, updates) => {
  if (!Object.keys(updates).length) return getUser(phone)
  const { keys, vals } = safeSet(updates, ALLOWED_USER_COLS)
  const set = keys.map((k, i) => `${k}=$${i + 2}`).join(',')
  const r = await db.query(`UPDATE users SET ${set} WHERE phone=$1 RETURNING *`, [phone, ...vals])
  return r.rows[0]
}

const incrementTripCount = async (phone) => {
  const r = await db.query(
    'UPDATE users SET trip_count=trip_count+1 WHERE phone=$1 RETURNING trip_count',
    [phone]
  )
  return r.rows[0]?.trip_count || 0
}

const getAllClients = async () => {
  const r = await db.query("SELECT * FROM users WHERE role='client' AND is_blacklisted=FALSE")
  return r.rows
}

const blacklistUser = async (phone, blocked, reason = null) => {
  await db.query(
    `UPDATE users SET is_blacklisted=$2, blacklisted_until=NULL, blacklist_reason=$3 WHERE phone=$1`,
    [phone, blocked, blocked ? reason : null]
  )
}

const tempBlockUser = async (phone, until, reason) => {
  await db.query(
    `UPDATE users SET is_blacklisted=TRUE, blacklisted_until=$2, blacklist_reason=$3 WHERE phone=$1`,
    [phone, until, reason]
  )
}

const unblockUser = async (phone) => {
  await db.query(
    `UPDATE users SET is_blacklisted=FALSE, blacklisted_until=NULL, blacklist_reason=NULL WHERE phone=$1`,
    [phone]
  )
}

const addDebt = async (phone, amount, reason) => {
  await db.query(
    `UPDATE users SET debt_tg=COALESCE(debt_tg,0)+$2, debt_reason=$3 WHERE phone=$1`,
    [phone, amount, reason]
  )
}

const clearDebt = async (phone) => {
  await db.query(
    `UPDATE users SET debt_tg=0, debt_reason=NULL WHERE phone=$1`,
    [phone]
  )
}

const getBlockedUsers = async () => {
  const r = await db.query(
    `SELECT phone, name, debt_tg, debt_reason, is_blacklisted, blacklisted_until, blacklist_reason
     FROM users
     WHERE is_blacklisted=TRUE
     ORDER BY phone`
  )
  return r.rows
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  incrementTripCount,
  getAllClients,
  blacklistUser,
  tempBlockUser,
  unblockUser,
  addDebt,
  clearDebt,
  getBlockedUsers,
}
