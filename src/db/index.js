require('dotenv').config({ path: require('path').join(__dirname, '../../.env') })
const { Pool } = require('pg')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  ssl: { rejectUnauthorized: false },
  family: 4,
})

pool.on('error', (err) => {
  console.error('[DB Pool Error]', err.message)
})

// Проверяем подключение при старте с 3 попытками
const connectWithRetry = async (attempts = 3, delayMs = 2000) => {
  for (let i = 1; i <= attempts; i++) {
    try {
      const client = await pool.connect()
      client.release()
      console.log('[DB] Connected to PostgreSQL')
      return
    } catch (err) {
      console.error(`[DB] Connection attempt ${i}/${attempts} failed:`, err.message)
      if (i < attempts) await new Promise(r => setTimeout(r, delayMs))
    }
  }
  console.error('[DB] All connection attempts failed — continuing with pool (queries will retry)')
}

connectWithRetry()

module.exports = {
  query: (t, p) => pool.query(t, p),
  getClient: () => pool.connect(),
  end: () => pool.end(),
}
