const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')
const orderEngine = require('../modules/orderEngine')
const { driverTest } = require('../modules/testLogger')

const KW = {
  ARRIVED: ['прибыл','приехал','на месте','подъехал','жду','стою','стоянка',
             'келдім','жеттім','у клиента','доехал','здесь'],
  DONE:    ['свободен','завершил','готово','доехали','доставил','освободился',
             'бостымын','клиент вышел','довёз','закончили','приехали','всё'],
  FALSE:   ['ложный','нет клиента','никого нет','пусто','ложный вызов','жалған','клиента нет','нет никого'],
  ACCEPT:  ['принял','принять','беру','возьму','ok','ок','да','иду','еду',
             'қабылдадым','аламын','принимаю','берем','принимаем'],
  SKIP:    ['пропустить','пропуск','пропускаю','следующий','откізу','пропусти'],
}

const match = (text, keywords) => keywords.some(w => text.includes(w))

// Обрабатывает команды водителя в поездке. Возвращает true если обработал.
const handleBusyCommands = async (phone, lo, order) => {
  if (match(lo, KW.ARRIVED)) { await orderEngine.arrived(order.id, phone); return true }
  if (match(lo, KW.DONE))    { await orderEngine.complete(order.id, phone); return true }
  if (match(lo, KW.FALSE))   { await orderEngine.falseCall(order.id, phone); return true }
  return false
}

// Обрабатывает принял/пропустил (только если есть pending). Возвращает true если обработал.
const handleAcceptSkip = async (phone, lo) => {
  if (match(lo, KW.ACCEPT)) {
    const pending = await q.getPendingOrderForDriver(phone)
    if (pending) { driverTest(phone, 'Принял заказ'); await orderEngine.accept(pending.id, phone) }
    else await wa.sendText(phone, 'Нет активного предложения.')
    return true
  }
  if (match(lo, KW.SKIP)) {
    await q.moveDriverToEndOfQueue(phone)
    await wa.sendText(phone, 'Пропущено.')
    return true
  }
  return false
}

// Обрабатывает кнопки заказа водителя. Возвращает true если обработал.
const handleOrderButtons = async (phone, buttonId) => {
  if (buttonId.startsWith('accept_')) {
    const r = await orderEngine.accept(parseInt(buttonId.replace('accept_', '')), phone)
    if (r?.error === 'already_taken') await wa.sendText(phone, 'Уже принят другим.')
    else if (r?.error) await wa.sendText(phone, 'Заказ недоступен.')
    return true
  }
  if (buttonId.startsWith('skip_')) {
    await q.moveDriverToEndOfQueue(phone)
    await wa.sendText(phone, 'Пропущено.')
    return true
  }
  if (buttonId.startsWith('arrived_')) {
    await orderEngine.arrived(parseInt(buttonId.replace('arrived_', '')), phone)
    return true
  }
  if (buttonId.startsWith('false_')) {
    await orderEngine.falseCall(parseInt(buttonId.replace('false_', '')), phone)
    return true
  }
  if (buttonId.startsWith('done_')) {
    await orderEngine.complete(parseInt(buttonId.replace('done_', '')), phone)
    return true
  }
  if (buttonId.startsWith('cancel_driver_')) {
    await q.setSession(phone, 'cancel_reason', {})
    await wa.sendButtons(phone, '🚫 *Отмена заказа*\n\nУкажите причину:', [
      { id:'driver_cancel_client', text:'👤 Клиент не вышел' },
      { id:'driver_cancel_road',   text:'🛣 Не могу доехать' },
      { id:'driver_cancel_other',  text:'❓ Другое' },
    ])
    return true
  }
  if (buttonId.startsWith('driver_cancel_')) {
    const reasons = { client:'Клиент не вышел', road:'Водитель не может доехать', other:'Водитель отменил' }
    const key = buttonId.replace('driver_cancel_', '')
    const order = await q.getActiveOrderByDriver(phone)
    if (order) await orderEngine.cancel(order.id, reasons[key] || 'Водитель отменил')
    else { await q.clearSession(phone); await wa.sendText(phone, '❌ Нет активного заказа.') }
    return true
  }
  if (buttonId.startsWith('chat_')) {
    await q.setSession(phone, 'driver_chat', { order_id: parseInt(buttonId.replace('chat_', '')) })
    await wa.sendText(phone, 'Чат с клиентом. Выход: стоп')
    return true
  }
  return false
}

module.exports = { handleBusyCommands, handleAcceptSkip, handleOrderButtons, KW, match }
