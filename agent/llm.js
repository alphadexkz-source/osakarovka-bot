'use strict';
const Groq = require('groq-sdk');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

// Инструменты которые может вызывать агент
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'save_memory',
      description: 'Сохранить важный факт, решение или предпочтение в долгосрочную память',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: {
                  type: 'string',
                  enum: ['project', 'user_pref', 'tech', 'status', 'decision'],
                  description: 'project=о боте, user_pref=предпочтения Алибека, tech=технические решения, status=текущий статус, decision=принятые решения',
                },
                key:       { type: 'string', description: 'Короткий ключ для поиска' },
                content:   { type: 'string', description: 'Содержимое для запоминания' },
                importance:{ type: 'integer', minimum: 1, maximum: 10 },
              },
              required: ['category', 'key', 'content'],
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
      description: 'Создать задачу для Claude Code когда нужно что-то реализовать в коде бота',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'Подробное описание: что сделать, в каких файлах, почему, примеры если нужно',
          },
        },
        required: ['task'],
      },
    },
  },
];

const SYSTEM_PROMPT = (memoryBlock) => `Ты — ИИ-менеджер проекта еОсакаровка. Твой хозяин — Алибек (владелец WhatsApp такси-бота).

## Проект
еОсакаровка Сервис — WhatsApp-бот диспетчерской службы такси, посёлок Осакаровка, Казахстан.
Стек: Node.js + Express + PostgreSQL (Supabase) + Green API (WhatsApp) + Groq AI.
Сервер: GCP VM 34.40.3.202, PM2.
Файлы: src/handlers/ (router, clientHandler, driverHandler, adminHandler), src/modules/ (orderEngine, driverManager, notificationService, addressDetector, tariffEngine, smartReply, voiceRecognizer, weatherService, infoService, timerService), src/db/queries.js, src/whatsapp/greenApi.js.
Деплой: git push → SSH → git pull → pm2 restart osakarovka-bot.

## Твоя память
${memoryBlock || '(пока пусто)'}

## Твои задачи
1. Понимать Алибека — он пишет по-русски, неформально, с опечатками
2. Запоминать важное через save_memory (новые решения, статус задач, предпочтения)
3. Когда нужно что-то в коде — вызывать create_task с чётким ТЗ для Claude Code
4. Отвечать коротко и по делу

## Как писать задачи для Claude Code
- Конкретно: «В файле src/handlers/driverHandler.js добавь...»
- С контекстом: что сейчас не работает и почему нужно
- Claude Code сам делает, коммитит и деплоит — просто опиши задачу

## Формат ответов
- Короткие ответы в Telegram Markdown
- Если задача готова — в конце напиши: «✅ Задача создана для Claude»
- Не объясняй очевидное`;

const think = async (userMessage, memory, history) => {
  const memoryBlock = memory.length
    ? memory.map(m => `[${m.category}] ${m.key}: ${m.content}`).join('\n')
    : '';

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT(memoryBlock) },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage },
  ];

  // Первый вызов — с инструментами
  const first = await getGroq().chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 1500,
    temperature: 0.7,
  });

  const assistantMsg = first.choices[0].message;
  const toolCalls = assistantMsg.tool_calls || [];

  let claudeTask = null;
  const memoriesToSave = [];

  for (const tc of toolCalls) {
    const args = JSON.parse(tc.function.arguments);
    if (tc.function.name === 'save_memory') {
      memoriesToSave.push(...(args.items || []));
    }
    if (tc.function.name === 'create_task') {
      claudeTask = args.task;
    }
  }

  let reply = assistantMsg.content || '';

  // Если были tool_calls — делаем второй вызов для текстового ответа
  if (toolCalls.length) {
    const toolResults = toolCalls.map(tc => ({
      role: 'tool',
      tool_call_id: tc.id,
      content: 'OK',
    }));

    const second = await getGroq().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [...messages, assistantMsg, ...toolResults],
      max_tokens: 600,
      temperature: 0.7,
    });

    reply = second.choices[0].message.content || '';
  }

  return { reply, claudeTask, memoriesToSave };
};

module.exports = { think };
