'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { Bot } = require('grammy');
const mem = require('./memory');
const llm = require('./llm');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const OWNER   = parseInt(process.env.TELEGRAM_OWNER_ID || '0');

if (!TOKEN) {
  console.error('[Agent] TELEGRAM_BOT_TOKEN не задан в .env');
  process.exit(1);
}

const bot = new Bot(TOKEN);

// ─── АВТОРИЗАЦИЯ ─────────────────────────────────────────────
bot.use(async (ctx, next) => {
  if (OWNER && ctx.from?.id !== OWNER) {
    await ctx.reply('❌ Нет доступа.');
    return;
  }
  await next();
});

// ─── КОМАНДЫ (только ASCII — Telegram не поддерживает кириллицу) ──
bot.command('start', ctx => ctx.reply(
  '🤖 *Агент еОсакаровка активирован*\n\n' +
  'Просто пиши что хочешь — пойму, запомню, поставлю задачу Claude.\n\n' +
  '🧠 память — что знаю о проекте\n' +
  '📋 задачи — история задач для Claude\n' +
  '📊 статус — текущее состояние\n' +
  '🗑 забыть [слово] — удалить из памяти',
  { parse_mode: 'Markdown' }
));

// ─── ГЛАВНЫЙ ОБРАБОТЧИК СООБЩЕНИЙ ────────────────────────────
bot.on('message:text', async ctx => {
  const text = ctx.message.text;
  const lo = text.toLowerCase().trim();

  // Команды на русском (без слеша — Telegram не поддерживает кириллицу в /командах)
  if (lo === 'память' || lo === '/memory') {
    const all = await mem.getAll();
    if (!all.length) return ctx.reply('📭 Память пуста.');
    const lines = all.slice(0, 20).map(m =>
      `• *[${m.category}]* ${m.key}\n  ${m.content.slice(0, 120)}${m.content.length > 120 ? '…' : ''}`
    ).join('\n\n');
    return ctx.reply('🧠 *Моя память:*\n\n' + lines, { parse_mode: 'Markdown' });
  }

  if (lo === 'задачи' || lo === '/tasks') {
    const tasks = await mem.getRecentTasks(8);
    if (!tasks.length) return ctx.reply('📭 Задач пока нет.');
    const lines = tasks.map((t, i) => {
      const preview = t.description.slice(0, 80).replace(/\n/g, ' ');
      const date = new Date(t.created_at).toLocaleDateString('ru-RU', { day:'numeric', month:'short' });
      return `${i+1}. [${t.status}] ${preview}…\n   📅 ${date}`;
    }).join('\n\n');
    return ctx.reply('📋 *Последние задачи:*\n\n' + lines, { parse_mode: 'Markdown' });
  }

  if (lo === 'статус' || lo === '/status') {
    const all = await mem.getAll();
    const statusMems = all.filter(m => m.category === 'status');
    if (!statusMems.length) return ctx.reply('📊 Статус: бот работает на продакшне.');
    const lines = statusMems.map(m => `• *${m.key}:* ${m.content}`).join('\n');
    return ctx.reply('📊 *Статус проекта:*\n\n' + lines, { parse_mode: 'Markdown' });
  }

  if (lo.startsWith('забыть ') || lo.startsWith('/forget ')) {
    const keyword = lo.replace(/^забыть |^\/forget /, '').trim();
    const count = await mem.forget(keyword);
    return ctx.reply(count > 0 ? `🗑 Удалено записей: ${count}` : '🤷 Ничего не нашёл по этому слову.');
  }

  if (lo.startsWith('/')) return;

  let statusMsgId;
  try {
    // Показываем что думаем
    const statusMsg = await ctx.reply('🤔 Думаю…');
    statusMsgId = statusMsg.message_id;

    // Загружаем контекст параллельно
    const [memory, history] = await Promise.all([
      mem.getAll(),
      mem.getHistory(16),
    ]);

    // Сохраняем сообщение пользователя
    await mem.addMessage('user', text);

    // Получаем ответ от LLM
    const result = await llm.think(text, memory, history);

    // Сохраняем ответ в историю
    await mem.addMessage('assistant', result.reply);

    // Сохраняем новые воспоминания
    for (const m of result.memoriesToSave) {
      await mem.remember(m.category, m.key, m.content, m.importance || 5);
    }

    // Удаляем «Думаю…»
    await ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});

    // Отправляем ответ
    await ctx.reply(result.reply || '👍', { parse_mode: 'Markdown' }).catch(() =>
      ctx.reply(result.reply || '👍')
    );

    // Если есть задача для Claude — отправляем отдельным сообщением
    if (result.claudeTask) {
      await mem.saveTask(text, result.claudeTask);
      const taskMsg =
        '━━━━━━━━━━━━━━━━━━━━━\n' +
        '📋 *ЗАДАЧА ДЛЯ CLAUDE CODE:*\n\n' +
        result.claudeTask +
        '\n━━━━━━━━━━━━━━━━━━━━━';
      await ctx.reply(taskMsg, { parse_mode: 'Markdown' }).catch(() =>
        ctx.reply(taskMsg)
      );
    }

  } catch (err) {
    console.error('[Agent]', err.message);
    if (statusMsgId) {
      await ctx.api.deleteMessage(ctx.chat.id, statusMsgId).catch(() => {});
    }
    await ctx.reply('⚠️ Ошибка: ' + err.message);
  }
});

// ─── ЗАПУСК ──────────────────────────────────────────────────
bot.start({
  onStart: (info) => console.log(`[Agent] @${info.username} запущен`),
});

process.on('unhandledRejection', err => console.error('[Agent] unhandled:', err?.message));
