const db = require('../index')
const { getUser } = require('./userQueries')
const { getSetting } = require('./adminQueries')

// ─── РЕФЕРАЛЬНАЯ ПРОГРАММА ───────────────────────────────────────────────────

const generateReferralCode = (name, phone) => {
  const letters = (name || 'XX').replace(/[^а-яёa-z]/gi, '').toUpperCase().slice(0, 2).padEnd(2, 'X')
  const digits  = String(phone).replace(/\D/g, '').slice(-4)
  return letters + digits
}

const getOrCreateReferralCode = async (phone) => {
  const user = await getUser(phone)
  if (user?.referral_code) return user.referral_code

  let code = generateReferralCode(user?.name || 'КЛ', phone)
  let attempt = 0
  while (attempt < 10) {
    const existing = await db.query('SELECT id FROM users WHERE referral_code=$1', [code])
    if (!existing.rows.length) break
    code = generateReferralCode(user?.name || 'КЛ', phone) + attempt
    attempt++
  }

  await db.query('UPDATE users SET referral_code=$2 WHERE phone=$1', [phone, code])
  return code
}

const getUserByReferralCode = async (code) => {
  const r = await db.query('SELECT * FROM users WHERE referral_code=$1', [code.toUpperCase()])
  return r.rows[0]
}

const applyReferralCode = async (newUserPhone, code) => {
  const referrer = await getUserByReferralCode(code)
  if (!referrer) return { error: 'not_found' }

  const newUser = await getUser(newUserPhone)
  if (!newUser) return { error: 'user_not_found' }

  if (referrer.phone === newUserPhone) return { error: 'self_referral' }

  const existing = await db.query('SELECT id FROM referrals WHERE referred_id=$1', [newUser.id])
  if (existing.rows.length) return { error: 'already_referred' }

  await db.query(
    `INSERT INTO referrals(referrer_id, referred_id, status) VALUES($1,$2,'pending')`,
    [referrer.id, newUser.id]
  )
  await db.query('UPDATE users SET referred_by=$2 WHERE id=$1', [newUser.id, referrer.id])

  return { success: true, referrer }
}

const activateReferral = async (newUserId) => {
  const r = await db.query(
    `UPDATE referrals SET status='activated', activated_at=NOW()
     WHERE referred_id=$1 AND status='pending'
     RETURNING referrer_id`,
    [newUserId]
  )
  if (!r.rows.length) return null

  const referrerId = r.rows[0].referrer_id

  const ref = await db.query('SELECT phone FROM users WHERE id=$1', [referrerId])
  const referrerPhone = ref.rows[0]?.phone

  const bonusSetting = await getSetting('referral_bonus')
  const bonusCount   = Math.max(1, parseInt(bonusSetting) || 1)
  await db.query(
    'UPDATE users SET bonus_trips=bonus_trips+$2 WHERE id=$1',
    [referrerId, bonusCount]
  )

  return { referrerPhone, referrerId }
}

const useBonusTrip = async (phone) => {
  const r = await db.query(
    `UPDATE users SET bonus_trips=bonus_trips-1
     WHERE phone=$1 AND bonus_trips>0
     RETURNING bonus_trips`,
    [phone]
  )
  return r.rows[0]?.bonus_trips !== undefined
}

const getBonusTrips = async (phone) => {
  const r = await db.query('SELECT bonus_trips FROM users WHERE phone=$1', [phone])
  return r.rows[0]?.bonus_trips || 0
}

const getReferralStats = async (phone) => {
  const user = await getUser(phone)
  if (!user) return null
  const r = await db.query(
    `SELECT
       COUNT(*) FILTER(WHERE status='activated') AS activated,
       COUNT(*) FILTER(WHERE status='pending')   AS pending,
       COUNT(*)                                  AS total
     FROM referrals WHERE referrer_id=$1`,
    [user.id]
  )
  return { ...r.rows[0], bonus_trips: user.bonus_trips, referral_code: user.referral_code }
}

// ─── RATINGS ──────────────────────────────────────────────────────────────────

const saveRating = async (orderId, clientId, driverId, score) => {
  await db.query(
    `INSERT INTO ratings(order_id,client_id,driver_id,score) VALUES($1,$2,$3,$4) ON CONFLICT(order_id) DO NOTHING`,
    [orderId, clientId, driverId, score]
  )
}

// ─── FALSE CALLS ──────────────────────────────────────────────────────────────

const saveFalseCall = async (orderId, clientId, driverId, fine) => {
  const r = await db.query(
    `INSERT INTO false_calls(order_id,client_id,driver_id,fine) VALUES($1,$2,$3,$4) RETURNING *`,
    [orderId, clientId, driverId, fine]
  )
  return r.rows[0]
}

const getFalseCallCount = async (clientId) => {
  const r = await db.query('SELECT COUNT(*) AS cnt FROM false_calls WHERE client_id=$1', [clientId])
  return parseInt(r.rows[0]?.cnt || 0)
}

module.exports = {
  getOrCreateReferralCode,
  getUserByReferralCode,
  applyReferralCode,
  activateReferral,
  useBonusTrip,
  getBonusTrips,
  getReferralStats,
  saveRating,
  saveFalseCall,
  getFalseCallCount,
}
