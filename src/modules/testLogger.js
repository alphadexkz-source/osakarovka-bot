'use strict'
const fs   = require('fs')
const path = require('path')

const LOG_DIR  = path.join(__dirname, '../../logs')
const TEST_LOG = path.join(LOG_DIR, 'test_session.log')

const logTestEvent = (phone, role, event, details = '', extra = {}) => {
  const time = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })
  const line = `[${time}] [${role.toUpperCase()}] ${phone} | ${event} | ${details} ${JSON.stringify(extra)}\n`
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
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
    return fs.readFileSync(TEST_LOG, 'utf8')
  } catch (e) {
    return 'Ошибка чтения тестового лога.'
  }
}

module.exports = { clientTest, driverTest, suspicious, getTestReport, logTestEvent }
