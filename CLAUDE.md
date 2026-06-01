# CLAUDE.md — Osakarovka Bot

## О проекте

**еОсакаровка Сервис** — WhatsApp-бот диспетчерской службы такси посёлка Осакаровка (Казахстан).
Стек: Node.js + Express + PostgreSQL (Supabase) + Green API (WhatsApp) + Groq AI.

## Инфраструктура

| Ресурс | Значение |
|--------|----------|
| **Сервер** | Google Cloud VM `osakarovka-bot`, `europe-west3-c`, e2-micro |
| **IP** | `34.40.3.202` |
| **SSH** | `ssh -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202` |
| **PM2** | `pm2 list` / `pm2 logs` / `pm2 restart osakarovka-bot` (под `alphadexkz`) |
| **Bot path** | `/home/alphadexkz/osakarovka-bot/` |
| **Supabase** | `https://jgnfjawqacmaqhgpsbcj.supabase.co`, project `eOsakarovka Project2` |
| **DB** | `db.jgnfjawqacmaqhgpsbcj.supabase.co`, PostgreSQL 17, eu-west-1 |
| **Green API** | Instance `7107636283` |
| **Groq** | `llama-3.3-70b-versatile` (чат), `whisper-large-v3` (голос) |
| **GCP Project** | `project-71dedb61-45a3-4e5c-986` |

## Архитектура

```
src/
├── index.js              # Express сервер, webhook, rate limiting, startup recovery
├── config.js             # Все константы и env-переменные
├── handlers/
│   ├── router.js         # Роутинг: new → client/driver/admin
│   ├── clientHandler.js  # FSM клиента: idle→confirming→waiting_driver→in_trip
│   ├── driverHandler.js  # FSM водителя + регистрация + редактирование
│   └── adminHandler.js   # Панель администратора
├── modules/
│   ├── orderEngine.js    # create/accept/arrived/complete/cancel/falseCall
│   ├── driverManager.js  # goOnline/goOffline/getNextDriver/afterTrip
│   ├── notificationService.js  # Все WhatsApp-уведомления
│   ├── tariffEngine.js   # Поиск тарифа по ключевым словам
│   ├── addressDetector.js # isAddress() через БД + Groq fallback
│   ├── favoriteAddresses.js   # Дом/работа/избранное
│   ├── smartReply.js     # Groq ответы клиентам и водителям
│   ├── greetingService.js     # Groq приветствия
│   ├── voiceRecognizer.js     # Groq Whisper транскрипция
│   ├── chatRelay.js      # Анонимный чат клиент↔водитель
│   ├── weatherService.js # OpenWeather API
│   └── timerService.js   # cron-задачи (node-cron)
├── db/
│   ├── index.js          # pg Pool (max: 10, SSL, family: 4)
│   ├── queries.js        # Все DB-запросы с whitelist-защитой
│   └── schema.sql        # Начальная схема (миграции в Supabase)
└── whatsapp/
    └── greenApi.js       # sendText/sendButtons/sendImage/setWebhook
```

## Основной флоу заказа

```
Клиент пишет адрес
  → isAddress() → handleNewOrder()
  → tariffEngine.getPrice()
  → session: confirming
  → Клиент подтверждает
  → orderEngine.create()
    → createOrder() в БД
    → session: waiting_driver
    → dispatch_queue() или dispatch_first()
      → driverNewOrder() (уведомление + кнопки)
      → setTimeout 60s → penalizeSkip() → следующий водитель
  → Водитель: принял → accept()
    → atomicAcceptOrder() (атомарный UPDATE)
    → clientDriverFound() (фото + инфо)
    → session: in_trip
  → Водитель: прибыл → arrived()
    → clientArrived()
  → Водитель: свободен → complete()
    → incrementTripCount()
    → activateReferral()
    → clientCompleted() (с Groq farewell)
    → driverManager.afterTrip()
```

## Роли пользователей

- **client** — обычный клиент (default)
- **driver** — водитель (регистрируется по DRIVER_CODE)
- **admin** — администратор (регистрируется по `/admin PIN`)
- **new** — не в БД (создаётся при первом сообщении)

## FSM состояния сессий

### Клиент
- `idle` — ожидание
- `confirming` — подтверждение заказа
- `waiting_driver` — поиск водителя
- `in_trip` — в поездке
- `chat_mode` — чат с водителем
- `intercity_pickup` → `intercity_time` → `intercity_confirm` — межгород

