# CLAUDE.md — Osakarovka Bot v2.0

## О проекте

**еОсакаровка Сервис** — WhatsApp-бот диспетчерской службы такси посёлка Осакаровка (Казахстан).  
Стек: Node.js + Express + PostgreSQL (Supabase) + Green API (WhatsApp) + Groq AI + Claude API.

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
| **Groq** | `llama-3.3-70b-versatile` (addressDetector), `llama-3.1-8b-instant` (scheduleParser), `qwen/qwen3-32b` (Hermes мониторинг), `whisper-large-v3` (голос) |
| **Claude Haiku** | `claude-haiku-4-5-20251001` (smartReply, greetingService — чат с клиентами, имя: Айгуль) |
| **Claude Sonnet** | `claude-sonnet-4-6` (agent/llm.js — Hermes мозг, agent/tools.js — анализ ошибок) |
| **GCP Project** | `project-71dedb61-45a3-4e5c-986` |

## Архитектура

```
src/
├── index.js                      # Express сервер, webhook, rate limiting, dedup, startup
├── config.js                     # Все константы, env-переменные, STREET_ALIASES
├── logger.js                     # Структурированные логи (msg/order/driver/groq/voice/warn/error)
├── handlers/
│   ├── router.js                 # Роутинг: new → client/driver/admin, parse webhook
│   ├── clientHandler.js          # FSM клиента: координатор
│   ├── clientOrderHandler.js     # Клиент: обработка заказа (confirming, waiting, in_trip)
│   ├── clientInfoHandler.js      # Клиент: /help, /stats, профиль
│   ├── clientProfileHandler.js   # Клиент: дом/работа/избранные адреса
│   ├── driverHandler.js          # FSM водителя: координатор
│   ├── driverCommandHandler.js   # Водитель: онлайн/офлайн/статистика/faq
│   ├── driverOrderHandler.js     # Водитель: принял/прибыл/свободен/ложный
│   ├── driverRegistrationHandler.js # Водитель: регистрация + редактирование
│   └── adminHandler.js           # Панель администратора
├── modules/
│   ├── orderEngine.js            # create/accept/arrived/complete/cancel/falseCall
│   ├── driverManager.js          # goOnline/goOffline/getNextDriver/afterTrip
│   ├── notificationService.js    # Все WhatsApp-уведомления
│   ├── tariffEngine.js           # Поиск тарифа по ключевым словам
│   ├── addressDetector.js        # isAddress() через БД + Groq fallback
│   ├── favoriteAddresses.js      # Дом/работа/избранное
│   ├── smartReply.js             # Groq ответы клиентам и водителям
│   ├── greetingService.js        # Groq приветствия
│   ├── voiceRecognizer.js        # Groq Whisper транскрипция
│   ├── voiceCommandHandler.js    # Обработка голосовых команд водителей
│   ├── voiceCommands.js          # Ключевые слова голосовых команд
│   ├── voiceUtils.js             # Вспомогательные утилиты для голоса
│   ├── chatRelay.js              # Анонимный чат клиент↔водитель
│   ├── weatherService.js         # OpenWeather API
│   ├── scheduleParser.js         # Парсинг времени предзаказа ("завтра в 9")
│   ├── stateMachine.js           # FSM-валидация: VALID_STATES, transition(), reset()
│   ├── prompts.js                # Groq промпты (вынесены отдельно)
│   ├── testLogger.js             # Лог подозрительных событий (suspicious())
│   └── timerService.js           # cron-задачи: авто-отмена, мониторинг, предзаказы
├── db/
│   ├── index.js                  # pg Pool (max: 10, SSL, family: 4)
│   ├── queries.js                # Реэкспорт для обратной совместимости
│   ├── setup.js                  # Инициализация БД при старте
│   └── queries/
│       ├── index.js              # Реэкспорт всех query-модулей
│       ├── userQueries.js        # getUser/createUser/updateUser/blacklist
│       ├── sessionQueries.js     # getSession/setSession/clearSession
│       ├── driverQueries.js      # getDriver/createDriver/updateDriver
│       ├── orderQueries.js       # createOrder/getOrder/updateOrder/atomicAccept
│       ├── tariffQueries.js      # getTariffs/createTariff/updateTariff
│       ├── adminQueries.js       # getSetting(кеш)/setSetting/admin brute-force/billing
│       ├── systemQueries.js      # isDuplicateMessage/getRecentMessageIds/cleanupMessageDedup
│       └── utils.js              # Общие утилиты (whitelist-защита полей)
├── lib/
│   ├── claudeApi.js              # Claude Haiku с prompt caching (smartReply, greetingService)
│   └── supabaseClient.js         # Supabase JS client (service role key)
└── whatsapp/
    └── greenApi.js               # sendText/sendButtons/sendImage/setWebhook

agent/                            # Hermes — автономный агент мониторинга
├── hermes.js                     # Мониторинг каждые 5 мин (Qwen3 + Claude), CLI: monitor/ask/memory/loop
├── llm.js                        # Claude claude-sonnet-4-6 с prompt caching
├── memory.js                     # CRUD agent_memory: getAll/getCritical/logTask/stats
├── tools.js                      # ssh/getLogs/getBotStats/askGroq/askClaude
└── schema.sql                    # SQL для agent_memory/agent_conversations/agent_tasks

migrations/
├── 001_scheduled_reminder_and_agent_tables.sql
└── 002_performance_indexes.sql   # 7 индексов БД (searching, scheduled, accepted, dispatched...)

tools/
├── setup_monitoring.js           # UptimeRobot скрипт
└── tariff_calculator.js
```

