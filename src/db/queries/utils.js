// ─── БЕЛЫЕ СПИСКИ КОЛОНОК (защита от SQL injection) ──────────────────────────
const ALLOWED_USER_COLS    = new Set(['name','role','language','trip_count','last_seen_date','is_blacklisted'])
const ALLOWED_DRIVER_COLS  = new Set(['full_name','car_photo_url','car_make','car_plate','car_color','status','rating','rating_count','queue_position','order_balance','skip_next','last_activity'])
const ALLOWED_TARIFF_COLS  = new Set(['name','keywords','day_price','night_price','description','is_active'])
const ALLOWED_ORDER_COLS   = new Set(['driver_id','status','cancel_reason','accepted_at','arrived_at','completed_at','cancelled_at','is_free'])

const safeSet = (updates, allowed) => {
  const keys = Object.keys(updates).filter(k => allowed.has(k))
  if (!keys.length) throw new Error('No valid columns to update')
  return { keys, vals: keys.map(k => updates[k]) }
}

module.exports = {
  ALLOWED_USER_COLS,
  ALLOWED_DRIVER_COLS,
  ALLOWED_TARIFF_COLS,
  ALLOWED_ORDER_COLS,
  safeSet,
}
