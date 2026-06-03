const db = require('../index')
const { safeSet, ALLOWED_TARIFF_COLS } = require('./utils')

const getTariffs = async () => {
  const r = await db.query('SELECT * FROM tariffs WHERE is_active=TRUE ORDER BY name')
  return r.rows
}

const getTariffById = async (id) => {
  const r = await db.query('SELECT * FROM tariffs WHERE id=$1', [id])
  return r.rows[0]
}

const createTariff = async ({ name, keywords, day_price, night_price, description }) => {
  const r = await db.query(
    `INSERT INTO tariffs(name,keywords,day_price,night_price,description) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [name, keywords || [], day_price, night_price || null, description || null]
  )
  return r.rows[0]
}

const updateTariff = async (id, updates) => {
  const { keys, vals } = safeSet(updates, ALLOWED_TARIFF_COLS)
  const set = keys.map((k, i) => `${k}=$${i + 2}`).join(',')
  const r = await db.query(`UPDATE tariffs SET ${set} WHERE id=$1 RETURNING *`, [id, ...vals])
  return r.rows[0]
}

const deleteTariff = async (id) => {
  await db.query('UPDATE tariffs SET is_active=FALSE WHERE id=$1', [id])
}

module.exports = {
  getTariffs,
  getTariffById,
  createTariff,
  updateTariff,
  deleteTariff,
}
