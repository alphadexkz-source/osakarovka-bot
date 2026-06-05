-- ============================================================
-- еОсакаровка Сервис — схема базы данных
-- ============================================================

-- Все пользователи (клиенты, водители, админ)
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  phone          VARCHAR(20) UNIQUE NOT NULL,
  name           VARCHAR(100) DEFAULT 'Клиент',
  role           VARCHAR(20)  DEFAULT 'client',   -- client | driver | admin
  language       VARCHAR(5)   DEFAULT 'ru',
  trip_count     INTEGER      DEFAULT 0,
  last_seen_date DATE,
  is_blacklisted BOOLEAN      DEFAULT FALSE,
  created_at     TIMESTAMPTZ  DEFAULT NOW()
);

-- Водители
CREATE TABLE IF NOT EXISTS drivers (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  full_name      VARCHAR(100),
  car_photo_url  TEXT,
  car_make       VARCHAR(50),
  car_plate      VARCHAR(20),
  car_color      VARCHAR(50),
  status         VARCHAR(20)    DEFAULT 'offline',  -- offline | online | busy
  rating         DECIMAL(3,2)   DEFAULT 5.00,
  rating_count   INTEGER        DEFAULT 0,
  queue_position INTEGER        DEFAULT 0,
  order_balance  INTEGER        DEFAULT 0,
  skip_next      BOOLEAN        DEFAULT FALSE,
  last_activity  TIMESTAMPTZ    DEFAULT NOW(),
  created_at     TIMESTAMPTZ    DEFAULT NOW()
);

-- Тарифы
CREATE TABLE IF NOT EXISTS tariffs (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  keywords    TEXT[]       DEFAULT '{}',
  day_price   INTEGER      NOT NULL,
  night_price INTEGER,
  description TEXT,
  is_active   BOOLEAN      DEFAULT TRUE,
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

-- Заказы
CREATE TABLE IF NOT EXISTS orders (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER REFERENCES users(id),
  driver_id     INTEGER REFERENCES drivers(id),
  tariff_id     INTEGER REFERENCES tariffs(id),
  destination   TEXT         NOT NULL,
  price         INTEGER      NOT NULL,
  status        VARCHAR(20)  DEFAULT 'searching',
    -- searching | accepted | arrived | in_progress | completed | cancelled
  is_free       BOOLEAN      DEFAULT FALSE,
  cancel_reason TEXT,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  accepted_at   TIMESTAMPTZ,
  arrived_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ
);

-- Оценки
CREATE TABLE IF NOT EXISTS ratings (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER UNIQUE REFERENCES orders(id),
  client_id  INTEGER REFERENCES users(id),
  driver_id  INTEGER REFERENCES drivers(id),
  score      INTEGER CHECK (score BETWEEN 1 AND 5),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Биллинг водителей
CREATE TABLE IF NOT EXISTS billing (
  id           SERIAL PRIMARY KEY,
  driver_id    INTEGER REFERENCES drivers(id),
  amount       INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  note         TEXT,
  admin_phone  VARCHAR(20),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- Состояния диалогов (сессии)
CREATE TABLE IF NOT EXISTS sessions (
  phone      VARCHAR(20) PRIMARY KEY,
  state      VARCHAR(50) DEFAULT 'idle',
  ctx        JSONB       DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Анонимный чат (лог)
CREATE TABLE IF NOT EXISTS chat_relay (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER REFERENCES orders(id),
  from_phone VARCHAR(20),
  to_phone   VARCHAR(20),
  message    TEXT,
  sent_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Рассылки
CREATE TABLE IF NOT EXISTS broadcasts (
  id         SERIAL PRIMARY KEY,
  target     VARCHAR(20),   -- client | driver
  message    TEXT,
  sent_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Настройки бота
CREATE TABLE IF NOT EXISTS settings (
  key   VARCHAR(50) PRIMARY KEY,
  value TEXT NOT NULL
);

-- Дефолтные настройки
INSERT INTO settings (key, value) VALUES
  ('distribution_mode', 'queue'),
  ('bot_active',        'true')
ON CONFLICT (key) DO NOTHING;

-- Индексы для быстрых запросов
CREATE INDEX IF NOT EXISTS idx_drivers_status   ON drivers(status);
CREATE INDEX IF NOT EXISTS idx_drivers_queue    ON drivers(queue_position);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_client    ON orders(client_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver    ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_sessions_phone   ON sessions(phone);

-- Ложные вызовы
CREATE TABLE IF NOT EXISTS false_calls (
  id         SERIAL PRIMARY KEY,
  order_id   INTEGER REFERENCES orders(id),
  client_id  INTEGER REFERENCES users(id),
  driver_id  INTEGER REFERENCES drivers(id),
  fine       INTEGER      DEFAULT 250,
  note       TEXT,
  created_at TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_false_calls_client ON false_calls(client_id);

-- ─── РЕФЕРАЛЬНАЯ ПРОГРАММА ────────────────────────────────────

-- Добавляем поля в users (если ещё нет)
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code  VARCHAR(10) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by    INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_trips    INTEGER DEFAULT 0;

-- Таблица рефералов
CREATE TABLE IF NOT EXISTS referrals (
  id           SERIAL PRIMARY KEY,
  referrer_id  INTEGER REFERENCES users(id),
  referred_id  INTEGER UNIQUE REFERENCES users(id),  -- каждый может быть приглашён только раз
  status       VARCHAR(20)  DEFAULT 'pending',       -- pending | activated
  created_at   TIMESTAMPTZ  DEFAULT NOW(),
  activated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON users(referral_code) WHERE referral_code IS NOT NULL;

-- ─── НАСТРОЙКИ ПРОГРАММ ЛОЯЛЬНОСТИ ──────────────────────────
INSERT INTO settings (key, value) VALUES
  ('referral_enabled',    'true'),   -- включена ли реферальная программа
  ('referral_bonus',      '1'),      -- сколько бесплатных поездок за реферала
  ('loyalty_enabled',     'true'),   -- включена ли программа лояльности (10-я поездка)
  ('loyalty_every',       '10'),     -- каждая N-я поездка бесплатная
  ('loyalty_bonus',       '1')       -- сколько бесплатных поездок за N-ю поездку
ON CONFLICT (key) DO NOTHING;
-- Межгородские поля
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_time TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_reminder_sent BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_intercity BOOLEAN DEFAULT false;
