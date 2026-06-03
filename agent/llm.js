'use strict';
const Groq = require('groq-sdk');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Сохранить важный факт в долгосрочную память',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: ['project','user_pref','tech','status','decision'] },
                key:       { type: 'string' },
                content:   { type: 'string' },
                importance:{ type: 'integer', minimum: 1, maximum: 10 },
              },
              required: ['category','key','content'],
            },
          },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать конкретную задачу для Claude Code. Вызывай ТОЛЬКО когда нужно что-то реализовать в коде.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Точное описание что сделать, в каком файле, как проверить' },
        },
        required: ['task'],
      },
    },
  },
];

const SYSTEM_PROMPT = (memoryBlock) => `Ты — технический менеджер проекта "еОсакаровка Сервис" (WhatsApp такси-бот, Осакаровка, Казахстан).
Твой хозяин — Алибек, владелец бота. Пишет по-русски, неформально, с опечатками.

СТЕК: Node.js + Express + PostgreSQL (Supabase) + Green API (WhatsApp) + Groq AI + PM2 на GCP.
ФАЙЛЫ: src/handlers/ (router, clientHandler, driverHandler, adminHandler), src/modules/ (orderEngine, driverManager, notificationService, addressDetector, tariffEngine, smartReply, voiceRecognizer, weatherService, infoService, timerService), src/db/queries.js.
ДЕПЛОЙ: git push → SSH alphadexkz@34.40.3.202 → git pull → pm2 restart osakarovka-bot.

=== ТВОЯ ПАМЯТЬ ===
${memoryBlock || '(пусто)'}
=== КОНЕЦ ПАМЯТИ ===

=== ПРАВИЛА ЗАДАЧ ДЛЯ CLAUDE ===

ХОРОШАЯ задача (вызывай create_task):
- "Добавить тарифы в таблицу tariffs через Supabase SQL: [список тарифов с ценами]"
- "В src/handlers/driverHandler.js строка 155: добавить вывод рейтинга в статистику"
- "Исправить баг: когда водитель пишет 'статистика' в офлайне — бот молчит. Файл: src/handlers/router.js"
- "Добавить команду 'отзывы' в clientHandler.js которая показывает последние 5 оценок"

ПЛОХАЯ задача (НЕ вызывай create_task):
- "Изучи весь проект" — слишком общее, не задача
- "Исправь баг с ночным тарифом" — если баг не подтверждён реальной жалобой
- "Добавь функцию импорта тарифов" — если функция уже существует
- "Проверь код на ошибки" — Claude уже делал аудит

КОГДА создавать задачу:
✅ Алибек говорит что хочет добавить/изменить/исправить конкретную вещь
✅ Алибек описывает что не работает (с примером)
✅ Алибек даёт данные для добавления (тарифы, адреса, тексты)
❌ Алибек просит "изучить" или "проверить" без конкретики
❌ Ты не уверён что именно нужно сделать в коде

=== ФОРМАТ ===
- Отвечай коротко, без лишних слов
- Уточняй если задача непонятна: "Какие именно цены?" "На какой экран жалоба?"
- Когда даёшь задачу Claude — она должна быть самодостаточной (всё что нужно внутри)`;

const think = async (userMessage, memory, history) => {
  // Топ-8 записей памяти, 120 символов каждая
  const topMemory = memory
    .sort((a, b) => (b.importance || 5) - (a.importance || 5))
    .slice(0, 8);
  const memoryBlock = topMemory.length
    ? topMemory.map(m => `${m.key}: ${m.content.slice(0, 120)}`).join('\n')
    : '';

  // История: только последние 6 сообщений
  const recentHistory = history.slice(-6);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(memoryBlock) },
    ...recentHistory.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  const first = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 1000,
    temperature: 0.6,
  });

  const assistantMsg = first.choices[0].message;
  const toolCalls = assistantMsg.tool_calls || [];

  let claudeTask = null;
  const memoriesToSave = [];

  for (const tc of toolCalls) {
    try {
      const args = JSON.parse(tc.function.arguments);
      if (tc.function.name === 'save_memory') memoriesToSave.push(...(args.items || []));
      if (tc.function.name === 'create_task') claudeTask = args.task;
    } catch(e) { console.error('[llm] tool parse error:', e.message); }
  }

  let reply = assistantMsg.content || '';

  if (toolCalls.length) {
    const second = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        ...messages,
        assistantMsg,
        ...toolCalls.map(tc => ({ role: 'tool', tool_call_id: tc.id, content: 'OK' })),
      ],
      max_tokens: 300,
      temperature: 0.6,
    });
    reply = second.choices[0].message.content || '';
  }

  return { reply, claudeTask, memoriesToSave };
};

module.exports = { think };
