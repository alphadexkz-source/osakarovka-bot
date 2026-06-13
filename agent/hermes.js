#!/usr/bin/env node
// Hermes-агент еОсакаровка Сервис
// Умный автономный агент с долгосрочной памятью
// Использует Qwen3 (быстро) + Claude (глубокий анализ)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const memory  = require('./memory');
const tools   = require('./tools');

const AGENT_NAME = 'Hermes';
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // каждые 5 минут

// ─── СИСТЕМНЫЙ ПРОМПТ ─────────────────────────────────────────
const buildSystemPrompt = async () => {
  const critical = await memory.getCritical();
  const criticalText = critical.length
    ? '\n\nКРИТИЧНАЯ ПАМЯТЬ:\n' + critical.map(m => `[${m.category}] ${m.key}: ${m.content}`).join('\n')
    : '';

  return `Ты — ${AGENT_NAME}, автономный AI-агент проекта еОсакаровка Сервис.
Такси-бот для посёлка Осакаровка, Казахстан. Стек: Node.js, PostgreSQL, WhatsApp, Groq AI.

ТВОЯ РОЛЬ:
• Мониторишь работу бота каждые 5 минут
• Замечаешь проблемы ДО того как их заметит владелец
• Запоминаешь важные паттерны и решения
• Обращаешься к Claude для сложного анализа кода
• Докладываешь только о важном — не спамишь

ПРАВИЛА:
• Сначала думай — потом действуй
• Запоминай что сработало и что нет
• Не перезапускай бот без реальной причины
• При сомнении — спроси у Claude
• Критический уровень: бот упал / нет водителей > 30 мин / ошибки в DB${criticalText}`;
};

// ─── ПРИНЯТИЕ РЕШЕНИЙ ─────────────────────────────────────────
const think = async (situation) => {
  const systemPrompt = await buildSystemPrompt();

  const response = await tools.askGroq([
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `ТЕКУЩАЯ СИТУАЦИЯ:\n${situation}\n\n` +
        `Что нужно сделать? Ответь в формате JSON:\n` +
        `{ "actions": ["действие1", "действие2"], "remember": ["что запомнить"], "alert": "критично если есть / null", "needsClaude": false }`
    }
  ], 'qwen/qwen3-32b');

  try {
    const json = response.match(/\{[\s\S]*\}/)?.[0];
    return json ? JSON.parse(json) : { actions: [], remember: [], alert: null, needsClaude: false };
  } catch(e) {
    return { actions: [], remember: [], alert: null, needsClaude: false };
  }
};

// ─── МОНИТОРИНГ БОТА ─────────────────────────────────────────
const monitorBot = async () => {
  console.log(`[${AGENT_NAME}] Запускаю мониторинг...`);
  const taskId = await memory.logTask('monitor', 'Проверка состояния бота');

  try {
    const [status, logs, errors, stats] = await Promise.all([
      tools.getBotStatus(),
      tools.getLogs(20),
      tools.getErrors(),
      tools.getBotStats(),
    ]);

    const situation = [
      `=== СТАТУС PM2 ===\n${status.output?.slice(0, 500)}`,
      `=== ПОСЛЕДНИЕ ЛОГИ ===\n${logs.output?.slice(0, 800)}`,
      `=== ОШИБКИ ===\n${errors.output?.slice(0, 500)}`,
      `=== СТАТИСТИКА БД ===\n${JSON.stringify(stats, null, 2)}`,
    ].join('\n\n');

    // Принимаем решение
    const decision = await think(situation);

    // Запоминаем важное
    for (const item of (decision.remember || [])) {
      await memory.remember('learning', item.slice(0, 50), item, 6);
    }

    // Если нужен Claude для сложного анализа
    if (decision.needsClaude && errors.output?.includes('error')) {
      const claudeAnalysis = await tools.askClaude(
        `Проанализируй эти ошибки бота и предложи исправления:\n${errors.output}`,
        'еОсакаровка Сервис — WhatsApp такси-бот на Node.js'
      );
      await memory.remember('decision', 'claude_analysis_' + Date.now(), claudeAnalysis, 8, 'claude');
      console.log(`[${AGENT_NAME}] Claude ответил:`, claudeAnalysis.slice(0, 200));
    }

    // Алерт если критично — пишем в БД И отправляем WhatsApp администратору
    if (decision.alert) {
      await memory.remember('alert', 'alert_current', decision.alert, 10, 'monitor');
      console.log(`[${AGENT_NAME}] ⚠️ АЛЕРТ: ${decision.alert}`);
      const alertResult = await tools.sendAlert(decision.alert).catch(e => ({ ok: false, error: e.message }));
      if (!alertResult.ok) console.log(`[${AGENT_NAME}] WhatsApp alert failed: ${alertResult.error}`);
      else console.log(`[${AGENT_NAME}] WhatsApp alert отправлен администратору`);
    }

    await memory.completeTask(taskId, decision.actions?.join('; ') || 'OK');

    return { ok: true, decision };
  } catch(e) {
    await memory.completeTask(taskId, e.message, false);
    return { ok: false, error: e.message };
  }
};

