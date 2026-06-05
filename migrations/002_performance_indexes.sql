-- Migration 002: Performance indexes
-- Применить в Supabase Dashboard → SQL Editor → Run

-- Зависшие заказы (checkStuckOrders каждые 5 мин)
CREATE INDEX IF NOT EXISTS idx_orders_searching
  ON orders(created_at) WHERE status = 'searching';

-- Предзаказы (checkScheduledOrders каждую минуту)
CREATE INDEX IF NOT EXISTS idx_orders_scheduled
  ON orders(scheduled_time) WHERE status = 'scheduled';

-- Прибытие водителя (getUnwarnedArrivals каждые 2 мин)
CREATE INDEX IF NOT EXISTS idx_orders_accepted
  ON orders(accepted_at) WHERE status = 'accepted';

-- Активные dispatch (getExpiredDispatches каждую минуту)
CREATE INDEX IF NOT EXISTS idx_orders_dispatched
  ON orders(dispatched_at) WHERE status = 'searching' AND dispatched_to IS NOT NULL;

-- Статистика водителя по дням (вызывается при каждом complete)
CREATE INDEX IF NOT EXISTS idx_orders_driver_date
  ON orders(driver_id, created_at DESC);

-- GIN индекс на keywords адресов (ускоряет поиск && оператором)
CREATE INDEX IF NOT EXISTS idx_addresses_keywords_gin
  ON addresses USING gin(keywords);

-- Онлайн водители с таймером неактивности
CREATE INDEX IF NOT EXISTS idx_drivers_online_activity
  ON drivers(last_activity) WHERE status = 'online';
