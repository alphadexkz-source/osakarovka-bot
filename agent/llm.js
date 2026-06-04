'use strict';

// Claude claude-sonnet-4-6 с prompt caching
// Системный промпт кешируется 5 мин — повторные вызовы 90% дешевле
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-sonnet-4-6';

// Claude tool format (input_schema вместо parameters)
const TOOLS = [
  {
    name: 'save_memory',
    description: 'Сохранить важный факт в долгосрочную память',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category:   { type: 'string', enum: ['project','user_pref','tech','status','decision'] },
              key:        { type: 'string' },
              content:    { type: 'string' },
              importance: { type: 'integer', minimum: 1, maximum: 10 },
            },
            required: ['category','key','content'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'create_task',
    description: 'Создать конкретную задачу для Claude Code. Вызывай ТОЛЬКО когда нужно что-то реализовать в коде.',
    input_schema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Точное описание что сделать, в каком файле, как проверить' },
      },
      required: ['task'],
    },
  },
];

const SYSTEM_PROMPT = (memoryBlock) =>
`Ты — технический менеджер проекта "еОсакаровка Сервис" (WhatsApp такси-бот, Осакаровка, Казахстан).
Твой хозяин — Алибек, владелец бота. Пишет по-русски, неформально, с опечатками.

СТЕК: Node.js + Express + PostgreSQL (Supabase) + Green API (WhatsApp) + Groq AI + PM2 на GCP.
ФАЙЛЫ: src/handlers/ (router, clientHandler, driverHandler, adminHandler), src/modules/ (orderEngine, driverManager, notificationService, addressDetector, tariffEngine, smartReply, voiceRecognizer, timerService), src/db/queries/.
ДЕПЛОЙ: git push → SSH alphadexkz@34.40.3.202 → git pull → pm2 restart osakarovka-bot.
СУPABASE: project jgnfjawqacmaqhgpsbcj, eu-west-1, RLS отключён.

=== ТВОЯ ПАМЯТЬ ===
${memoryBlock || '(пусто)'}
=== КОНЕЦ ПАМЯТИ ===

=== ПРАВИЛА ЗАДАЧ ДЛЯ CLAUDE ===

ХОРОШАЯ задача (вызывай create_task):
- "Добавить тарифы в таблицу tariffs через Supabase SQL: [список с ценами]"
- "В src/handlers/driverHandler.js строка 155: добавить вывод рейтинга в статистику"
- "Исправить баг: водитель пишет 'статистика' в офлайне — бот молчит. Файл: router.js"

ПЛОХАЯ задача (НЕ вызывай create_task):
- "Изучи весь проект" — слишком общее
- "Исправь баг с ночным тарифом" — не подтверждён реальной жалобой
- "Проверь код на ошибки" — аудит уже сделан

КОГДА создавать задачу:
✅ Алибек говорит что хочет добавить/изменить/исправить конкретную вещь
✅ Алибек описывает что не работает (с примером)
✅ Алибек даёт данные для добавления (тарифы, адреса, тексты)
❌ Алибек просит "изучить" или "проверить" без конкретики

=== ФОРМАТ ===
- Отвечай коротко, без лишних слов
- Уточняй если задача непонятна
- Задача для Claude должна быть самодостаточной`;

const callClaude = async (messages, system) => {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type':    'application/json',
      'x-api-key':       process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta':  'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system, messages, tools: TOOLS }),
  });

  if (!resp.ok) {
    const err = await resp.text().catch(() => '');
    throw new Error(`Claude API ${resp.status}: ${err.slice(0, 200)}`);
  }
  return resp.json();
};

const think = async (userMessage, memory, history) => {
  // Все 50 записей памяти (было: top-8) — caching делает большой контекст дешёвым
  const memoryBlock = memory.length
    ? memory
        .sort((a, b) => (b.importance || 5) - (a.importance || 5))
        .map(m => `[${m.category}] ${m.key}: ${m.content.slice(0, 200)}`)
        .join('\n')
    : '';

  // Системный промпт с cache_control — кешируется 5 минут, последующие вызовы ~90% дешевле
  const system = [{ type: 'text', text: SYSTEM_PROMPT(memoryBlock), cache_control: { type: 'ephemeral' } }];

  // История: последние 20 сообщений (было: 6)
  const messages = [
    ...history.slice(-20).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const first = await callClaude(messages, system);

  const toolUseBlocks = first.content.filter(b => b.type === 'tool_use');
  let claudeTask = null;
  const memoriesToSave = [];

  for (const block of toolUseBlocks) {
    if (block.name === 'save_memory') memoriesToSave.push(...(block.input.items || []));
    if (block.name === 'create_task') claudeTask = block.input.task;
  }

  let reply = first.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

  // Если были tool_use — второй вызов для текстового ответа
  if (toolUseBlocks.length > 0) {
    const toolResults = toolUseBlocks.map(b => ({
      type: 'tool_result',
      tool_use_id: b.id,
      content: 'OK',
    }));

    const second = await callClaude(
      [
        ...messages,
        { role: 'assistant', content: first.content },
        { role: 'user',      content: toolResults },
      ],
      system
    );

    reply = second.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  }

  return { reply, claudeTask, memoriesToSave };
};

module.exports = { think };