## Основной флоу заказа

```
Клиент пишет адрес
  → isAddress() → clientOrderHandler
  → tariffEngine.getPrice()
  → session: confirming
  → scheduleParser.detectInlineSchedule() — детект "завтра в 9" inline
  → Клиент подтверждает
  → orderEngine.create()
    → createOrder() в БД
    → если scheduled_time → session: scheduled (ожидание)
    → иначе session: waiting_driver
    → dispatch_queue()
      → driverNewOrder() (уведомление + кнопки)
      → setTimeout 40s → penalizeSkip() → следующий водитель
  → Водитель: принял → accept()
    → atomicAcceptOrder() (атомарный UPDATE — race-condition защита)
    → clientDriverFound() (фото + инфо)
    → session: in_trip
  → Водитель: прибыл → arrived()
    → clientArrived()
  → Водитель: свободен → complete()
    → incrementTripCount()
    → activateReferral()
    → clientCompleted() (с Groq farewell)
    → session: waiting_rating → клиент оценивает
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
- `waiting_rating` — запрос оценки после поездки
- `cancel_client_reason` — клиент выбирает причину отмены
- `schedule_time` → `scheduled_confirm` → `scheduled` — предзаказ
- `intercity_pickup` → `intercity_confirm` — межгород (состояния `intercity_time` в коде нет)

### Водитель
- `idle` — ожидание (+ `ctx.pending_order_id` = входящий заказ)
- `driver_as_client` — водитель заказывает такси
- `driver_chat` — чат с клиентом
- `cancel_reason` — водитель выбирает причину отмены
- `reg_name/reg_photo/reg_make/reg_plate/reg_color` — регистрация (5 шагов)
- `edit_name/edit_car/edit_photo/edit_color` — редактирование профиля

### Админ
- `admin_mode` — панель
- `admin_add_1/2/3/4` — добавление тарифа
- `admin_edit_pick/admin_edit_field` — редактирование тарифа
- `admin_del_pick` — удаление тарифа
- `admin_exit` — выход из панели (перед сбросом в idle)

## Деплой на сервер

```bash
# 1. Локально: commit + push
git add -A && git commit -m "fix: ..." && git push

# 2. На сервере:
ssh -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202
cd ~/osakarovka-bot
git pull
npm install --production
pm2 restart ecosystem.config.js   # или: pm2 restart osakarovka-bot hermes-agent
pm2 logs --lines 30

