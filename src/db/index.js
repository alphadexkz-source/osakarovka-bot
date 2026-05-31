require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  family: 4,
});

pool.on('error', (err) => console.error('DB error:', err.message));
module.exports = { query: (t,p) => pool.query(t,p), getClient: () => pool.connect() };
