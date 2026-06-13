require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 });

db.query(`
  SELECT u.phone, u.role, d.full_name, d.car_plate, d.car_make, d.status, d.last_activity
  FROM users u JOIN drivers d ON d.user_id = u.id
  ORDER BY d.id DESC LIMIT 30
`).then(r => {
  r.rows.forEach(row => console.log(JSON.stringify(row)));
  db.end();
}).catch(e => { console.error(e.message); db.end(); });
