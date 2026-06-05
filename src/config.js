require('dotenv').config();

if (!process.env.ADMIN_PIN || !process.env.DRIVER_CODE) {
  console.error('[Config] КРИТИЧНО: ADMIN_PIN и DRIVER_CODE обязательны в .env');
  process.exit(1);
}

module.exports = {
  // Green API
  INSTANCE_ID:    process.env.GREEN_API_ID,
  API_TOKEN:      process.env.GREEN_API_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET || '',

  // Database
  DATABASE_URL:  process.env.DATABASE_URL,

  // Bot
  ADMIN_PIN:     process.env.ADMIN_PIN,
  DRIVER_CODE:   process.env.DRIVER_CODE,
  PORT:          parseInt(process.env.PORT) || 3000,

  // Timeouts (мс)
  ACCEPT_TIMEOUT_MS:   40_000,   // 40 сек на принятие заказа (было 60)
  ARRIVE_TIMEOUT_MS:  720_000,   // 12 мин на «Прибыл»
  INACTIVITY_MS:    1_800_000,   // 30 мин → авто Офлайн
  PAUSE_MS:           3_000,     // 3 сек пауза между водителями (было 15)

  // Очередь
  MAX_CIRCLES:    3,             // кругов если 1 водитель

  // Тариф
  NIGHT_START:    parseInt(process.env.NIGHT_TARIFF_START) || 23,  // с 23:00
  NIGHT_END:      parseInt(process.env.NIGHT_TARIFF_END)   || 7,   // до 07:00
  CITY_PRICE:     500,           // цена внутри Осакаровки

  // Бизнес
  FREE_TRIP_EVERY:  10,          // каждая N-я поездка бесплатно
  LOW_RATING:       3.0,         // рейтинг ниже → пропуск каждого 2-го
  FALSE_CALL_PRICE: 250,         // штраф за ложный вызов (тенге)

  // Переименованные улицы (новое → бывшее) — для подсказки в подтверждении заказа
  STREET_ALIASES: {
    'алаш':                  'бывш. Первомайская',
    'қарағанды':             'бывш. Октябрьская',
    'жібек жолы':            'бывш. Советская',
    'сұңқар':                'бывш. Комсомольская',
    'жамбыла':               'бывш. Пионерская',
    'александра ткача':      'бывш. Подгорная',
    'шәкәрім':               'бывш. Театральная',
    'шәмші қалдаяқов':       'бывш. Спортивная',
    'геннадия карапиди':     'бывш. Колхозная',
    'беслана аушева':        'бывш. Кузнечная',
    'керқем':                'бывш. Советский переулок',
    'сарыбұлақ':             'бывш. Нефтебазы / Сарыбулак',
    'әлихан бөкейханов':     'бывш. Алихана Бокейханова (Литвинская)',
    'болашақ':               'бывш. Болашак',
    'жеңіс':                 'бывш. Победы',
    'күншуақ':               'бывш. Куншуак',
  },
};
