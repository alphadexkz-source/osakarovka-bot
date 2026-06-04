'use strict'
const fs   = require('fs')
const path = require('path')

const LOG_DIR  = path.join(__dirname, '../../logs')
const TEST_LOG = path.join(LOG_DIR, 'test_session.log')
const MAX_SIZE = 10 * 1024 * 1024 // 10 MB

const logTestEvent = (phone, role, event, details = '', extra = {}) => {
  const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
  const line = `[${time}] [${role.toUpperCase()}] ${phone} | ${event} | ${details} ${JSON.stringify(extra)}\n`
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
    try {
      if (fs.statSync(TEST_LOG).size > MAX_SIZE) {
        const date = new Date().toISOString().slice(0, 10)
        fs.renameSync(TEST_LOG, path.join(LOG_DIR, `test_session.${date}.log`))
      }
    } catch {}
    fs.appendFileSync(TEST_LOG, line)
    console.log(`[TEST] ${role} ${phone} → ${event}`)
  } catch (e) {}
}

const clientTest  = (phone, event, details = '') => logTestEvent(phone, 'CLIENT', event, details)
const driverTest  = (phone, event, details = '') => logTestEvent(phone, 'DRIVER', event, details)
const suspicious  = (phone, role, reason)        => logTestEvent(phone, role, '⚠️ SUSPICIOUS', reason)

const getTestReport = () => {
  try {
    if (!fs.existsSync(TEST_LOG)) return 'Сегодня тестов не было.'
    const content = fs.readFileSync(TEST_LOG, 'utf8')
    // Последние 3000 символов — чтобы влезло в WhatsApp
    return content.slice(-3000) || 'Файл пуст.'
  } catch (e) {
    return 'Ошибка чтения тестового лога.'
  }
}

module.exports = { clientTest, driverTest, suspicious, getTestReport, logTestEvent }
