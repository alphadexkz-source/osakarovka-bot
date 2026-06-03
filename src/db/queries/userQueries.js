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

const blacklistUser = async (phone, blocked) => {
  await db.query('UPDATE users SET is_blacklisted=$2 WHERE phone=$1', [phone, blocked])
}

module.exports = {
  getUser,
  createUser,
  updateUser,
  incrementTripCount,
  getAllClients,
  blacklistUser,
}
