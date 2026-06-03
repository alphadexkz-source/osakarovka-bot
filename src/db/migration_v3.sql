-- Migration v3 — breakTimers → DB, message deduplication
-- Запускать после migration_v2.sql

-- Перерывы водителей (вместо in-memory breakTimers Map)
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS break_until TIMESTAMPTZ;

-- Дедупликация вебхуков (для восстановления после рестарта)
CREATE TABLE IF NOT EXISTS message_dedup (
  msg_id      VARCHAR(100) PRIMARY KEY,
  received_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_message_dedup_received ON message_dedup(received_at);
