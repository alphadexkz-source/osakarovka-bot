const db = require('../index')

const getSession = async (phone) => {
  const r = await db.query('SELECT * FROM sessions WHERE phone=$1', [phone])
  return r.rows[0]
}

const setSession = async (phone, state, ctx = {}) => {
  await db.query(
    `INSERT INTO sessions(phone,state,ctx,updated_at) VALUES($1,$2,$3,NOW())
     ON CONFLICT(phone) DO UPDATE SET state=EXCLUDED.state,ctx=EXCLUDED.ctx,updated_at=NOW()`,
    [phone, state, JSON.stringify(ctx)]
  )
}

const clearSession = async (phone) => setSession(phone, 'idle', {})

module.exports = {
  getSession,
  setSession,
  clearSession,
}
