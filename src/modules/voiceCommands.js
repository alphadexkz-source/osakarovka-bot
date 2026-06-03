'use strict'

const { normalizeVoice, containsAny } = require('./voiceUtils')

const COMMANDS = {
  // ─── Клиентские ──────────────────────────────────────────────
  CONFIRM: ['да', 'ок', 'окей', 'yes', 'поехали', 'подтверждаю', 'конечно', 'ага', 'иә', 'ия', 'добро', 'хорошо', 'верно'],
  CANCEL:  ['нет', 'не', 'отмена', 'отменить', 'не надо', 'стоп', 'жоқ', 'жок', 'отказ'],

  // ─── Водительские ────────────────────────────────────────────
  ONLINE:  ['на линию', 'выхожу', 'начинаю', 'работаю', 'онлайн', 'старт', 'линияға шығам', 'шығамын', 'приступаю'],
  OFFLINE: ['с линии', 'ухожу', 'заканчиваю', 'офлайн', 'стоп', 'отдых', 'линиядан', 'хватит'],
  ACCEPT:  ['принял', 'принять', 'беру', 'ok', 'ок', 'да', 'иду', 'еду', 'қабылдадым', 'аламын'],
  ARRIVED: ['прибыл', 'приехал', 'на месте', 'подъехал', 'жду', 'стою', 'келдім', 'жеттім'],
  DONE:    ['свободен', 'завершил', 'готово', 'доехали', 'свободна', 'бостымын', 'довёз'],
  FALSE:   ['ложный', 'нет клиента', 'пусто', 'жалған', 'клиента нет'],
  SKIP:    ['пропустить', 'пропуск', 'следующий', 'откізу'],
  STATS:   ['статистика', 'стат', 'итоги', 'заработок', 'қанша', 'сколько заработал'],
}

/**
 * Определяет голосовой интент по тексту транскрипции.
 * Возвращает { intent, text } где text — нормализованный текст.
 *
 * Порядок важен: CANCEL проверяется после CONFIRM чтобы «да нет наверное»
 * давало 'unknown', а не срабатывало на частичное «нет».
 *
 * @param {string} text — сырой текст от Whisper
 * @returns {{ intent: string, text: string }}
 */
const detectVoiceIntent = (text) => {
  if (!text) return { intent: 'unknown', text: '' }
  const normalized = normalizeVoice(text)

  // Клиентские — подтверждение имеет приоритет над отменой
  if (containsAny(text, COMMANDS.CONFIRM) && !containsAny(text, COMMANDS.CANCEL))
    return { intent: 'confirm', text: normalized }
  if (containsAny(text, COMMANDS.CANCEL))
    return { intent: 'cancel', text: normalized }

  // Водительские — порядок: busy-команды первыми (чтобы 'стоп' не уходил в OFFLINE)
  if (containsAny(text, COMMANDS.ARRIVED))  return { intent: 'arrived',      text: normalized }
  if (containsAny(text, COMMANDS.DONE))     return { intent: 'complete',     text: normalized }
  if (containsAny(text, COMMANDS.FALSE))    return { intent: 'false_call',   text: normalized }
  if (containsAny(text, COMMANDS.ACCEPT))   return { intent: 'accept_order', text: normalized }
  if (containsAny(text, COMMANDS.SKIP))     return { intent: 'skip',         text: normalized }
  if (containsAny(text, COMMANDS.ONLINE))   return { intent: 'go_online',    text: normalized }
  if (containsAny(text, COMMANDS.OFFLINE))  return { intent: 'go_offline',   text: normalized }
  if (containsAny(text, COMMANDS.STATS))    return { intent: 'stats',        text: normalized }

  return { intent: 'unknown', text: normalized }
}

module.exports = { detectVoiceIntent, COMMANDS }
