// Запускается при старте сессии Claude Code
// Читает pending задачи из agent_tasks и выводит их в контекст
'use strict'
const path = require('path')
require('dotenv').config({ path: path.join(process.env.CLAUDE_PROJECT_DIR || '.', '.env') })
const { Pool } = require(path.join(process.env.CLAUDE_PROJECT_DIR || '.', 'node_modules', 'pg'))

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, family: 4 })
  try {
    const r = await pool.query(
      "SELECT id, description, created_at FROM agent_tasks WHERE status='pending' ORDER BY created_at LIMIT 10"
    )
    if (r.rows.length > 0) {
      const list = r.rows.map(t => `  #${t.id}: ${t.description}`).join('\n')
      process.stdout.write(`\n📋 PENDING TASKS FROM TELEGRAM (${r.rows.length}):\n${list}\n`)
    }
  } catch(_) {
    // тихо, если БД недоступна
  } finally {
    await pool.end().catch(() => {})
  }
}
main()
