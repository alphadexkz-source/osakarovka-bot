require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 });

db.query(`
  UPDATE drivers SET full_name=NULL, car_make=NULL, car_plate=NULL, car_color=NULL, status='offline'
  WHERE user_id=(SELECT id FROM users WHERE phone='77021204331')
`).then(r => {
  console.log('Updated rows:', r.rowCount);
  db.end();
}).catch(e => { console.error(e.message); db.end(); });