### Водитель
- `idle` — ожидание (+ `ctx.pending_order_id` = входящий заказ)
- `driver_as_client` — водитель заказывает такси
- `driver_chat` — чат с клиентом
- `reg_name/photo/make/plate/color` — регистрация
- `edit_name/car/photo/color` — редактирование

### Админ
- `admin_mode` — панель
- `admin_add_1/2/3/4` — добавление тарифа
- `admin_edit_pick/field` — редактирование тарифа
- `admin_del_pick` — удаление тарифа

## Деплой на сервер

```bash
# 1. Локально: commit + push
git add -A && git commit -m "fix: ..." && git push

# 2. На сервере:
ssh -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202
cd ~/osakarovka-bot
git pull
npm install --production
pm2 restart osakarovka-bot
pm2 logs --lines 20
```

## Переменные окружения (.env)

```
GREEN_API_ID=        # ID инстанса Green API
GREEN_API_TOKEN=     # Token Green API
DATABASE_URL=        # PostgreSQL connection string (Supabase)
ADMIN_PIN=           # PIN для входа в админ панель (/admin PIN)
DRIVER_CODE=         # Код для регистрации водителей
GROQ_API_KEY=        # Groq AI API key
WEATHER_API_KEY=     # OpenWeatherMap API key
DGIS_API_KEY=        # 2GIS API key (для import_2gis.js)
SUPABASE_URL=        # https://jgnfjawqacmaqhgpsbcj.supabase.co
SUPABASE_SERVICE_KEY=# Supabase service role key
PORT=3000
```

## Ключевые константы (config.js)

| Константа | Значение | Описание |
|-----------|----------|----------|
| `ACCEPT_TIMEOUT_MS` | 60000 | 60 сек на принятие заказа |
| `ARRIVE_TIMEOUT_MS` | 720000 | 12 мин на «Прибыл» |
| `INACTIVITY_MS` | 1800000 | 30 мин → авто Офлайн |
| `PAUSE_MS` | 15000 | Пауза между водителями |
| `MAX_CIRCLES` | 3 | Кругов в очереди |
| `NIGHT_START` | 23 | Начало ночного тарифа |
| `NIGHT_END` | 7 | Конец ночного тарифа |
| `CITY_PRICE` | 500 | Цена по умолчанию (тг) |
| `FREE_TRIP_EVERY` | 10 | Каждая N-я поездка бесплатно |
| `FALSE_CALL_PRICE` | 250 | Штраф за ложный вызов |
| `LOW_RATING` | 3.0 | Порог низкого рейтинга |

## Известные ограничения и нюансы

1. **Баланс водителя**: `order_balance = 999999` = бесплатный пробный период (баланс не списывается)
2. **Режимы распределения**: `queue` (очередь по позиции) или `first` (кто первый принял)
3. **Green API кнопки**: максимум 3 кнопки; fallback на текст при неудаче
4. **Rate limit**: 30 сообщений за 60 сек (in-memory, сбрасывается при рестарте)
5. **Брутфорс admin**: 5 попыток → блок 15 мин (in-memory)
6. **RLS в Supabase**: отключён; бот использует service role key
7. **Таймер**: зависшие заказы (>10 мин в `searching`) → автоотмена каждые 5 мин
8. **Swap**: на сервере нет swap-памяти

## Команды водителей (ключевые слова)

| Команда | Ключевые слова |
|---------|----------------|
| На линию | на линию, онлайн, старт, жұмыс, выхожу |
| С линии | с линии, офлайн, стоп, отдых, аяқтадым |
| Принял | принял, беру, ok, ок, да, аламын |
| Прибыл | прибыл, на месте, стою, келдім |
| Свободен | свободен, готово, доехали, бостымын |
| Ложный | ложный, нет клиента, пусто, жалған |
| Пропустить | пропустить, следующий, откізу |
| Статистика | статистика, стат, қанша, заработок |

## Важные DB-запросы для отладки

```sql
-- Активные заказы
SELECT * FROM orders WHERE status NOT IN ('completed','cancelled') ORDER BY created_at DESC;

-- Онлайн водители
SELECT d.full_name, d.status, d.queue_position, d.order_balance, u.phone 
FROM drivers d JOIN users u ON d.user_id=u.id 
WHERE d.status IN ('online','busy') ORDER BY d.queue_position;

-- Зависшие сессии
SELECT * FROM sessions WHERE state != 'idle' ORDER BY updated_at;

-- Статистика сегодня
SELECT COUNT(*) FILTER(WHERE status='completed') AS done,
       COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue
FROM orders WHERE created_at::date=CURRENT_DATE;
```
