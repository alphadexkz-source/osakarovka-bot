'use strict';

// Форматирует время в Asia/Almaty (UTC+5)
const ts = () => new Date().toLocaleString('ru-RU', {
  timeZone: 'Asia/Almaty',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
}).replace(',', '');

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

  // Событие заказа
  order: (action, data) =>
    console.log(fmt('INFO', 'ORDER', { action, ...data })),

  // Смена статуса водителя
  driver: (phone, action, extra = {}) =>
    console.log(fmt('INFO', 'DRIVER', { phone, action, ...extra })),

  // Groq вызов
  groq: (module, action, extra = {}) =>
    console.log(fmt('INFO', 'GROQ', { module, action, ...extra })),

  // Предупреждение
  warn: (module, msg, extra = {}) =>
    console.warn(fmt('WARN', module, { msg, ...extra })),

  // Ошибка — самое важное для анализа багов
  error: (module, err, extra = {}) =>
    console.error(fmt('ERROR', module, {
      msg: err?.message || String(err),
      ...extra,
    })),
};

module.exports = log;
