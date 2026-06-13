'use strict'
/**
 * Извлечение участников из WhatsApp-групп и импорт в базу клиентов.
 *
 * Запуск:
 *   node tools/import_group_members.js         — показать все группы
 *   node tools/import_group_members.js --import  — показать группы + импортировать из всех
 *   node tools/import_group_members.js --id 111111111-1111111111@g.us  — только одна группа
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const axios  = require('axios')
const { Pool } = require('pg')

const ID    = process.env.GREEN_API_ID
const TOKEN = process.env.GREEN_API_TOKEN
const BASE  = `https://api.green-api.com/waInstance${ID}`

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  max: 5,
})

// ─── Green API helpers ────────────────────────────────────────

const getChats = async () => {
  const res = await axios.get(`${BASE}/getChats/${TOKEN}`, { timeout: 15000 })
  return res.data || []
}

const getGroupData = async (groupId) => {
  const res = await axios.post(`${BASE}/getGroupData/${TOKEN}`,
    { groupId },
    { timeout: 15000 }
  )
  return res.data || {}
}

// ─── DB helpers ───────────────────────────────────────────────

const upsertClient = async (phone, name) => {
  const clean = phone.replace(/\D/g, '').replace(/@.*/, '')
  if (!clean || clean.length < 10 || clean.length > 15) return 'skip'
  try {
    const r = await db.query(
      `INSERT INTO users (phone, name, role)
       VALUES ($1, $2, 'client')
       ON CONFLICT (phone) DO NOTHING
       RETURNING phone`,
      [clean, name || null]
    )
    return r.rowCount > 0 ? 'inserted' : 'exists'
  } catch (e) {
    return `error: ${e.message.slice(0, 60)}`
  }
}

// ─── Main ─────────────────────────────────────────────────────

const main = async () => {
  const args     = process.argv.slice(2)
  const doImport = args.includes('--import')
  const singleId = args.includes('--id') ? args[args.indexOf('--id') + 1] : null

  console.log('📋 Получаю список чатов из Green API...')
  const chats = await getChats()

  const groups = chats.filter(c => c.id?.endsWith('@g.us'))
  console.log(`\n✅ Найдено групп: ${groups.length}\n`)

  if (!groups.length) {
    console.log('❌ Групп нет. Убедитесь что бот добавлен в группы.')
    await db.end()
    return
  }

  // Показываем список групп
  for (const g of groups) {
    console.log(`  📌 ${g.name || '(без названия)'}`)
    console.log(`     ID: ${g.id}`)
    if (g.lastMessage?.timestamp) {
      const d = new Date(g.lastMessage.timestamp * 1000)
      console.log(`     Последнее сообщение: ${d.toLocaleString('ru-RU')}`)
    }
    console.log()
  }

  const targetGroups = singleId
    ? groups.filter(g => g.id === singleId)
    : groups

  if (!doImport && !singleId) {
    console.log('ℹ️  Чтобы импортировать участников:')
    console.log('   node tools/import_group_members.js --import')
    console.log('   node tools/import_group_members.js --id <group_id>')
    await db.end()
    return
  }

  // Импорт участников
  let totalInserted = 0
  let totalExists   = 0
  let totalSkipped  = 0

  for (const g of targetGroups) {
    console.log(`\n🔍 Загружаю участников группы: ${g.name || g.id}`)
    let data
    try {
      data = await getGroupData(g.id)
    } catch (e) {
      console.log(`  ❌ Ошибка: ${e.message}`)
      continue
    }

    const participants = data.participants || []
    console.log(`   Участников: ${participants.length}`)

    for (const p of participants) {
      // p.id = "79001234567@c.us", p.name = "Имя" (если есть)
      const phone  = (p.id || '').replace('@c.us', '')
      const name   = p.contactName || p.name || null
      const result = await upsertClient(phone, name)

      if      (result === 'inserted') { totalInserted++; process.stdout.write('.') }
      else if (result === 'exists')   { totalExists++;   process.stdout.write('·') }
      else                            { totalSkipped++;  process.stdout.write('x') }
    }
    console.log()
  }

  console.log(`\n${'─'.repeat(40)}`)
  console.log(`✅ Новых клиентов добавлено: ${totalInserted}`)
  console.log(`ℹ️  Уже были в базе:          ${totalExists}`)
  console.log(`⚠️  Пропущено (некорр. номер): ${totalSkipped}`)
  console.log(`${'─'.repeat(40)}`)

  if (totalInserted > 0) {
    const r = await db.query("SELECT COUNT(*) FROM users WHERE role='client'")
    console.log(`\n📊 Всего клиентов в базе: ${r.rows[0].count}`)
  }

  await db.end()
}

main().catch(e => {
  console.error('Fatal:', e.message)
  process.exit(1)
})
