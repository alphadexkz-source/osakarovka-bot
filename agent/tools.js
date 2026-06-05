// Инструменты агента — что он умеет делать
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const Groq = require('groq-sdk');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── СЕРВЕР ──────────────────────────────────────────────────
const ssh = async (command) => {
  try {
    const homeDir = process.env.HOME || '/root';
    const { stdout, stderr } = await execFileAsync(
      'ssh',
      ['-o', 'StrictHostKeyChecking=no',
       '-i', `${homeDir}/.ssh/google_compute_engine`,
       'alphadexkz@34.40.3.202',
       command],
      { timeout: 30000 }
    );
    return { ok: true, output: (stdout + stderr).slice(0, 3000) };
  } catch(e) {
    return { ok: false, output: e.message.slice(0, 500) };
  }
};

const getLogs = async (lines = 50) => {
  return ssh(`pm2 logs osakarovka-bot --lines ${lines} --nostream`);
};

const getErrors = async () => {
  return ssh(`tail -30 ~/.pm2/logs/osakarovka-bot-error.log`);
};

const getBotStatus = async () => {
  return ssh(`pm2 list && pm2 show osakarovka-bot`);
};

const restartBot = async () => {
  return ssh(`cd ~/osakarovka-bot && pm2 restart osakarovka-bot`);
};

const deployBot = async () => {
  return ssh(`cd ~/osakarovka-bot && git pull && npm install --production && pm2 restart osakarovka-bot`);
};

// ─── БАЗА ДАННЫХ ─────────────────────────────────────────────
const { db } = require('./memory');

const queryDB = async (sql, params = []) => {
  try {
    const r = await db.query(sql, params);
    return { ok: true, rows: r.rows, count: r.rowCount };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

const getBotStats = async () => {
  const r = await queryDB(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role='client') AS clients,
      (SELECT COUNT(*) FROM users WHERE role='driver') AS drivers,
      (SELECT COUNT(*) FROM drivers WHERE status='online') AS online,
      (SELECT COUNT(*) FROM orders WHERE created_at::date=CURRENT_DATE) AS today_orders,
      (SELECT COUNT(*) FROM orders WHERE status='completed' AND created_at::date=CURRENT_DATE) AS today_done,
      (SELECT COUNT(*) FROM orders WHERE status='searching') AS searching_now,
      (SELECT COALESCE(SUM(price),0) FROM orders WHERE status='completed' AND created_at::date=CURRENT_DATE) AS today_revenue
  `);
  return r.rows?.[0] || {};
};

// ─── CLAUDE API ───────────────────────────────────────────────
const askClaude = async (question, context = '') => {
  if (!process.env.ANTHROPIC_API_KEY) return 'Claude API key не настроен';
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: (context ? `Контекст проекта:\n${context}\n\n` : '') + question
        }]
      })
    });
    const data = await response.json();
    return data.content?.[0]?.text || 'Нет ответа';
  } catch(e) {
    return 'Claude недоступен: ' + e.message;
  }
};

// ─── GROQ ФУНКЦИЯ ─────────────────────────────────────────────
const askGroq = async (messages, model = 'qwen/qwen3-32b') => {
  const r = await groq.chat.completions.create({
    messages,
    model,
    max_tokens: 1024,
    temperature: 0.3,
  });
  return r.choices[0]?.message?.content || '';
};

// ─── ФАЙЛОВАЯ СИСТЕМА ────────────────────────────────────────
const readFile = async (filePath) => {
  try {
    const fs = require('fs');
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content: content.slice(0, 8000) };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

const writeFile = async (filePath, content) => {
  try {
    const fs = require('fs');
    fs.writeFileSync(filePath, content, 'utf8');
    return { ok: true };
  } catch(e) {
    return { ok: false, error: e.message };
  }
};

// ─── WHATSAPP АЛЕРТ АДМИНИСТРАТОРУ ───────────────────────────
const sendAlert = async (message) => {
  try {
    const r = await queryDB(`SELECT value FROM settings WHERE key='admin_phone'`)
    const adminPhone = r.rows?.[0]?.value
    if (!adminPhone) return { ok: false, error: 'admin_phone не задан в settings' }

    const instanceId = process.env.GREEN_API_ID
    const token = process.env.GREEN_API_TOKEN
    if (!instanceId || !token) return { ok: false, error: 'GREEN_API не настроен' }

    const chatId = adminPhone.replace(/\D/g, '') + '@c.us'
    const res = await fetch(
      `https://api.green-api.com/waInstance${instanceId}/sendMessage/${token}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId, message: `🤖 *Hermes Alert*\n\n${message}` }),
        signal: AbortSignal.timeout(10000),
      }
    )
    return { ok: res.ok }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

module.exports = {
  ssh, getLogs, getErrors, getBotStatus, restartBot, deployBot,
  queryDB, getBotStats,
  askClaude, askGroq,
  readFile, writeFile,
  sendAlert,
};
