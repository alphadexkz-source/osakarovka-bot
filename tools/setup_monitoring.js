#!/usr/bin/env node
/**
 * Регистрирует HTTP-монитор в UptimeRobot (бесплатный план, проверка каждые 5 мин).
 *
 * Использование:
 *   UPTIMEROBOT_API_KEY=u1234567-xxxxx node tools/setup_monitoring.js
 *
 * Получить API key: https://uptimerobot.com/dashboard#mySettings → Main API Key
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const API_KEY  = process.env.UPTIMEROBOT_API_KEY || process.argv[2];
const BOT_URL  = `http://34.40.3.202:3000/`;
const NAME     = 'еОсакаровка Сервис';

if (!API_KEY) {
  console.error('❌  Укажите API-ключ:');
  console.error('   UPTIMEROBOT_API_KEY=u1234567-xxx node tools/setup_monitoring.js');
  console.error('\nПолучить: https://uptimerobot.com/dashboard#mySettings → Main API Key');
  process.exit(1);
}

async function run() {
  console.log(`\n🔧  Создаём монитор для ${BOT_URL} ...`);

  // 1. Проверяем что URL отвечает
  try {
    const res = await fetch(BOT_URL, { signal: AbortSignal.timeout(10000) });
    if (res.ok) {
      const json = await res.json().catch(() => ({}));
      console.log(`✅  Бот отвечает: ${json.status || res.status}`);
    } else {
      console.warn(`⚠️   Бот вернул ${res.status} — монитор всё равно создадим`);
    }
  } catch (e) {
    console.warn(`⚠️   Нет ответа от ${BOT_URL}: ${e.message}`);
    console.warn('    Убедитесь что бот запущен перед созданием монитора.');
  }

  // 2. Создаём монитор в UptimeRobot
  const body = new URLSearchParams({
    api_key:         API_KEY,
    friendly_name:   NAME,
    url:             BOT_URL,
    type:            '1',       // HTTP(S)
    interval:        '300',     // 5 минут
    keyword_type:    '2',       // keyword exists
    keyword_value:   'running', // JSON поле из GET /
  });

  const res = await fetch('https://api.uptimerobot.com/v2/newMonitor', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });

  const data = await res.json();

  if (data.stat === 'ok') {
    console.log(`\n✅  Монитор создан!`);
    console.log(`   ID:      ${data.monitor.id}`);
    console.log(`   URL:     ${BOT_URL}`);
    console.log(`   Статус:  проверяется каждые 5 минут`);
    console.log(`\n   Добавьте в .env на сервере:`);
    console.log(`   UPTIMEROBOT_API_KEY=${API_KEY}`);
    console.log(`   UPTIMEROBOT_MONITOR_ID=${data.monitor.id}`);
    console.log(`\n   Настройте алерт на email/Telegram:`);
    console.log(`   https://uptimerobot.com/dashboard#mySettings → Alert Contacts`);
  } else if (data.error?.type === 'already_exists') {
    console.log(`ℹ️   Монитор для этого URL уже существует.`);
    console.log(`   Откройте https://uptimerobot.com/dashboard чтобы проверить.`);
  } else {
    console.error(`\n❌  Ошибка UptimeRobot:`, JSON.stringify(data, null, 2));
    if (data.error?.message?.includes('invalid')) {
      console.error('    Проверьте API ключ — нужен Main API Key (не Read-only).');
    }
    process.exit(1);
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
