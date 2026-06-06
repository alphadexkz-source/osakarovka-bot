/**
 * Upsert нормализованных объектов в таблицу addresses.
 * Ключ уникальности: (source, external_id).
 */
const dbPool = require('../../src/db/index');

// Создаём уникальный индекс если его нет (идемпотентно)
const ensureIndex = async () => {
  await dbPool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_addresses_source_extid
    ON addresses(source, external_id)
    WHERE external_id IS NOT NULL AND external_id != ''
  `).catch(() => {});
};

/**
 * Upsert одного объекта.
 * Возвращает 'inserted' | 'updated' | 'skipped'
 */
const upsertOne = async (obj) => {
  if (!obj.name) return 'skipped';

  if (obj.external_id) {
    const r = await dbPool.query(`
      INSERT INTO addresses(name, category, address, phone, hours, lat, lon, keywords, source, external_id, is_active)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE)
      ON CONFLICT (source, external_id)
        WHERE external_id IS NOT NULL AND external_id != ''
      DO UPDATE SET
        name     = EXCLUDED.name,
        category = EXCLUDED.category,
        address  = EXCLUDED.address,
        phone    = COALESCE(EXCLUDED.phone, addresses.phone),
        hours    = COALESCE(EXCLUDED.hours, addresses.hours),
        lat      = COALESCE(EXCLUDED.lat,  addresses.lat),
        lon      = COALESCE(EXCLUDED.lon,  addresses.lon),
        keywords = EXCLUDED.keywords,
        is_active = TRUE
      RETURNING (xmax = 0) AS inserted
    `, [
      obj.name, obj.category, obj.address, obj.phone, obj.hours,
      obj.lat, obj.lon, obj.keywords, obj.source, obj.external_id,
    ]);
    return r.rows[0]?.inserted ? 'inserted' : 'updated';
  }

  // Без external_id — вставляем только если нет точного совпадения по имени
  const exists = await dbPool.query(
    `SELECT id FROM addresses WHERE lower(name)=lower($1) LIMIT 1`, [obj.name]
  );
  if (exists.rows.length) return 'skipped';

  await dbPool.query(`
    INSERT INTO addresses(name, category, address, phone, hours, lat, lon, keywords, source, is_active)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
  `, [obj.name, obj.category, obj.address, obj.phone, obj.hours, obj.lat, obj.lon, obj.keywords, obj.source]);
  return 'inserted';
};

/**
 * Batch upsert с прогрессом.
 */
const upsertBatch = async (objects, logger = console.log) => {
  await ensureIndex();

  let inserted = 0, updated = 0, skipped = 0, errors = 0;

  for (const obj of objects) {
    try {
      const result = await upsertOne(obj);
      if (result === 'inserted') inserted++;
      else if (result === 'updated') updated++;
      else skipped++;
    } catch (e) {
      errors++;
      if (errors <= 3) logger(`[DB] Ошибка: ${e.message} (${obj.name})`);
    }
  }

  return { inserted, updated, skipped, errors };
};

/**
 * Статистика таблицы.
 */
const getStats = async () => {
  const r = await dbPool.query(`
    SELECT
      source,
      COUNT(*) AS total,
      COUNT(*) FILTER(WHERE is_active) AS active
    FROM addresses
    GROUP BY source
    ORDER BY total DESC
  `);
  const total = await dbPool.query('SELECT COUNT(*) FROM addresses WHERE is_active=TRUE');
  return {
    bySource: r.rows,
    totalActive: parseInt(total.rows[0].count),
  };
};

module.exports = { upsertBatch, getStats, ensureIndex };
