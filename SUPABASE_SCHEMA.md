# Supabase Schema — eOsakarovka Project2

**Project ID:** `jgnfjawqacmaqhgpsbcj`  
**Region:** eu-west-1  
**URL:** `https://jgnfjawqacmaqhgpsbcj.supabase.co`  
**DB Host:** `db.jgnfjawqacmaqhgpsbcj.supabase.co` (Postgres 17)

---

## Таблицы

### `users` — все пользователи (864 строки)

| Колонка | Тип | По умолчанию | Описание |
|---------|-----|-------------|----------|
| `id` | SERIAL PK | auto | |
| `phone` | VARCHAR(20) UNIQUE | — | Номер телефона |
| `name` | VARCHAR(100) | `'Клиент'` | Имя |
| `role` | VARCHAR(20) | `'client'` | `client` / `driver` / `admin` |
| `language` | VARCHAR(5) | `'ru'` | |
| `trip_count` | INTEGER | `0` | Число поездок |
| `last_seen_date` | DATE | NULL | |
| `is_blacklisted` | BOOLEAN | `false` | |
| `created_at` | TIMESTAMPTZ | `now()` | |
| `referral_code` | VARCHAR(10) UNIQUE | NULL | Реферальный код |
| `referred_by` | INTEGER → users.id | NULL | |
| `bonus_trips` | INTEGER | `0` | Бесплатные поездки |
| `home_address` | TEXT | NULL | |
| `work_address` | TEXT | NULL | |
| `fav_address_1` | TEXT | NULL | |
| `fav_address_1_name` | TEXT | NULL | |

---

### `drivers` — водители (4 строки)

| Колонка | Тип | По умолчанию | Описание |
|---------|-----|-------------|----------|
| `id` | SERIAL PK | auto | |
| `user_id` | INTEGER UNIQUE → users.id | NULL | |
| `full_name` | VARCHAR(100) | NULL | |
| `car_photo_url` | TEXT | NULL | |
| `car_make` | VARCHAR(50) | NULL | Марка авто |
| `car_plate` | VARCHAR(20) | NULL | Номер |
| `car_color` | VARCHAR(50) | NULL | |
| `status` | VARCHAR(20) | `'offline'` | `offline` / `online` / `busy` |
| `rating` | DECIMAL(3,2) | `5.00` | |
| `rating_count` | INTEGER | `0` | |
| `queue_position` | INTEGER | `0` | Позиция в очереди |
| `order_balance` | INTEGER | `0` | Баланс заказов |
| `skip_next` | BOOLEAN | `false` | |
| `skipped_orders` | INTEGER | `0` | Пропущено подряд |
| `total_skipped` | INTEGER | `0` | Всего пропущено |
| `last_activity` | TIMESTAMPTZ | `now()` | |
| `created_at` | TIMESTAMPTZ | `now()` | |

---

### `orders` — заказы (45 строк)

| Колонка | Тип | По умолчанию | Описание |
|---------|-----|-------------|----------|
| `id` | SERIAL PK | auto | |
| `client_id` | INTEGER → users.id | NULL | |
| `driver_id` | INTEGER → drivers.id | NULL | |
| `tariff_id` | INTEGER → tariffs.id | NULL | |
| `destination` | TEXT | — | Куда везти |
| `pickup_address` | TEXT | NULL | Откуда забрать |
| `price` | INTEGER | — | Цена (тенге) |
| `status` | VARCHAR(20) | `'searching'` | `searching` / `accepted` / `arrived` / `in_progress` / `completed` / `cancelled` |
| `is_free` | BOOLEAN | `false` | Бесплатная поездка |
| `is_intercity` | BOOLEAN | `false` | Межгород |
| `cancel_reason` | TEXT | NULL | |
| `scheduled_time` | TIMESTAMPTZ | NULL | Предзаказ |
| `created_at` | TIMESTAMPTZ | `now()` | |
| `accepted_at` | TIMESTAMPTZ | NULL | |
| `arrived_at` | TIMESTAMPTZ | NULL | |
| `completed_at` | TIMESTAMPTZ | NULL | |
| `cancelled_at` | TIMESTAMPTZ | NULL | |

