-- ============================================================
-- Migration v2 — стабилизация (2026-06-03)
-- Запускать через Supabase SQL Editor или psql
-- ============================================================

-- 1. Колонки для DB-backed диспетчеризации заказов
--    (вместо acceptTimers/arriveTimers в памяти)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_to  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at  TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS arrive_warned  BOOLEAN DEFAULT FALSE;

-- Индекс для быстрого поиска зависших диспетчеризаций
CREATE INDEX IF NOT EXISTS idx_orders_dispatched
  ON orders(dispatched_at) WHERE dispatched_to IS NOT NULL;

-- Индекс для arrive warning
CREATE INDEX IF NOT EXISTS idx_orders_arrive_warn
  ON orders(accepted_at) WHERE status = 'accepted' AND arrive_warned = FALSE;

-- 2. Блокировки администраторов (заменяет in-memory Map в queries.js)
CREATE TABLE IF NOT EXISTS admin_attempts (
  phone           VARCHAR(20) PRIMARY KEY,
  attempt_count   INTEGER     DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ DEFAULT NOW()
);
