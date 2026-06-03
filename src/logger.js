'use strict';

const fs   = require('fs');
const path = require('path');

const LOG_DIR  = path.join(__dirname, '../logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.log');
const MAX_SIZE = 512 * 1024; // 500 KB — после этого архивируем

// Гарантируем папку logs/
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// Форматирует время в Asia/Almaty (UTC+5)
const ts = () => new Date().toLocaleString('ru-RU', {
  timeZone: 'Asia/Almaty',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).replace(',', '');

// Пишет строку в errors.log с ротацией при превышении размера
const writeToFile = (level, args) => {
  try {
    // Ротация: если файл > MAX_SIZE — переименовываем
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_SIZE) {
        const date = new Date().toISOString().slice(0, 10);
        fs.renameSync(LOG_FILE, path.join(LOG_DIR, `errors.${date}.log`));
      }
    } catch {}

    const text = args.map(a => {
      if (a === null || a === undefined) return String(a);
      if (typeof a === 'object') {
        try { return JSON.stringify(a).slice(0, 300); } catch { return String(a); }
      }
      return String(a).slice(0, 400);
    }).join(' ');

    fs.appendFileSync(LOG_FILE, `${ts()} ${level.padEnd(5)} ${text}\n`);
  } catch {}
};

// ─── Патчим console.error и console.warn ───────────────────────
// Все существующие вызовы console.error/warn в любом модуле
// автоматически попадут в logs/errors.log без изменения кода.
const _origError = console.error.bind(console);
console.error = (...args) => {
  _origError(...args);
  writeToFile('ERROR', args);
};

const _origWarn = console.warn.bind(console);
console.warn = (...args) => {
  _origWarn(...args);
  writeToFile('WARN ', args);
};

// ─── Форматтер для структурированных логов ────────────────────
const fmt = (level, module, data) => {
  const parts = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v).replace(/\n/g, '\\n').slice(0, 120)}`);
  return `${ts()} ${level.padEnd(5)} [${module}] ${parts.join(' ')}`;
};

const log = {
  msg: (phone, role, state, type, text) =>
    console.log(fmt('INFO', 'MSG', { phone, role, state, type, text: text?.slice(0, 60) })),

  order: (action, data) =>
    console.log(fmt('INFO', 'ORDER', { action, ...data })),

  driver: (phone, action, extra = {}) =>
    console.log(fmt('INFO', 'DRIVER', { phone, action, ...extra })),

  groq: (module, action, extra = {}) =>
    console.log(fmt('INFO', 'GROQ', { module, action, ...extra })),

  warn: (module, msg, extra = {}) =>
    console.warn(fmt('WARN', module, { msg, ...extra })),

  // error — пишет и в stderr (PM2) и в logs/errors.log через патч выше
  error: (module, err, extra = {}) =>
    console.error(fmt('ERROR', module, {
      msg: err?.message || String(err),
      ...extra,
    })),
};

module.exports = log;
