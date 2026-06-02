const Groq = require('groq-sdk');
const db   = require('../db/index');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

// Cache stores full analysis: { is_address, destination, is_saved_place, comment, _db }
const cache = new Map();

const NOT_ADDRESS = [
  'да','нет','ок','окей','ok','ладно','хорошо','конечно','поехали','подтверждаю',
  'на линию','на линии','с линии','офлайн','онлайн','старт','стоп',
  'принял','принять','прибыл','свободен','ложный','пропустить','статистика',
  'привет','здравствуйте','салем','сәлем','пока','спасибо','рахмет',
  'такси','машину','машина','отмена','отменить','cancel','нет','жоқ',
  'помощь','help','команды','изменить','сменить данные',
];

const TOOLS = [{
  type: 'function',
  function: {
    name: 'analyze_message',
    description: 'Анализирует сообщение клиента такси — определяет адрес назначения и нормализует его',
    parameters: {
      type: 'object',
      properties: {
        is_address: {
          type: 'boolean',
          description: 'Является ли сообщение адресом или местом назначения для поездки на такси',
        },
        destination: {
          type: 'string',
          description: 'Нормализованный адрес назначения (улица + номер дома, или название места). Только если is_address=true.',
        },
        is_saved_place: {
          type: 'string',
          enum: ['home', 'work'],
          description: '"домой"/"дом" → home, "на работу"/"работа" → work',
        },
        comment: {
          type: 'string',
          description: 'Дополнительный комментарий к поездке (к другу, к врачу и т.д.)',
        },
      },
      required: ['is_address'],
    },
  },
}];

const findInAddresses = async (text) => {
  try {
    const lo = text.toLowerCase().trim();
    const words = lo.split(/\s+/).filter(w => w.length > 2);
    if (!words.length) return { found: false };
    const r = await db.query(`
      SELECT name, category, address, keywords
      FROM addresses
      WHERE is_active = TRUE
        AND (
          $1 ILIKE '%' || name || '%'
          OR name ILIKE '%' || $1 || '%'
          OR keywords && $2::text[]
        )
      ORDER BY
        CASE WHEN lower(name) = $1 THEN 0
             WHEN lower(name) LIKE '%' || $1 || '%' THEN 1
             ELSE 2
        END
      LIMIT 1
    `, [lo, words]);
    if (r.rows.length) {
      return { found: true, name: r.rows[0].name, address: r.rows[0].address, category: r.rows[0].category };
    }
    return { found: false };
  } catch (err) {
    console.error('[addressDetector:findInAddresses]', err.message);
    return { found: false };
  }
};

// Core function — DB first, then Groq function calling. Result cached 1h.
const getAnalysis = async (text) => {
  const lo = (text || '').toLowerCase().trim();
  if (!lo || lo.length < 2) return { is_address: false };
  if (/^\d+$/.test(lo)) return { is_address: false };
  if (lo.includes('?')) return { is_address: false };
  if (NOT_ADDRESS.includes(lo)) return { is_address: false };

  if (cache.has(lo)) return cache.get(lo);

  // Fast path: DB lookup
  const dbResult = await findInAddresses(lo);
  if (dbResult.found) {
    const result = { is_address: true, destination: dbResult.name, _db: dbResult };
    cache.set(lo, result);
    setTimeout(() => cache.delete(lo), 3600000);
    return result;
  }

  // Groq function calling
  try {
    const completion = await getGroq().chat.completions.create({
      messages: [{
        role: 'system',
        content: `Ты — диспетчер такси в посёлке Осакаровка, Казахстан.
Проанализируй сообщение клиента. Вызови инструмент analyze_message.

is_address=true — если это место или адрес куда нужно ехать:
• улица с номером дома ("Ленина 5", "дом 12")
• название места ("больница", "школа", "рынок")
• "домой", "на работу", "к маме", "к другу на Ленина"

is_address=false — если это:
• просьба вызвать такси без адреса ("машину", "такси", "пришлите")
• приветствие ("привет", "здравствуйте", "салем")
• вопрос ("работаете?", "есть такси?", "сколько стоит?")
• ответ/реакция ("да", "нет", "ок", "спасибо", "отмена")

destination — нормализованный адрес без лишних слов:
• "к другу на Ленина 15" → "ул. Ленина 15"
• "в больницу" → "больница"
• "домой" → не заполнять (используй is_saved_place=home)`,
      }, { role: 'user', content: text }],
      model: 'llama-3.3-70b-versatile',
      tools: TOOLS,
      tool_choice: 'required',
      max_tokens: 100,
      temperature: 0,
    });

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    const analysis = toolCall ? JSON.parse(toolCall.function.arguments) : { is_address: false };
    cache.set(lo, analysis);
    setTimeout(() => cache.delete(lo), 3600000);
    return analysis;
  } catch (err) {
    console.error('[addressDetector:groq]', err.message);
    const fallback = { is_address: lo.length >= 3 };
    cache.set(lo, fallback);
    setTimeout(() => cache.delete(lo), 300000);
    return fallback;
  }
};

const isAddress = async (text) => {
  const analysis = await getAnalysis(text);
  return analysis.is_address === true;
};

// Returns normalized address. Uses cached analysis — no extra Groq call after isAddress().
const resolveAddress = async (text) => {
  const lo = (text || '').toLowerCase().trim();
  const analysis = await getAnalysis(text);

  // DB match (fastest, most accurate)
  if (analysis._db?.found) return analysis._db;

  // Groq gave us a normalized destination
  if (analysis.destination) {
    return { found: true, name: analysis.destination, address: analysis.destination, groqNormalized: true };
  }

  return { found: false, name: text, address: text };
};

module.exports = { isAddress, resolveAddress, findInAddresses, getAnalysis };
