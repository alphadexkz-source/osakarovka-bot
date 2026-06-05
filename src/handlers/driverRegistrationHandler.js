const wa = require('../whatsapp/greenApi')
const q = require('../db/queries')

const handleRegistration = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg
  switch (state) {
    case 'reg_name':
      if (!text || text.length < 2) { await wa.sendText(phone, '👤 Введите ваше полное имя (ФИО):\nНапример: *Иванов Иван Иванович*'); return }
      await q.updateDriver(phone, { full_name: text.trim().slice(0, 100) })
      await q.setSession(phone, 'reg_photo', {})
      await wa.sendText(phone, '✅ Имя: *' + text.trim() + '*\n\n📷 *Шаг 2/5:* Отправьте фото вашего автомобиля:')
      break
    case 'reg_photo':
      if (type !== 'image' || !mediaUrl) { await wa.sendText(phone, '📷 Пожалуйста, отправьте фото автомобиля (не текст):'); return }
      await q.updateDriver(phone, { car_photo_url: mediaUrl })
      await q.setSession(phone, 'reg_make', {})
      await wa.sendText(phone, '✅ Фото сохранено!\n\n🚗 *Шаг 3/5:* Напишите марку и модель авто:\nНапример: *Kia Rio* или *Toyota Camry*')
      break
    case 'reg_make':
      if (!text || text.length < 2) { await wa.sendText(phone, '🚗 Введите марку и модель:\nНапример: *Kia Rio*'); return }
      await q.updateDriver(phone, { car_make: text.trim().slice(0, 50) })
      await q.setSession(phone, 'reg_plate', {})
      await wa.sendText(phone, '✅ Авто: *' + text.trim() + '*\n\n🔢 *Шаг 4/5:* Введите гос. номер:\nНапример: *A123BC*')
      break
    case 'reg_plate':
      if (!text || text.length < 2) { await wa.sendText(phone, '🔢 Введите гос. номер авто:\nНапример: *A123BC*'); return }
      await q.updateDriver(phone, { car_plate: text.trim().toUpperCase().slice(0, 20) })
      await q.setSession(phone, 'reg_color', {})
      await wa.sendText(phone, '✅ Номер: *' + text.trim().toUpperCase() + '*\n\n🎨 *Шаг 5/5:* Какого цвета ваш автомобиль?\nНапример: *белый*, *чёрный*, *серебристый*')
      break
    case 'reg_color': {
      if (!text || text.length < 2) { await wa.sendText(phone, 'Введите цвет:'); return }
      await q.updateDriver(phone, { car_color: text.trim().slice(0, 50) })
      await q.clearSession(phone)
      const d = await q.getDriver(phone)
      if (!d) { await wa.sendText(phone, '✅ Регистрация завершена! Напишите *"на линию"* чтобы начать.'); break }
      await wa.sendText(phone,
        '🎉 *Добро пожаловать в еОсакаровка Сервис!*\n\n' +
        '👤 Водитель: *' + (d.full_name||'—') + '*\n' +
        '🚗 Авто: *' + (d.car_make||'—') + '*, ' + (d.car_color||'—') + '\n' +
        '🔢 Номер: *' + (d.car_plate||'—') + '*\n\n' +
        '📋 *Основные команды:*\n' +
        '🟢 *на линию* — начать работу\n' +
        '⚫ *с линии* — закончить работу\n' +
        '✅ *принял* — принять заказ\n' +
        '📍 *прибыл* — приехали к клиенту\n' +
        '🏁 *свободен* — поездка завершена\n' +
        '🚫 *ложный* — клиента нет на месте\n' +
        '📊 *статистика* — ваш заработок\n' +
        '🔢 *очередь* — ваша позиция\n' +
        '❓ *faq* — полная инструкция\n\n' +
        '🎙 *Все команды работают голосом!*\n\n' +
        'Напишите *"на линию"* чтобы начать! 🚖'
      )
      break
    }
  }
}

const handleEdit = async (phone, msg, state) => {
  const { text, type, mediaUrl } = msg
  if (state === 'edit_name')  {
    if (!text || text.length < 2) { await wa.sendText(phone, '👤 Введите новое полное имя (ФИО):'); return }
    await q.updateDriver(phone, { full_name: text.trim().slice(0, 100) })
    await q.clearSession(phone)
    await wa.sendText(phone, '✅ Имя обновлено: *' + text.trim() + '*')
    return
  }
  if (state === 'edit_car') {
    const parts = (text||'').split(',').map(s => s.trim())
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      await wa.sendText(phone, '⚠️ Введите через запятую: *Марка, Номер*\nНапример: *Kia Rio, A123BC*')
      return
    }
    await q.updateDriver(phone, { car_make: parts[0].slice(0, 50), car_plate: parts[1].toUpperCase().slice(0, 20) })
    await q.clearSession(phone)
    await wa.sendText(phone, '✅ Авто обновлено: *' + parts[0] + '*, номер *' + parts[1].toUpperCase() + '*')
    return
  }
  if (state === 'edit_photo') {
    if (type !== 'image' || !mediaUrl) { await wa.sendText(phone, '📷 Отправьте фото автомобиля (именно фото, не текст):'); return }
    await q.updateDriver(phone, { car_photo_url: mediaUrl })
    await q.clearSession(phone)
    await wa.sendText(phone, '✅ Фото обновлено!')
    return
  }
  if (state === 'edit_color') {
    if (!text || text.length < 2) { await wa.sendText(phone, '🎨 Введите цвет автомобиля:'); return }
    await q.updateDriver(phone, { car_color: text.trim().slice(0, 50) })
    await q.clearSession(phone)
    await wa.sendText(phone, '✅ Цвет обновлён: *' + text.trim() + '*')
    return
  }
}

module.exports = { handleRegistration, handleEdit }
