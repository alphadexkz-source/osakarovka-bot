'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../logs');
const MAX_SIZE = 512 * 1024; // 500 KB — ротация

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Время в Алматы
const ts = () => new Date().toLocaleString('ru-RU', {
  timeZone: 'Asia/Almaty',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).replace(',', '');

// Запись в конкретный файл с ротацией
const writeToFile = (filename, level, args) => {
  try {
    const file = path.join(LOG_DIR, filename);
    try {
      if (fs.statSync(file).size > MAX_SIZE) {
        const date = new Date().toISOString().slice(0, 10);
        fs.renameSync(file, path.join(LOG_DIR, `${filename.replace('.log','')}.${date}.log`));
      }
    } catch {}

    const text = args.map(a => {
      if (a === null || a === undefined) return String(a);
      if (typeof a === 'object') {
        try { return JSON.stringify(a).slice(0, 300); } catch { return String(a); }
      }
      return String(a).slice(0, 400);
    }).join(' ');

    fs.appendFileSync(file, `${ts()} ${level.padEnd(5)} ${text}\n`);
  } catch {}
};

// ─── Патчим console.error/warn → errors.log ───────────────────
const _origError = console.error.bind(console);
console.error = (...args) => {
  _origError(...args);
  writeToFile('errors.log', 'ERROR', args);
};

const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  _origWarn(...args);
  writeToFile('errors.log', 'WARN ', args);
};

// ─── Форматтер структурированных логов ───────────────────────
const fmt = (level, module, data) => {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n').slice(0, 120)}`);
  return `${ts()} ${level.padEnd(5)} [${module}] ${parts.join(' ')}`;
};

const log = {
  // Входящее сообщение
  msg: (phone, role, state, type, text) =>
    console.log(fmt('INFO', 'MSG', { phone, role, state, type, text: text?.slice(0, 60) })),

  // Событие заказа → stdout + orders.log
  order: (action, data) => {
    const line = fmt('INFO', 'ORDER', { action, ...data });
    console.log(line);
    writeToFile('orders.log', 'ORDER', [line]);
  },

  // Смена статуса водителя
  driver: (phone, action, extra = {}) =>
    console.log(fmt('INFO', 'DRIVER', { phone, action, ...extra })),

  // Groq вызов
  groq: (module, action, extra = {}) =>
    console.log(fmt('INFO', 'GROQ', { module, action, ...extra })),

  // Голосовое сообщение → stdout + voice-commands.log
  voice: (phone, status, extra = {}) => {
    const line = fmt('INFO', 'VOICE', { phone, status, ...extra });
    console.log(line);
    writeToFile('voice-commands.log', 'VOICE', [line]);
  },

  // Предупреждение → stdout + errors.log (через патч)
  warn: (module, msg, extra = {}) =>
    console.warn(fmt('WARN', module, { msg, ...extra })),

  // Ошибка → stdout + errors.log (через патч)
  error: (module, err, extra = {}) =>
    console.error(fmt('ERROR', module, {
      msg: err?.message || String(err),
      ...extra,
    })),
};

module.exports = log;
