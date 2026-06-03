'use strict'

/**
 * Нормализует транскрибированный текст для сравнения:
 * знаки препинания → пробел, несколько пробелов → один, trim.
 * @param {string} text
 * @returns {string}
 */
const normalizeVoice = (text) => {
  if (!text) return ''
  return text
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:'"«»—–()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Проверяет что хотя бы одно слово из words встречается в text
 * как отдельное слово (не внутри другого).
 * Покрывает: точное совпадение, начало, конец, середину строки.
 * @param {string} text
 * @param {string[]} words
 * @returns {boolean}
 */
const containsAny = (text, words) => {
  const s = normalizeVoice(text)
  return words.some(w =>
    s === w ||
    s.startsWith(w + ' ') ||
    s.endsWith(' ' + w) ||
    s.includes(' ' + w + ' ')
  )
}

module.exports = { normalizeVoice, containsAny }
