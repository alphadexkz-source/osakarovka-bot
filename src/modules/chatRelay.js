const wa = require('../whatsapp/greenApi');
const q  = require('../db/queries');

// Клиент → Водитель
const fromClient = async (clientPhone, message) => {
  const order = await q.getActiveOrderByClient(clientPhone);
  if (!order?.driver_phone) {
    await wa.sendText(clientPhone, '❌ Нет активного заказа.');
    return;
  }
  await wa.sendText(order.driver_phone, `💬 *Клиент:* ${message}`);
};

// Водитель → Клиент
const fromDriver = async (driverPhone, message) => {
  const order = await q.getActiveOrderByDriver(driverPhone);
  if (!order?.client_phone) {
    await wa.sendText(driverPhone, '❌ Нет активного заказа.');
    return;
  }
  await wa.sendText(order.client_phone, `💬 *Водитель:* ${message}`);
};

module.exports = { fromClient, fromDriver };
