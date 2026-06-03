'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  family: 4,
  max: 3,
});

// ─── ДОЛГОСРОЧНАЯ ПАМЯТЬ ──────────────────────────────────────

// Сохранить/обновить факт в памяти
const remember = async (category, key, content, importance = 5) => {
  await db.query(
    `INSERT INTO agent_memory(category, key, content, importance, source)
     VALUES($1,$2,$3,$4,'agent')
     ON CONFLICT(category, key)
     DO UPDATE SET content=EXCLUDED.content, importance=EXCLUDED.importance, updated_at=NOW()`,
    [category, key.slice(0, 200), content.slice(0, 2000), importance]
  );
};

// Получить всю память (важные сначала)
const getAll = async () => {
  const r = await db.query(
    `SELECT category, key, content, importance FROM agent_memory
     WHERE (expires_at IS NULL OR expires_at > NOW())
     ORDER BY importance DESC, updated_at DESC LIMIT 50`
  );
  return r.rows;
};

// Поиск по тексту
const search = async (query) => {
  const r = await db.query(
    `SELECT category, key, content FROM agent_memory
     WHERE (content ILIKE $1 OR key ILIKE $1)
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY importance DESC LIMIT 10`,
    ['%' + query + '%']
  );
  return r.rows;
};

// Удалить из памяти по ключевому слову
const forget = async (keyword) => {
  const r = await db.query(
    `DELETE FROM agent_memory WHERE key ILIKE $1 OR content ILIKE $1 RETURNING key`,
    ['%' + keyword + '%']
  );
  return r.rows.length;
};

// ─── ИСТОРИЯ РАЗГОВОРОВ ───────────────────────────────────────

const addMessage = async (role, content) => {
  await db.query(
    'INSERT INTO agent_conversations(role, content) VALUES($1,$2)',
    [role, content.slice(0, 4000)]
  );
  // Чистить старые (оставлять только 300)
  await db.query(
    `DELETE FROM agent_conversations WHERE id NOT IN (
       SELECT id FROM agent_conversations ORDER BY created_at DESC LIMIT 300
     )`
  ).catch(() => {});
};

const getHistory = async (limit = 20) => {
  const r = await db.query(
    `SELECT role, content FROM (
       SELECT role, content, created_at
       FROM agent_conversations
       ORDER BY created_at DESC LIMIT $1
     ) sub ORDER BY created_at ASC`,
    [limit]
  );
  return r.rows;
};

// ─── ЗАДАЧИ ДЛЯ CLAUDE ───────────────────────────────────────

const saveTask = async (userRequest, claudeTask) => {
  await db.query(
    `INSERT INTO agent_tasks(type, description, status)
     VALUES('claude_task', $1, 'pending')`,
    [('ЗАПРОС: ' + userRequest.slice(0, 300) + '\n\nЗАДАЧА:\n' + claudeTask).slice(0, 4000)]
  );
};

const getRecentTasks = async (limit = 10) => {
  const r = await db.query(
    'SELECT id, description, status, created_at FROM agent_tasks ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return r.rows;
};

module.exports = { remember, getAll, search, forget, addMessage, getHistory, saveTask, getRecentTasks, db };
