require('dotenv').config();
const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 });

async function main() {
  const r = await db.query(`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_name = 'addresses'
    ORDER BY ordinal_position
  `);
  if (r.rows.length === 0) {
    console.log('TABLE addresses does NOT exist');
  } else {
    console.log('addresses columns:', JSON.stringify(r.rows, null, 2));
    const cnt = await db.query('SELECT COUNT(*) FROM addresses');
    console.log('Row count:', cnt.rows[0].count);
  }
  await db.end();
}
main().catch(e => { console.error(e.message); process.exit(1); });
