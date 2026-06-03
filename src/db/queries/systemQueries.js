'use strict'
const db = require('../index')

// Проверить и зарегистрировать message ID (атомарно через INSERT ... ON CONFLICT).
// Возвращает true если это дубль (уже существует), false если новое.
const isDuplicateMessage = async (msgId) => {
  try {
    const r = await db.query(
      `INSERT INTO message_dedup(msg_id) VALUES($1)
       ON CONFLICT(msg_id) DO NOTHING
       RETURNING msg_id`,
      [msgId]
    )
    return r.rows.length === 0 // 0 строк = конфликт = дубль
  } catch {
    return false // При ошибке БД — не блокируем
  }
}

// Загрузить недавние IDs (для preload при старте)
const getRecentMessageIds = async (withinMinutes = 60) => {
  const r = await db.query(
    `SELECT msg_id FROM message_dedup
     WHERE received_at > NOW() - make_interval(mins => $1::int)`,
    [withinMinutes]
  )
  return r.rows.map(row => row.msg_id)
}

// Очистить старые записи (> 2 часа)
const cleanupMessageDedup = async () => {
  await db.query(
    `DELETE FROM message_dedup WHERE received_at < NOW() - INTERVAL '2 hours'`
  )
}

module.exports = { isDuplicateMessage, getRecentMessageIds, cleanupMessageDedup }