# Первый запуск:
pm2 start ecosystem.config.js
pm2 save
```

PM2 управляет одним процессом:
- `osakarovka-bot` — основной WhatsApp-бот (`src/index.js`)

> `hermes-agent` **отключён** из PM2 из-за ложных алертов. Включить вручную: `pm2 start hermes-agent -- loop`

## Переменные окружения (.env)

```
GREEN_API_ID=         # ID инстанса Green API
GREEN_API_TOKEN=      # Token Green API
DATABASE_URL=         # PostgreSQL connection string (Supabase)
ADMIN_PIN=            # PIN для входа в админ панель (/admin PIN)
DRIVER_CODE=          # Код для регистрации водителей
GROQ_API_KEY=         # Groq AI API key
ANTHROPIC_API_KEY=    # Claude API key (agent/tools.js — глубокий анализ ошибок)
WEATHER_API_KEY=      # OpenWeatherMap API key
DGIS_API_KEY=         # 2GIS API key (для import_2gis.js)
SUPABASE_URL=         # https://jgnfjawqacmaqhgpsbcj.supabase.co
SUPABASE_SERVICE_KEY= # Supabase service role key
NIGHT_TARIFF_START=   # Начало ночного тарифа (default: 23)
NIGHT_TARIFF_END=     # Конец ночного тарифа (default: 7)
PORT=3000
```

## Ключевые константы (config.js)

| Константа | Значение | Описание |
|-----------|----------|----------|
| `ACCEPT_TIMEOUT_MS` | 40 000 | 40 сек на принятие заказа |
| `ARRIVE_TIMEOUT_MS` | 720 000 | 12 мин на «Прибыл» |
| `INACTIVITY_MS` | 1 800 000 | 30 мин → авто Офлайн |
| `PAUSE_MS` | 3 000 | 3 сек пауза между водителями |
| `MAX_CIRCLES` | 3 | Кругов в очереди |
| `NIGHT_START` | 23 (env) | Начало ночного тарифа |
| `NIGHT_END` | 7 (env) | Конец ночного тарифа |
| `CITY_PRICE` | 500 | Цена внутри Осакаровки (тг) |
| `FREE_TRIP_EVERY` | 10 | Каждая N-я поездка бесплатно |
| `FALSE_CALL_PRICE` | 250 | Штраф за ложный вызов (тг) |
| `LOW_RATING` | 3.0 | Рейтинг ниже → пропуск каждого 2-го |
| `STREET_ALIASES` | 16 пар | Новые → старые названия улиц |

## Известные ограничения и нюансы

1. **Баланс водителя**: `order_balance = 999999` = бесплатный пробный период (баланс не списывается)
2. **Режим распределения**: `settings.distribution_mode` = `queue` (по позиции) или `broadcast`
3. **Green API кнопки**: максимум 3 кнопки; fallback на текст при неудаче
4. **Rate limit**: 30 сообщений за 60 сек (in-memory, сбрасывается при рестарте)
5. **Брутфорс admin**: 5 попыток → блок 15 мин (таблица `admin_attempts` — переживает рестарт)
6. **RLS в Supabase**: отключён; бот использует service role key
7. **Зависшие заказы**: >10 мин в `searching` → `orderEngine.cancel()` каждые 5 мин
8. **Дедупликация**: Green API дублирует вебхуки → in-memory Set + таблица `message_dedup`
9. **dispatch_queue**: итеративный while-loop (не рекурсия) — исправлен AUDIT-10
10. **Swap**: на сервере нет swap-памяти (e2-micro) — риск OOM при пике
11. **stateMachine.js**: мёртвый код — файл существует но нигде не импортируется
12. **Timezone**: сервер UTC+1/2, бот использует UTC+5 Almaty через `Date.now() + 5*3600_000`
13. **Webhook security**: проверяется только `instanceData.idInstance` — нет HMAC
14. **getSetting()**: кеш 60 сек (adminQueries.js) — при изменении через setSetting() кеш чистится
15. **intercity_time**: состояния нет в коде, flow: `intercity_pickup → intercity_confirm`

## Hermes — автономный агент мониторинга

`agent/hermes.js` запускается отдельным PM2-процессом и каждые 5 минут:
- Проверяет статус бота через SSH (pm2 list, pm2 logs, ошибки)
- Анализирует ситуацию через Qwen3-32b (быстрый, дешёвый LLM)
- При ошибках в логах — обращается к Claude claude-sonnet-4-6 (`agent/tools.js:askClaude`)
- Запоминает паттерны в таблице `agent_memory` (важность 1-10)
- Алерты: пишет в `agent_memory` (ключ `alert_current`) + WhatsApp на `admin_phone`

**CLI команды:**
```bash
node agent/hermes.js monitor   # Один цикл мониторинга
node agent/hermes.js ask "вопрос"  # Спросить агента
node agent/hermes.js memory    # Показать память
node agent/hermes.js stats     # Статистика бота
node agent/hermes.js loop      # Непрерывный мониторинг (PM2)
```

### ⚠️ Известные ложные алерты Hermes

Hermes работает НА том же сервере (GCP e2-micro), поэтому часть алертов — ложные:

| Алерт | Причина | Реальная проблема? |
|-------|---------|-------------------|
| "Потеря SSH-доступа" | Hermes пытается `ssh` сам на себя — ключ не настроен для loopback | ❌ Нет, ложный |
| "Отсутствие тарифов" | Qwen3 неверно интерпретирует PM2-логи при старте | ❌ Нет, проверь `pm2 logs` |
| "Бот упал" | Может быть реальным — проверь `pm2 list` | ⚠️ Нужно проверить |
| "Нет заказов X часов" | Может быть реальным в ночное время | ⚠️ Проверь Green API |

**Как проверить реальную ситуацию** при получении алерта:
```bash
ssh -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202 "pm2 list && pm2 logs osakarovka-bot --lines 10 --nostream"
```

> Telegram-интерфейс (`agent/index.js`) удалён — не использовался.

## Команды водителей (ключевые слова в router.js)

| Команда | Ключевые слова |
|---------|----------------|
| На линию | на линию, выхожу, начинаю, работаю, онлайн, старт, начать, жұмыс, жұмысқа, линияға шығам, шығамын |
| С линии | с линии, офлайн, стоп, отдых, аяқтадым |
| Принял | принял, принять, беру, аламын, принимаю |
| Прибыл | прибыл, приехал, на месте, подъехал, стою, келдім |
| Свободен | свободен, завершил, бостымын, доехали, готово |
| Ложный | ложный, нет клиента, жалған |
| Пропустить | пропустить, пропуск, откізу |
| Статистика | статистика, стат, итоги, заработок, қанша |
| Очередь | очередь, позиция, кезек |
| Прочее | faq, фак, перерыв |

## Дополнительные таблицы БД (не в SUPABASE_SCHEMA.md)

| Таблица | Создана в | Описание |
|---------|-----------|----------|
| `message_dedup` | migration_v2.sql | Дедупликация вебхуков Green API: `msg_id`, `received_at` |
| `admin_attempts` | migration_v2.sql | Брутфорс-защита: `phone`, `attempt_count`, `locked_until` |
| `agent_memory` | migrations/001 | Долгосрочная память Hermes (category, key, content, importance 1-10) |
| `agent_conversations` | migrations/001 | История диалогов агента |
| `agent_tasks` | migrations/001 | Задачи для Claude Code (pending/completed/failed) |

### Ключ `admin_phone` в таблице `settings`
```sql
-- Установить телефон администратора для получения алертов:
INSERT INTO settings(key,value) VALUES('admin_phone','77XXXXXXXXX')
ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
```
Используется в `timerService.js` для WhatsApp-уведомлений об ошибках и тишине.

---

## Незакрытый техдолг (из аудита 2026-06-05)

### 🔴 Высокий приоритет
| # | Проблема | Файл | Усилие |
|---|----------|------|--------|
| TD-01 | Нет транзакций в `complete()` — 12+ последовательных запросов без rollback | `orderEngine.js:257` | 2-3 ч |
| TD-02 | `checkDispatchTimeouts` при рестарте отменяет заказ вместо `resumeDispatch` | `timerService.js:134` | 2 ч |
| ~~TD-03~~ | ~~5 недостающих индексов БД~~ | ✅ Исправлено — `migrations/002_performance_indexes.sql` (7 индексов) |
| TD-04 | Webhook без HMAC — `instanceData.idInstance` подделывается (CVSS 8.6) | `src/index.js:73` | 1-2 ч |

### 🟡 Средний приоритет
| # | Проблема | Файл |
|---|----------|------|
| TD-05 | Тестовое покрытие 17% — нет тестов для `orderEngine`, `driverManager`, `scheduleParser` | `tests/unit/` |
| TD-06 | `stateMachine.js` мёртвый код — нигде не импортируется | `src/modules/stateMachine.js` |
| TD-07 | `supabaseClient.js` мёртвый код в `src/lib/` | `src/lib/supabaseClient.js` |
| TD-08 | Межгород: цена ищется по `destination`, не по маршруту | `clientOrderHandler.js:244` |
| ~~TD-09~~ | ~~`_groqCounts` Map никогда не чистится~~ | ✅ Исправлено — `_rateLimits` с setInterval |
| TD-10 | `addressDetector` cache — unbounded Map (нет MAX_SIZE) | `addressDetector.js` |
| ~~TD-11~~ | ~~Hermes: ложные алерты~~ | ✅ Временно решено — `hermes-agent` отключён из PM2 (`ecosystem.config.js`) |

---

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

-- Предзаказы ожидающие запуска
SELECT id, destination, scheduled_time, scheduled_reminder_sent
FROM orders WHERE status = 'scheduled' ORDER BY scheduled_time;

-- Статистика сегодня
SELECT COUNT(*) FILTER(WHERE status='completed') AS done,
       COALESCE(SUM(price) FILTER(WHERE status='completed'),0) AS revenue
FROM orders WHERE created_at::date=CURRENT_DATE;

-- Память агента (критичное)
SELECT category, key, content, importance FROM agent_memory
WHERE importance >= 8 ORDER BY importance DESC;

-- Задачи агента для Claude Code
SELECT id, description, status, created_at FROM agent_tasks
WHERE status = 'pending' ORDER BY created_at;
```
