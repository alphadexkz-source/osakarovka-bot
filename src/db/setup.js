require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('./index');

async function setup() {
  console.log('🔧 Creating database schema...');
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('✅ Database ready!');
  process.exit(0);
}

setup().catch(err => {
  console.error('❌ Setup error:', err.message);
  process.exit(1);
});