---

### `tariffs` — тарифы (48 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `name` | VARCHAR(100) | Название тарифа |
| `keywords` | TEXT[] | Ключевые слова для поиска |
| `day_price` | INTEGER | Дневная цена (тенге) |
| `night_price` | INTEGER | Ночная цена (NULL = нет) |
| `description` | TEXT | |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |

---

### `ratings` — оценки (1 строка)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `order_id` | INTEGER UNIQUE → orders.id | |
| `client_id` | INTEGER → users.id | |
| `driver_id` | INTEGER → drivers.id | |
| `score` | INTEGER (1–5) | Оценка |
| `created_at` | TIMESTAMPTZ | |

---

### `sessions` — состояния диалогов (7 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `phone` | VARCHAR(20) PK | |
| `state` | VARCHAR(50) | Текущее состояние FSM |
| `ctx` | JSONB | Контекст диалога |
| `updated_at` | TIMESTAMPTZ | |

---

### `addresses` — справочник адресов (110 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `name` | VARCHAR | Название объекта |
| `category` | VARCHAR | Категория |
| `address` | VARCHAR | Адрес |
| `phone` | VARCHAR | |
| `hours` | VARCHAR | Часы работы |
| `lat` | NUMERIC | Широта |
| `lon` | NUMERIC | Долгота |
| `keywords` | TEXT[] | Ключевые слова |
| `source` | VARCHAR | `'2gis'` / др. |
| `external_id` | VARCHAR UNIQUE | ID из внешнего источника |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMPTZ | |

---

### `settings` — настройки бота

| key | Описание |
|-----|----------|
| `distribution_mode` | `queue` / `broadcast` — режим распределения заказов |
| `bot_active` | `true` / `false` |
| `admin_phone` | Телефон администратора для WhatsApp-алертов (7XXXXXXXXXX) |
| `referral_enabled` | Реферальная программа |
| `referral_bonus` | Бесплатных поездок за реферала |
| `loyalty_enabled` | Программа лояльности |
| `loyalty_every` | Каждая N-я поездка бесплатная |
| `loyalty_bonus` | Поездок за N-ю |

---

### `billing` — биллинг водителей (0 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `driver_id` | INTEGER → drivers.id | |
| `amount` | INTEGER | Сумма |
| `balance_after` | INTEGER | Баланс после |
| `note` | TEXT | |
| `admin_phone` | VARCHAR(20) | |
| `created_at` | TIMESTAMPTZ | |

---

### `broadcasts` — рассылки (0 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `target` | VARCHAR(20) | `client` / `driver` |
| `message` | TEXT | |
| `sent_count` | INTEGER | |
| `created_at` | TIMESTAMPTZ | |

---

### `chat_relay` — лог анонимного чата (0 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `order_id` | INTEGER → orders.id | |
| `from_phone` | VARCHAR(20) | |
| `to_phone` | VARCHAR(20) | |
| `message` | TEXT | |
| `sent_at` | TIMESTAMPTZ | |

---

### `false_calls` — ложные вызовы (1 строка)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `order_id` | INTEGER → orders.id | |
| `client_id` | INTEGER → users.id | |
| `driver_id` | INTEGER → drivers.id | |
| `fine` | INTEGER | Штраф (по умолч. 250 тенге) |
| `note` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

---

### `referrals` — реферальные приглашения (0 строк)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `referrer_id` | INTEGER → users.id | Кто пригласил |
| `referred_id` | INTEGER UNIQUE → users.id | Кого пригласили |
| `status` | VARCHAR(20) | `pending` / `activated` |
| `created_at` | TIMESTAMPTZ | |
| `activated_at` | TIMESTAMPTZ | |

