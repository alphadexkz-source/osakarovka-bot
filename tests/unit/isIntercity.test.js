'use strict'

// Мокаем все зависимости clientOrderHandler с DB/сетью
jest.mock('../../src/db/queries', () => ({
  getTariffs: jest.fn(), getUser: jest.fn(), getSession: jest.fn(),
  setSession: jest.fn(), getActiveOrderByClient: jest.fn(), getSetting: jest.fn(),
}))
jest.mock('../../src/whatsapp/greenApi', () => ({
  sendText: jest.fn(), sendButtons: jest.fn(), sendImage: jest.fn(),
}))
jest.mock('../../src/modules/orderEngine', () => ({}))
jest.mock('../../src/modules/chatRelay', () => ({}))
jest.mock('../../src/modules/tariffEngine', () => ({ getPrice: jest.fn(), norm: jest.fn() }))
jest.mock('../../src/modules/addressDetector', () => ({ isAddress: jest.fn(), resolveAddress: jest.fn() }))
jest.mock('../../src/modules/smartReply', () => ({ parseScheduleTime: jest.fn(), getGroqReply: jest.fn() }))
jest.mock('../../src/modules/voiceRecognizer', () => ({ recognizeVoice: jest.fn() }))
jest.mock('../../src/modules/favoriteAddresses', () => ({}))
jest.mock('../../src/modules/testLogger', () => ({ clientTest: jest.fn(), driverTest: jest.fn() }))
jest.mock('../../src/logger', () => ({
  warn: jest.fn(), error: jest.fn(), info: jest.fn(),
  msg: jest.fn(), order: jest.fn(), driver: jest.fn(),
  initFileLogging: jest.fn(),
}))

const { isIntercity, isCancel, isConfirm, INTERCITY } = require('../../src/handlers/clientOrderHandler')

// ─── isIntercity() ───────────────────────────────────────────────

describe('isIntercity()', () => {
  describe('города Казахстана', () => {
    test('темиртау', () => expect(isIntercity('темиртау')).toBe(true))
    test('астана (прямая)', () => expect(isIntercity('астана')).toBe(true))
    test('в Астану (падеж)', () => expect(isIntercity('в Астану')).toBe(true))
    test('до Астаны (падеж)', () => expect(isIntercity('до Астаны')).toBe(true))
    test('в Астане (падеж)', () => expect(isIntercity('в Астане')).toBe(true))
    test('Нур-Султан', () => expect(isIntercity('Нур-Султан')).toBe(true))
    test('нурсултан', () => expect(isIntercity('нурсултан')).toBe(true))
    test('Карагандa (вариант)', () => expect(isIntercity('Карагандa')).toBe(true))
    test('карагандинск', () => expect(isIntercity('карагандинск')).toBe(true))
    test('Балхаш', () => expect(isIntercity('балхаш')).toBe(true))
    test('до Балхаша', () => expect(isIntercity('до Балхаша')).toBe(true))
    test('алматы', () => expect(isIntercity('алматы')).toBe(true))
    test('семей', () => expect(isIntercity('семей')).toBe(true))
    test('до Семея', () => expect(isIntercity('до Семея')).toBe(true))
    test('жезказган', () => expect(isIntercity('жезказган')).toBe(true))
  })

  describe('сёла Осакаровского района', () => {
    test('карагайлы', () => expect(isIntercity('карагайлы')).toBe(true))
    test('октябрьское', () => expect(isIntercity('октябрьское')).toBe(true))
    test('тельманское', () => expect(isIntercity('тельманское')).toBe(true))
    test('садовое', () => expect(isIntercity('садовое')).toBe(true))
    test('николаевка', () => expect(isIntercity('николаевка')).toBe(true))
    test('ошаганды', () => expect(isIntercity('ошаганды')).toBe(true))
    test('шункыркол', () => expect(isIntercity('шункыркол')).toBe(true))
    test('приишимское', () => expect(isIntercity('приишимское')).toBe(true))
    test('батпакты', () => expect(isIntercity('батпакты')).toBe(true))
    test('есиль', () => expect(isIntercity('есиль')).toBe(true))
    test('в Есиль (с предлогом)', () => expect(isIntercity('в есиль')).toBe(true))
  })

  describe('обычные адреса посёлка — НЕ межгород', () => {
    test('алаш 15', () => expect(isIntercity('алаш 15')).toBe(false))
    test('больница', () => expect(isIntercity('больница')).toBe(false))
    test('рынок', () => expect(isIntercity('рынок')).toBe(false))
    test('магазин барс', () => expect(isIntercity('магазин барс')).toBe(false))
    test('первомайская 33', () => expect(isIntercity('первомайская 33')).toBe(false))
    test('жд станция', () => expect(isIntercity('жд станция')).toBe(false))
    test('акимат', () => expect(isIntercity('акимат')).toBe(false))
    test('стадион', () => expect(isIntercity('стадион')).toBe(false))
  })

  describe('регистронезависимость', () => {
    test('ТЕМИРТАУ', () => expect(isIntercity('ТЕМИРТАУ')).toBe(true))
    test('В АСТАНУ', () => expect(isIntercity('В АСТАНУ')).toBe(true))
    test('Карагайлы', () => expect(isIntercity('Карагайлы')).toBe(true))
  })
})

// ─── isCancel() ──────────────────────────────────────────────────

describe('isCancel()', () => {
  test('"нет" → true (exact)', () => expect(isCancel('нет')).toBe(true))
  test('"жок" → true (exact)', () => expect(isCancel('жок')).toBe(true))
  test('"стоп" → true (exact)', () => expect(isCancel('стоп')).toBe(true))
  test('"нет." → true (exact)', () => expect(isCancel('нет.')).toBe(true))
  test('"отмена" → true (contains)', () => expect(isCancel('отмена')).toBe(true))
  test('"хочу отменить" → true', () => expect(isCancel('хочу отменить')).toBe(true))
  test('"не надо" → true', () => expect(isCancel('не надо')).toBe(true))
  test('"назад" → true', () => expect(isCancel('назад')).toBe(true))
  test('"cancel" → true', () => expect(isCancel('cancel')).toBe(true))

  test('"да" → false', () => expect(isCancel('да')).toBe(false))
  test('"поехали" → false', () => expect(isCancel('поехали')).toBe(false))
  test('"алаш 15" → false', () => expect(isCancel('алаш 15')).toBe(false))
  // "автостоп" не совпадает с exact 'стоп' и не contains CANCEL_CONTAINS
  test('"автостоп" → false', () => expect(isCancel('автостоп')).toBe(false))
})

// ─── isConfirm() ─────────────────────────────────────────────────

describe('isConfirm()', () => {
  test('"да" → true', () => expect(isConfirm('да')).toBe(true))
  test('"ok" → true', () => expect(isConfirm('ok')).toBe(true))
  test('"ок" → true', () => expect(isConfirm('ок')).toBe(true))
  test('"поехали" → true', () => expect(isConfirm('поехали')).toBe(true))
  test('"подтверждаю" → true', () => expect(isConfirm('подтверждаю')).toBe(true))
  test('"ия" → true', () => expect(isConfirm('ия')).toBe(true))

  // Частичные совпадения НЕ должны срабатывать (exact match)
  test('"да нет наверное" → false', () => expect(isConfirm('да нет наверное')).toBe(false))
  test('"нет" → false', () => expect(isConfirm('нет')).toBe(false))
  test('"откажусь" → false', () => expect(isConfirm('откажусь')).toBe(false))
})