// ─── АНАЛИЗ ПО ЗАПРОСУ ───────────────────────────────────────
const analyze = async (question) => {
  console.log(`[${AGENT_NAME}] Анализирую: ${question}`);

  // Ищем в памяти похожие случаи
  const related = await memory.search(question.slice(0, 30));
  const memoryContext = related.length
    ? '\nИз памяти:\n' + related.map(m => `• ${m.content}`).join('\n')
    : '';

  // Получаем актуальные данные
  const stats = await tools.getBotStats();
  const context = `Статистика: ${JSON.stringify(stats)}${memoryContext}`;

  // Сначала быстрый ответ через Qwen
  const quickAnswer = await tools.askGroq([
    { role: 'system', content: await buildSystemPrompt() },
    { role: 'user', content: `${context}\n\nВопрос: ${question}` }
  ]);

  // Если вопрос про код — подключаем Claude
  const needsCode = /код|исправ|баг|ошибк|deploy|деплой/.test(question.toLowerCase());
  if (needsCode) {
    const claudeAnswer = await tools.askClaude(question, context);
    await memory.remember('decision', question.slice(0, 50), claudeAnswer, 7, 'analyze');
    return `[Hermes]: ${quickAnswer}\n\n[Claude]: ${claudeAnswer}`;
  }

  await memory.remember('learning', question.slice(0, 50), quickAnswer, 5, 'analyze');
  return quickAnswer;
};

// ─── ОСНОВНОЙ ЦИКЛ ───────────────────────────────────────────
const startLoop = async () => {
  console.log(`\n🤖 ${AGENT_NAME} запущен!`);
  console.log(`📊 Интервал мониторинга: ${CHECK_INTERVAL_MS / 60000} мин`);
  console.log(`🧠 Память: Supabase (agent_memory)\n`);

  // Первый запуск — полный мониторинг
  await monitorBot();

  // Регулярный мониторинг
  setInterval(async () => {
    await monitorBot();
  }, CHECK_INTERVAL_MS);
};

// ─── CLI ИНТЕРФЕЙС ────────────────────────────────────────────
const handleCLI = async () => {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'monitor') {
    const result = await monitorBot();
    console.log('\n📊 Результат:', JSON.stringify(result.decision, null, 2));
    process.exit(0);
  }

  if (command === 'ask') {
    const question = args.slice(1).join(' ');
    if (!question) { console.log('Использование: node hermes.js ask <вопрос>'); process.exit(1); }
    const answer = await analyze(question);
    console.log('\n💬 Ответ:', answer);
    process.exit(0);
  }

  if (command === 'memory') {
    const memStats = await memory.stats();
    console.log('\n🧠 Статистика памяти:', memStats);
    const critical = await memory.getCritical();
    console.log('\n⚠️ Критические записи:', critical);
    process.exit(0);
  }

  if (command === 'stats') {
    const stats = await tools.getBotStats();
    console.log('\n📈 Статистика бота:', stats);
    process.exit(0);
  }

  if (command === 'loop') {
    await startLoop();
    return; // не выходим
  }

  // По умолчанию — показать помощь
  console.log(`
🤖 ${AGENT_NAME} — AI-агент еОсакаровка Сервис

Команды:
  node hermes.js monitor        # Один цикл мониторинга
  node hermes.js ask <вопрос>   # Спросить агента
  node hermes.js memory         # Показать память
  node hermes.js stats          # Статистика бота
  node hermes.js loop           # Запустить непрерывный мониторинг (PM2)

PM2 запуск:
  pm2 start hermes.js --name hermes-agent -- loop
  `);
  process.exit(0);
};

if (require.main === module) {
  handleCLI().catch(e => {
    console.error('[Hermes] Ошибка:', e.message);
    process.exit(1);
  });
}

module.exports = { monitorBot, analyze };
