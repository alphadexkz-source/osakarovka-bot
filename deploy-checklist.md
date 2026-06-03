# Deploy Checklist — еОсакаровка Сервис

Обязательные шаги перед каждым деплоем. Выполнять по порядку.

---

## 🔴 ПЕРВЫЙ ДЕПЛОЙ (один раз)

### 1. Запустить миграции в Supabase SQL Editor

Открыть: https://supabase.com/dashboard/project/jgnfjawqacmaqhgpsbcj/editor

```sql
-- Запустить src/db/migration_v2.sql
-- Добавляет: orders.dispatched_to, orders.dispatched_at, orders.arrive_warned
-- Добавляет: таблицу admin_attempts (защита /admin от брутфорса)
```

```sql
-- Запустить src/db/migration_v3.sql
-- Добавляет: drivers.break_until (перерывы без потери состояния)
-- Добавляет: таблицу message_dedup (дедупликация вебхуков)
```

**Проверить что миграции применены:**
```sql
-- Должно вернуть 3 строки
SELECT column_name FROM information_schema.columns
WHERE table_name='orders' AND column_name IN ('dispatched_to','dispatched_at','arrive_warned');

-- Должно вернуть 2 строки
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('admin_attempts','message_dedup');

-- Должен быть столбец break_until
SELECT column_name FROM information_schema.columns
WHERE table_name='drivers' AND column_name='break_until';
```

### 2. Вбить тарифы

Без тарифов бот принимает заказы по цене по умолчанию (500 тг).

Способ 1 — через WhatsApp: написать боту `/admin 2010`, затем «Добавить тариф»

Способ 2 — через Supabase SQL:
```sql
INSERT INTO tariffs (name, keywords, day_price, night_price) VALUES
  ('По посёлку',    '{}',                              500,  700),
  ('ЖД станция',    '{"жд","вокзал","станция"}',      1500, 2000),
  ('Элеватор',      '{"элеватор"}',                    700, 1000),
  ('Темиртау',      '{"темиртау"}',                  12000, 15000),
  ('Астана',        '{"астана","нурсултан"}',         18000, 22000);
-- Добавить остальные направления по необходимости
```

### 3. Настроить admin_phone

```sql
INSERT INTO settings (key, value) VALUES ('admin_phone', '77XXXXXXXXX')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

### 4. Проверить .env на сервере

```bash
ssh -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202
cat ~/osakarovka-bot/.env
```

Все переменные должны быть заполнены:
- `GREEN_API_ID=7107636283`
- `GREEN_API_TOKEN=...` (не пустой)
- `DATABASE_URL=...` (Supabase connection string)
- `ADMIN_PIN=...` (не менее 4 символов)
- `DRIVER_CODE=...` (код для регистрации водителей)
- `GROQ_API_KEY=...`
- `PORT=3000`

---

## 🟡 КАЖДЫЙ ДЕПЛОЙ

### 1. Локально — подготовка

```bash
# Проверить синтаксис
node --check src/index.js

# Убедиться что тесты проходят (если есть)
node test_bot.js        # 49 проверок
node test_realworld.js  # 105 проверок (требует живой БД)
```

### 2. Git push

```bash
git add -A
git commit -m "fix/feat: описание изменения"
git push
```

### 3. Деплой на сервер

```powershell
# PowerShell (Windows — из-за кириллицы в пути)
$keyPath = "C:\Users\пользователь\.ssh\google_compute_engine"
ssh -i $keyPath alphadexkz@34.40.3.202 "cd ~/osakarovka-bot && git pull && npm install --production && pm2 restart osakarovka-bot"
```

### 4. Проверить логи после деплоя

```bash
ssh -i $keyPath alphadexkz@34.40.3.202 "pm2 logs osakarovka-bot --lines 30 --nostream"
```

**Ожидаемый вывод при здоровом старте:**
```
==================================================
🚖  еОсакаровка Сервис Bot  v2.0.0
==================================================
🟢  Порт:             3000
📡  Green API:        7107636283
⏱   Таймаут заказа:  40 сек
...
[DB] Connected to PostgreSQL
[TimerService] Запуск...
✅ Зависших заказов нет
✅ Тарифов в базе: N
```

**Красные флаги (требуют внимания):**
- `ТАРИФЫ НЕ ДОБАВЛЕНЫ` → вбить тарифы
- `[DB] Connection attempt X failed` → проблема с Supabase
- `[UNCAUGHT EXCEPTION]` → критическая ошибка в коде
- `relation "admin_attempts" does not exist` → не запущена migration_v2.sql

---

## 🟢 ПРОВЕРКА РАБОТОСПОСОБНОСТИ

### Health check

```bash
curl http://34.40.3.202:3000/
# Ожидаемый ответ:
# {"service":"еОсакаровка Сервис","status":"running","time":"...","stats":{...}}
```

### Функциональная проверка (в WhatsApp)

1. Напишите боту **«Привет»** → должен ответить приветствием
2. Напишите боту **«Ленина 5»** → должен предложить заказ с ценой
3. Подтвердите заказ → должен начать поиск водителя
4. Отмените заказ → должен подтвердить отмену

### Проверка водительского аккаунта

1. Отправьте код водителя (`DRIVER_CODE`) → начнётся регистрация
2. Пройдите все шаги регистрации
3. Напишите **«на линию»** → должен появиться в очереди

---

## 🔧 ЧАСТЫЕ ПРОБЛЕМЫ

| Симптом | Причина | Решение |
|---------|---------|---------|
| Бот не отвечает | PM2 не запущен | `pm2 restart osakarovka-bot` |
| Ошибка при входе `/admin` | migration_v2 не запущена | Запустить migration_v2.sql |
| Заказ не создаётся | Тарифов 0 | Добавить тарифы |
| Водитель не получает заказ | Нет онлайн-водителей или баланс 0 | Проверить статус водителей |
| `Cannot find module` | `npm install` не запускался | `npm install --production` |
| Логи не пишутся в файл | `logs/` директория не создана | `mkdir -p ~/osakarovka-bot/logs` |

---

## 📊 МОНИТОРИНГ

```bash
# Статус процесса
pm2 list

# Последние ошибки
tail -50 ~/osakarovka-bot/logs/errors.log

# Последние заказы
tail -50 ~/osakarovka-bot/logs/orders.log

# Использование памяти
free -m

# Использование диска
df -h
```

---

## 🔄 ОТКАТ (если что-то пошло не так)

```bash
# Откатить последний коммит на сервере
cd ~/osakarovka-bot
git log --oneline -5           # смотрим что откатывать
git checkout <предыдущий_хеш>  # откатываемся
pm2 restart osakarovka-bot
```

---

*Последнее обновление: 2026-06-03 — v2.0.0 (Stage 1-4 рефакторинг)*