---

## Индексы

| Индекс | Таблица | Колонка |
|--------|---------|---------|
| `idx_drivers_status` | drivers | status |
| `idx_drivers_queue` | drivers | queue_position |
| `idx_orders_status` | orders | status |
| `idx_orders_client` | orders | client_id |
| `idx_orders_driver` | orders | driver_id |
| `idx_sessions_phone` | sessions | phone |
| `idx_false_calls_client` | false_calls | client_id |
| `idx_referrals_referrer` | referrals | referrer_id |
| `idx_referrals_code` | users | referral_code (WHERE NOT NULL) |

---

## Использование клиента

```js
const supabase = require('./src/lib/supabaseClient');

// Чтение
const { data, error } = await supabase.from('orders').select('*').eq('status', 'searching');

// Вставка
await supabase.from('sessions').upsert({ phone, state, ctx, updated_at: new Date() });

// Обновление
await supabase.from('drivers').update({ status: 'online' }).eq('id', driverId);
```

---

## Переменные окружения

Добавить в `.env`:

```
SUPABASE_URL=https://jgnfjawqacmaqhgpsbcj.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key из Supabase Dashboard → Settings → API>
```

---

---

### `agent_memory` — долгосрочная память Hermes-агента

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `category` | TEXT | `project` / `user_pref` / `tech` / `status` / `decision` / `alert` / `learning` |
| `key` | TEXT | Ключ (UNIQUE с category) |
| `content` | TEXT | Содержимое |
| `importance` | INTEGER | 1–10, default 5 |
| `source` | TEXT | Источник (`agent`, `monitor`, `claude`, `analyze`) |
| `expires_at` | TIMESTAMPTZ | NULL = бессрочно |
| `updated_at` | TIMESTAMPTZ | |
| `created_at` | TIMESTAMPTZ | |

---

### `agent_conversations` — история диалогов с агентом

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `role` | VARCHAR(20) | `user` / `assistant` |
| `content` | TEXT | |
| `created_at` | TIMESTAMPTZ | |

---

### `agent_tasks` — задачи для Claude Code от агента

| Колонка | Тип | Описание |
|---------|-----|----------|
| `id` | SERIAL PK | |
| `type` | TEXT | `claude_task` / `monitor` / др. |
| `description` | TEXT | Описание задачи |
| `status` | TEXT | `pending` / `completed` / `failed` |
| `result` | TEXT | Результат выполнения |
| `created_at` | TIMESTAMPTZ | |
| `completed_at` | TIMESTAMPTZ | |

---

---

### `message_dedup` — дедупликация вебхуков (migration_v2.sql)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `msg_id` | TEXT PK | ID сообщения от Green API |
| `received_at` | TIMESTAMPTZ | `DEFAULT NOW()` |

Очищается каждые 2 часа через `cleanupMessageDedup()`.

---

### `admin_attempts` — брутфорс-защита (migration_v2.sql)

| Колонка | Тип | Описание |
|---------|-----|----------|
| `phone` | VARCHAR(20) PK | Телефон |
| `attempt_count` | INTEGER | Счётчик попыток |
| `last_attempt_at` | TIMESTAMPTZ | |
| `locked_until` | TIMESTAMPTZ | NULL = не заблокирован |

5 неудачных попыток → блок 15 мин. Переживает рестарт бота (в БД).

---

## ⚠️ Безопасность: RLS отключён

На всех 13 таблицах **Row Level Security отключён**. Это значит, что любой, у кого есть `anon` ключ, может читать и изменять все данные.

Поскольку бот использует **Service Role Key** (обходит RLS), для серверного кода это не критично. Но если в будущем появится фронтенд или мобильное приложение — нужно включить RLS и настроить политики.

Для включения RLS (только после настройки политик!):
```sql
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
-- ... и остальные таблицы
```
