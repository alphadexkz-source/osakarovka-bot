# STARTUP — еОсакаровка Сервис

## Быстрый старт сессии

Прочитай `CLAUDE.md` — там полная актуальная архитектура проекта.

---

## Быстрые команды

### Проверить состояние бота
```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202 "pm2 list && pm2 logs osakarovka-bot --lines 20 --nostream"
```

### Деплой
```bash
git add -A && git commit -m "fix: ..." && git push
ssh -o StrictHostKeyChecking=no -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202 \
  "cd ~/osakarovka-bot && git pull && npm install --production && pm2 restart ecosystem.config.js && pm2 logs --lines 15 --nostream"
```

### Self-healing (зависшие данные)
```sql
-- Зависшие заказы
UPDATE orders SET status='cancelled', cancel_reason='Автоотмена'
WHERE status='searching' AND created_at < NOW()-INTERVAL '30 minutes';
-- Зависшие сессии
UPDATE sessions SET state='idle', ctx='{}'
WHERE state != 'idle' AND updated_at < NOW()-INTERVAL '2 hours';
```

### Hermes агент (мониторинг)
```bash
node agent/hermes.js monitor   # Один цикл
node agent/hermes.js ask "почему нет заказов?"
node agent/hermes.js stats
```
