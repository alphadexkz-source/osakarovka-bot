# STARTUP — еОсакаровка Сервис

## Команда запуска (вставляй в начале каждой сессии)

```
Ты — автономная команда агентов проекта еОсакаровка Сервис (WhatsApp-такси, Осакаровка, Казахстан).

Прочитай CLAUDE.md и .claude/agents/*.md — там вся архитектура, команда и роли.

Твои автономные полномочия:
- npm install пакеты
- SSH на сервер: ssh -o StrictHostKeyChecking=no -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202
- Supabase MCP для SQL
- Создавать новых агентов в .claude/agents/
- git commit + push + deploy самостоятельно

Активные агенты: master-orchestrator, ceo-pm, cto-architect, backend-engineer, ai-engineer, devops-sre, qa-bug-hunter, data-gis-engineer, driver-operations, product-growth, security-officer, analytics-engineer, finance-billing, customer-support, monitoring-selfheal, content-manager, integration-specialist, marketing-specialist, legal-compliance

Первым делом: проверь состояние бота (PM2 логи) и доложи статус.
```

---

## Быстрые команды

### Проверить состояние бота
```bash
ssh -o StrictHostKeyChecking=no -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202 "pm2 list && pm2 logs osakarovka-bot --lines 20 --nostream"
```

### Деплой
```bash
git add -A && git commit -m "fix: ..." && git push && ssh -o StrictHostKeyChecking=no -i ~/.ssh/google_compute_engine alphadexkz@34.40.3.202 "cd ~/osakarovka-bot && git pull && pm2 restart osakarovka-bot && sleep 3 && pm2 logs osakarovka-bot --lines 10 --nostream"
```

### Self-healing (зависшие данные)
```sql
-- Зависшие заказы
UPDATE orders SET status='cancelled', cancel_reason='Автоотмена' WHERE status='searching' AND created_at < NOW()-INTERVAL '30 minutes';
-- Зависшие сессии  
UPDATE sessions SET state='idle', ctx='{}' WHERE state != 'idle' AND updated_at < NOW()-INTERVAL '2 hours';
```

---

## Состав команды (19 агентов)

| # | Агент | Роль |
|---|-------|------|
| 1 | master-orchestrator | Главный, маршрутизация |
| 2 | ceo-pm | Приоритеты, бизнес |
| 3 | cto-architect | Архитектура |
| 4 | backend-engineer | Node.js разработка |
| 5 | ai-engineer | Groq, промпты, AI |
| 6 | devops-sre | Сервер, деплой |
| 7 | qa-bug-hunter | Тесты, баги |
| 8 | data-gis-engineer | БД, адреса |
| 9 | driver-operations | Водители, очередь |
| 10 | product-growth | UX, фичи |
| 11 | security-officer | Безопасность |
| 12 | analytics-engineer | Аналитика, KPI |
| 13 | finance-billing | Финансы, балансы |
| 14 | customer-support | Поддержка клиентов |
| 15 | monitoring-selfheal | Мониторинг |
| 16 | content-manager | Тексты, контент |
| 17 | integration-specialist | API интеграции |
| 18 | marketing-specialist | Маркетинг, акции |
| 19 | legal-compliance | Право, соответствие |
