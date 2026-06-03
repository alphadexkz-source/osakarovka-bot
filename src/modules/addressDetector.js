const Groq = require('groq-sdk');
const db   = require('../db/index');
const { SYSTEM_CONTEXT } = require('./prompts');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

// Cache stores full analysis: { is_address, destination, comment, _db }
const cache = new Map();

const NOT_ADDRESS = [
  // подтверждения / ответы
  'да','нет','ок','окей','ok','ладно','хорошо','конечно','поехали','подтверждаю',
  'иа','ия','ага','угу','нее','не','ну','нуну','опа','ого','вау','wow',
  'понял','поняла','понятно','ясно','класс','отлично','супер','норм','нормально',
  'окей!','окей.','ок!','ок.','хорошо!','ладно!','понятно!','ясно!','угу.',
  // приветствия
  'привет','здравствуйте','салем','сәлем','пока','спасибо','рахмет','сау',
  'доброе утро','добрый день','добрый вечер','здрасте','хай','hi','hello',
  'қайырлы таң','қайырлы күн','қайырлы кеш',
  // команды водителя
  'на линию','на линии','с линии','офлайн','онлайн','старт','стоп',
  'принял','принять','прибыл','свободен','ложный','пропустить','статистика',
  'выхожу','ухожу','начинаю','заканчиваю','перерыв',
  // запросы такси без адреса
  'такси','машину','машина','отмена','отменить','cancel','жоқ',
  'помощь','help','команды','изменить','сменить данные',
  // казахские ответы
  'иә','рақмет','жарайды','түсінікті','жақсы','болды','аламын',
  'қабылдадым','жеттім','келдім','бостымын','аяқтадым',
  // эмоции / мусор
  'хм','хм.','лол','ха','ок.','ок!','да.','да!','нет.','нет!',
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
          description: 'BOOLEAN (не строка). true — если это место/адрес куда ехать. false — всё остальное.',
        },
        destination: {
          type: 'string',
          description: 'Нормализованный адрес назначения (улица + номер дома, или название места). Только если is_address=true.',
        },
        comment: {
          type: 'string',
          description: 'Дополнительный комментарий к поездке (к другу, к врачу и т.д.)',
        },
      },
      required: ['is_address'],
      additionalProperties: false,
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

// Обёртка с таймаутом для Groq вызовов
const withTimeout = (promise, ms, fallback) => {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms)
  )
  return Promise.race([promise, timeout]).catch(() => fallback)
}

// Более умный fallback без Groq
const looksLikeAddress = (text) => {
  const lo = text.toLowerCase().trim()
  // Улица + номер: "Ленина 5", "Школьная 12а"
  if (/[а-яё]+\s+\d+/i.test(lo)) return true
  // Только номер дома: "дом 5", "д. 5"
  if (/дом\s*\d+|д\.?\s*\d+/i.test(lo)) return true
  // Известные ориентиры
  const LANDMARKS = ['больниц','школ','рынок','магазин','аптек','акимат','церков',
                     'мечет','стадион','вокзал','остановк','почт','банк','кафе']
  if (LANDMARKS.some(w => lo.includes(w))) return true
  return false
}

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

  // Groq function calling (с таймаутом 5 сек)
  try {
    const completion = await withTimeout(
      getGroq().chat.completions.create({
        messages: [{
          role: 'system',
          content: SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента. Вызови инструмент analyze_message.

is_address=true — если это место или адрес куда нужно ехать:
• улица с номером дома ("Школьная 5", "Достык 12")
• название места ("больница", "школа", "рынок")
• "домой", "на работу", "к маме", "к другу на Школьную"

is_address=false — если это:
• просьба вызвать такси без адреса ("машину", "такси", "пришлите")
• приветствие ("привет", "здравствуйте", "салем")
• вопрос ("работаете?", "есть такси?", "сколько стоит?")
• ответ/реакция ("да", "нет", "ок", "спасибо", "отмена")

destination — нормализованный адрес (строка), без лишних слов:
• "к другу на Бокейханова 15" → "ул. Алихана Бокейханова, 15"
• "в больницу" → "больница"
• "домой" / "на работу" → оставь destination пустой строкой ""

is_address — строго boolean true или false, НИКОГДА не строка "true"/"false".

Переименования улиц (всегда используй НОВОЕ название):
• Литвинская / Литвинова → улица Алихана Бокейханова
• Новая улица → Достык`,
        }, { role: 'user', content: text }],
        model: 'llama-3.3-70b-versatile',
        tools: TOOLS,
        tool_choice: 'required',
        max_tokens: 100,
        temperature: 0,
      }),
      5000,
      null
    );

    if (!completion) throw new Error('Groq timeout');

    const toolCall = completion.choices[0]?.message?.tool_calls?.[0];
    const raw = toolCall ? JSON.parse(toolCall.function.arguments) : { is_address: false };
    // Нормализуем is_address на случай если Groq вернул строку вместо boolean
    const analysis = {
      ...raw,
      is_address: raw.is_address === true || raw.is_address === 'true',
    };
    cache.set(lo, analysis);
    setTimeout(() => cache.delete(lo), 3600000);
    return analysis;
  } catch (err) {
    console.error('[addressDetector:groq]', err.message);
    // Умный fallback через looksLikeAddress; короткий TTL (5 мин) чтобы переспросить Groq позже
    const fallback = { is_address: looksLikeAddress(lo) };
    cache.set(lo, fallback);
    setTimeout(() => cache.delete(lo), 300_000);
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
