#!/usr/bin/env node
/**
 * 🔍 Scout Agent — разведчик данных об Осакаровке
 *
 * Собирает информацию об объектах посёлка из нескольких источников:
 *  - 2GIS Catalog API (организации, магазины, кафе, школы...)
 *  - OpenStreetMap Overpass API (улицы, POI)
 *
 * CLI:
 *   node tools/scout/index.js run      — полный сбор данных (занимает 2-5 мин)
 *   node tools/scout/index.js osm      — только OSM (быстро, бесплатно)
 *   node tools/scout/index.js 2gis     — только 2GIS (требует DGIS_API_KEY)
 *   node tools/scout/index.js stats    — статистика таблицы addresses
 *   node tools/scout/index.js search <query> — поиск в текущей БД
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const dgis    = require('./dgis');
const osm     = require('./osm');
const { upsertBatch, getStats } = require('./db');
const dbPool  = require('../../src/db/index');

const log = (msg) => {
  const t = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty' });
  console.log(`[${t}] ${msg}`);
};

const printStats = async () => {
  const stats = await getStats();
  log(`\n📊 Таблица addresses:`);
  log(`   Всего активных: ${stats.totalActive}`);
  stats.bySource.forEach(r => {
    log(`   ${r.source.padEnd(8)} → ${r.total} (${r.active} активных)`);
  });
};

const runOsm = async () => {
  log('🌍 Запускаю OSM сбор...');
  const objects = await osm.collect(log);
  log(`\n📥 Сохраняю ${objects.length} объектов...`);
  const result = await upsertBatch(objects, log);
  log(`\n✅ OSM готово:`);
  log(`   Добавлено: ${result.inserted}`);
  log(`   Обновлено: ${result.updated}`);
  log(`   Пропущено: ${result.skipped}`);
  if (result.errors) log(`   ⚠️  Ошибок: ${result.errors}`);
};

const run2gis = async () => {
  const apiKey = process.env.DGIS_API_KEY;
  if (!apiKey) {
    log('❌ DGIS_API_KEY не задан в .env');
    return;
  }
  log('🗺️  Запускаю 2GIS сбор...');
  const objects = await dgis.collect(apiKey, log);
  log(`\n📥 Сохраняю ${objects.length} объектов...`);
  const result = await upsertBatch(objects, log);
  log(`\n✅ 2GIS готово:`);
  log(`   Добавлено: ${result.inserted}`);
  log(`   Обновлено: ${result.updated}`);
  log(`   Пропущено: ${result.skipped}`);
  if (result.errors) log(`   ⚠️  Ошибок: ${result.errors}`);
};

const runAll = async () => {
  log('🔍 Scout Agent запущен — полный сбор данных об Осакаровке');
  log('='.repeat(55));

  const t0 = Date.now();

  // Параллельно запускаем оба источника
  const [osmObjects, dgisObjects] = await Promise.all([
    osm.collect(log),
    dgis.collect(process.env.DGIS_API_KEY, log),
  ]);

  const allObjects = [...osmObjects, ...dgisObjects];
  log(`\n📥 Итого собрано: ${allObjects.length} объектов (OSM: ${osmObjects.length}, 2GIS: ${dgisObjects.length})`);
  log('Сохраняю в базу...');

  const result = await upsertBatch(allObjects, log);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  log(`\n${'='.repeat(55)}`);
  log(`✅ Сбор завершён за ${elapsed}с:`);
  log(`   Добавлено:  ${result.inserted}`);
  log(`   Обновлено:  ${result.updated}`);
  log(`   Пропущено:  ${result.skipped}`);
  if (result.errors) log(`   ⚠️  Ошибок: ${result.errors}`);

  await printStats();
};

const search = async (query) => {
  const r = await dbPool.query(`
    SELECT name, category, address, source,
           CASE WHEN keywords IS NOT NULL THEN array_to_string(keywords, ', ') ELSE '' END AS kw
    FROM addresses
    WHERE is_active = TRUE
      AND (
        name    ILIKE $1
        OR address ILIKE $1
        OR category ILIKE $1
        OR keywords && ARRAY[lower($2)]
      )
    ORDER BY
      CASE WHEN lower(name) = lower($2) THEN 0
           WHEN lower(name) LIKE lower($3) THEN 1
           ELSE 2 END
    LIMIT 20
  `, [`%${query}%`, query.toLowerCase(), `%${query.toLowerCase()}%`]);

  if (!r.rows.length) {
    log(`Ничего не найдено для: "${query}"`);
    return;
  }
  log(`\nРезультаты для "${query}" (${r.rows.length}):`);
  r.rows.forEach((row, i) => {
    log(`  ${i+1}. [${row.source}] ${row.name} — ${row.category}`);
    if (row.address) log(`      📍 ${row.address}`);
    if (row.kw) log(`      🔑 ${row.kw.slice(0, 80)}`);
  });
};

// CLI
const cmd = process.argv[2] || 'help';

(async () => {
  try {
    switch (cmd) {
      case 'run':
        await runAll();
        break;
      case 'osm':
        await runOsm();
        break;
      case '2gis':
        await run2gis();
        break;
      case 'stats':
        await printStats();
        break;
      case 'search': {
        const q = process.argv.slice(3).join(' ');
        if (!q) { log('Укажите запрос: node scout/index.js search <запрос>'); break; }
        await search(q);
        break;
      }
      default:
        log(`Scout Agent — разведчик данных Осакаровки`);
        log(`Использование:`);
        log(`  node tools/scout/index.js run          — полный сбор (2GIS + OSM)`);
        log(`  node tools/scout/index.js osm          — только OSM (бесплатно)`);
        log(`  node tools/scout/index.js 2gis         — только 2GIS`);
        log(`  node tools/scout/index.js stats        — статистика`);
        log(`  node tools/scout/index.js search кафе  — поиск в БД`);
    }
  } catch (e) {
    log(`❌ Критическая ошибка: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  } finally {
    await dbPool.end().catch(() => {});
  }
})();
