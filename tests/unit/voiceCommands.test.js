'use strict'

const { detectVoiceIntent, isVoiceCancel } = require('../../src/modules/voiceCommands')

describe('isVoiceCancel()', () => {
  test('"нет" → cancel', () => expect(isVoiceCancel('нет')).toBe(true))
  test('"Нет!" → cancel', () => expect(isVoiceCancel('Нет!')).toBe(true))
  // 'стоп' убран из CANCEL_WORDS → теперь go_offline, не cancel (BUG-08 полный фикс)
  test('"стоп" → НЕ cancel (идёт в go_offline)', () => expect(isVoiceCancel('стоп')).toBe(false))
  test('"отмена" → cancel', () => expect(isVoiceCancel('отмена')).toBe(true))
  test('"отменить заказ" → cancel', () => expect(isVoiceCancel('отменить заказ')).toBe(true))
  test('"жоқ" → cancel', () => expect(isVoiceCancel('жоқ')).toBe(true))

  // BUG-08: "стоп" не должен срабатывать как часть другого слова
  test('"автостоп" → НЕ cancel (BUG-08)', () => expect(isVoiceCancel('автостоп')).toBe(false))
  test('"полустоп" → НЕ cancel', () => expect(isVoiceCancel('полустоп')).toBe(false))

  test('"да" → не cancel', () => expect(isVoiceCancel('да')).toBe(false))
  test('"поехали" → не cancel', () => expect(isVoiceCancel('поехали')).toBe(false))
  test('"принял" → не cancel', () => expect(isVoiceCancel('принял')).toBe(false))
  test('пустая строка → false', () => expect(isVoiceCancel('')).toBe(false))
  test('null → false', () => expect(isVoiceCancel(null)).toBe(false))
})

describe('detectVoiceIntent()', () => {
  // Клиентские интенты
  test('"да" → confirm', () => {
    expect(detectVoiceIntent('да').intent).toBe('confirm')
  })

  test('"Да, поехали!" → confirm', () => {
    expect(detectVoiceIntent('Да, поехали!').intent).toBe('confirm')
  })

  test('"нет" → cancel', () => {
    expect(detectVoiceIntent('нет').intent).toBe('cancel')
  })

  test('"отмена" → cancel', () => {
    expect(detectVoiceIntent('отмена').intent).toBe('cancel')
  })

  // Водительские интенты
  test('"прибыл" → arrived', () => {
    expect(detectVoiceIntent('прибыл').intent).toBe('arrived')
  })

  test('"на месте, жду" → arrived', () => {
    expect(detectVoiceIntent('на месте, жду').intent).toBe('arrived')
  })

  test('"свободен" → complete', () => {
    expect(detectVoiceIntent('свободен').intent).toBe('complete')
  })

  test('"доехали" → complete', () => {
    expect(detectVoiceIntent('доехали').intent).toBe('complete')
  })

  test('"принял" → accept_order', () => {
    expect(detectVoiceIntent('принял').intent).toBe('accept_order')
  })

  test('"аламын" → accept_order', () => {
    expect(detectVoiceIntent('аламын').intent).toBe('accept_order')
  })

  test('"ложный" → false_call', () => {
    expect(detectVoiceIntent('ложный').intent).toBe('false_call')
  })

  test('"нет клиента" → false_call', () => {
    expect(detectVoiceIntent('нет клиента').intent).toBe('false_call')
  })

  test('"пропустить" → skip', () => {
    expect(detectVoiceIntent('пропустить').intent).toBe('skip')
  })

  test('"на линию" → go_online', () => {
    expect(detectVoiceIntent('на линию').intent).toBe('go_online')
  })

  test('"выхожу на линию" → go_online', () => {
    expect(detectVoiceIntent('выхожу на линию').intent).toBe('go_online')
  })

  // BUG-08: "стоп" → go_offline, не cancel
  test('"стоп" → go_offline (не cancel, BUG-08)', () => {
    expect(detectVoiceIntent('стоп').intent).toBe('go_offline')
  })

  test('"офлайн" → go_offline', () => {
    expect(detectVoiceIntent('офлайн').intent).toBe('go_offline')
  })

  // BUG-09: "аяқтадым" голосом
  test('"аяқтадым" → go_offline (BUG-09)', () => {
    expect(detectVoiceIntent('аяқтадым').intent).toBe('go_offline')
  })

  test('"статистика" → stats', () => {
    expect(detectVoiceIntent('статистика').intent).toBe('stats')
  })

  test('"қанша" → stats', () => {
    expect(detectVoiceIntent('қанша').intent).toBe('stats')
  })

  test('неизвестный текст → unknown', () => {
    expect(detectVoiceIntent('бла бла бла xyz 123').intent).toBe('unknown')
  })

  test('пустая строка → unknown', () => {
    expect(detectVoiceIntent('').intent).toBe('unknown')
  })

  test('null → unknown', () => {
    expect(detectVoiceIntent(null).intent).toBe('unknown')
  })

  // Проверяем что intent возвращает нормализованный text
  test('возвращает нормализованный text', () => {
    const result = detectVoiceIntent('Принял!')
    expect(result.intent).toBe('accept_order')
    expect(result.text).toBe('принял')
  })
})
