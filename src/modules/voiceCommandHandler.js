'use strict'

const { recognizeVoice } = require('./voiceRecognizer')
const log = require('../logger')

/**
 * Транскрибирует голосовое сообщение и возвращает текст.
 * Централизованная обёртка избавляет clientHandler и driverHandler от дублирования
 * обработки ошибок и min-length фильтрации.
 * @param {string} mediaUrl - URL аудиофайла
 * @param {string} phone - телефон пользователя (для логирования)
 * @returns {Promise<string|null>} распознанный текст или null
 */
const transcribe = async (mediaUrl, phone) => {
  if (!mediaUrl) return null
  try {
    const text = await recognizeVoice(mediaUrl, phone)
    return text?.length >= 2 ? text : null
  } catch (err) {
    log.error('voiceCommandHandler', err, { phone })
    return null
  }
}

module.exports = { transcribe }
