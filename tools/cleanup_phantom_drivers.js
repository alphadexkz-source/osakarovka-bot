require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 });

async function main() {
  // Show incomplete driver records
  const show = await db.query(`
    SELECT u.phone, u.role, d.full_name, d.car_plate, s.state, s.updated_at
    FROM users u
    LEFT JOIN drivers d ON d.user_id = u.id
    LEFT JOIN sessions s ON s.phone = u.phone
    WHERE u.role = 'driver' AND (d.full_name IS NULL OR d.car_plate IS NULL)
    ORDER BY u.id DESC LIMIT 20
  `);
  console.log('Incomplete drivers:', JSON.stringify(show.rows, null, 2));

  // Reset abandoned: role=driver + reg_* state > 0 mins (force cleanup now)
  const fixed = await db.query(`
    UPDATE users u SET role='client'
    FROM sessions s
    WHERE s.phone = u.phone
      AND u.role = 'driver'
      AND s.state LIKE 'reg_%'
    RETURNING u.phone, s.state
  `);
  console.log('Reset to client:', JSON.stringify(fixed.rows, null, 2));

  // Also reset sessions
  if (fixed.rows.length) {
    const phones = fixed.rows.map(r => r.phone);
    await db.query(`UPDATE sessions SET state='idle', ctx='{}' WHERE phone = ANY($1)`, [phones]);
    console.log('Sessions cleared for:', phones.join(', '));
  }

  await db.end();
}

main().catch(e => { console.error(e.message); process.exit(1); });
