'use strict'

const { normalizeVoice, containsAny } = require('../../src/modules/voiceUtils')

describe('normalizeVoice()', () => {
  test('lowercase', () => {
    expect(normalizeVoice('Привет')).toBe('привет')
  })

  test('trim spaces', () => {
    expect(normalizeVoice('  привет  ')).toBe('привет')
  })

  test('multiple spaces collapse to one', () => {
    expect(normalizeVoice('я  хочу   такси')).toBe('я хочу такси')
  })

  test('punctuation → space (collapsed)', () => {
    expect(normalizeVoice('Да, поехали!')).toBe('да поехали')
  })

  test('comma and period → space', () => {
    expect(normalizeVoice('нет.')).toBe('нет')
  })

  test('quotes stripped', () => {
    expect(normalizeVoice('"да"')).toBe('да')
  })

  test('empty string', () => {
    expect(normalizeVoice('')).toBe('')
  })

  test('null/undefined → empty string', () => {
    expect(normalizeVoice(null)).toBe('')
    expect(normalizeVoice(undefined)).toBe('')
  })
})

describe('containsAny()', () => {
  test('exact match', () => {
    expect(containsAny('стоп', ['стоп'])).toBe(true)
  })

  test('word at start', () => {
    expect(containsAny('стоп я устал', ['стоп'])).toBe(true)
  })

  test('word at end', () => {
    expect(containsAny('хватит стоп', ['стоп'])).toBe(true)
  })

  test('word in middle', () => {
    expect(containsAny('я стоп сказал', ['стоп'])).toBe(true)
  })

  test('NOT a substring — "стоп" inside "автостоп"', () => {
    expect(containsAny('автостоп', ['стоп'])).toBe(false)
  })

  test('NOT a substring — "нет" inside "привет"', () => {
    expect(containsAny('привет', ['нет'])).toBe(false)
  })

  test('matches any of several words', () => {
    expect(containsAny('принял заказ', ['беру', 'принял', 'аламын'])).toBe(true)
  })

  test('returns false when none match', () => {
    expect(containsAny('случайный текст', ['да', 'нет', 'ок'])).toBe(false)
  })

  test('empty text → false', () => {
    expect(containsAny('', ['стоп'])).toBe(false)
  })

  test('multi-word phrase match', () => {
    expect(containsAny('на линию сейчас', ['на линию'])).toBe(true)
  })
})
