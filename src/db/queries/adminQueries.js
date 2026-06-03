const db = require('../index')

// ─── ADMIN BRUTE FORCE PROTECTION (в БД, таблица admin_attempts) ─────────────
// Таблица создаётся через migration_v2.sql

const checkAdminAttempt = async (phone) => {
  const r = await db.query(
    `SELECT attempt_count, locked_until FROM admin_attempts WHERE phone=$1`,
    [phone]
  )
  const rec = r.rows[0]
  if (!rec) return { locked: false }

  if (rec.locked_until && new Date(rec.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(rec.locked_until) - Date.now()) / 60000)
    return { locked: true, mins }
  }
  return { locked: false }
}

const recordFailedAdmin = async (phone) => {
  const r = await db.query(
    `INSERT INTO admin_attempts(phone, attempt_count, last_attempt_at)
     VALUES($1, 1, NOW())
     ON CONFLICT(phone) DO UPDATE
       SET attempt_count = admin_attempts.attempt_count + 1,
           last_attempt_at = NOW(),
           locked_until = CASE
             WHEN admin_attempts.attempt_count + 1 >= 5
             THEN NOW() + INTERVAL '15 minutes'
             ELSE NULL
           END
     RETURNING attempt_count`,
    [phone]
  )
  return r.rows[0]?.attempt_count || 1
}

const resetAdminAttempts = async (phone) => {
  await db.query(
    `DELETE FROM admin_attempts WHERE phone=$1`,
    [phone]
  )
}

// ─── SETTINGS ────────────────────────────────────────────────────────────────

const getSetting = async (key) => {
  const r = await db.query('SELECT value FROM settings WHERE key=$1', [key])
  return r.rows[0]?.value
}

const setSetting = async (key, value) => {
  await db.query(
    `INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  )
}

// ─── BILLING ─────────────────────────────────────────────────────────────────

const addBillingRecord = async (driverId, amount, balanceAfter, note, adminPhone) => {
  await db.query(
    `INSERT INTO billing(driver_id,amount,balance_after,note,admin_phone) VALUES($1,$2,$3,$4,$5)`,
    [driverId, amount, balanceAfter, note, adminPhone]
  )
}

module.exports = {
  checkAdminAttempt,
  recordFailedAdmin,
  resetAdminAttempts,
  getSetting,
  setSetting,
  addBillingRecord,
}
