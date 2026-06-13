const Groq  = require('groq-sdk');
const axios = require('axios');
const db    = require('../db/index');
const { SYSTEM_CONTEXT } = require('./prompts');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

// Cache stores full analysis: { is_address, destination, comment, _db }
const cache = new Map();
const cacheTimers = new Map();
const MAX_CACHE_SIZE = 1000;
const cacheSet = (key, value, ttlMs) => {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    clearTimeout(cacheTimers.get(oldest));
    cacheTimers.delete(oldest);
    cache.delete(oldest);
  }
  clearTimeout(cacheTimers.get(key));
  const tid = setTimeout(() => { cache.delete(key); cacheTimers.delete(key); }, ttlMs);
  cache.set(key, value);
  cacheTimers.set(key, tid);
};

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
          description: 'Boolean true если это адрес/место куда ехать, false если нет. Возвращай именно boolean, не строку.',
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
  // Улица + номер: "Ленина 5", "Целинная 10", "Школьная 12а"
  if (/[а-яё]+\s+\d+/i.test(lo)) return true
  // Только номер дома: "дом 5", "д. 5"
  if (/дом\s*\d+|д\.?\s*\d+/i.test(lo)) return true
  // Известные ориентиры посёлка (русские + казахские названия)
  const LANDMARKS = [
    'больниц','поликлиник','аурухан',        // больница
    'школ','мектеп',                          // школы
    'рынок','базар','нарық',                  // рынки
    'магазин','дүкен',                        // магазины
    'аптек','дәріхан',                        // аптеки
    'акимат','әкімшілік',                     // акимат
    'мечет','мешіт',                          // мечеть
    'стадион','спортплощадк',                 // стадион
    'вокзал','станци','перрон',               // жд/авто вокзал
    'почт','пошт',                            // почта
    'банк','банкомат',                        // банки
    'кафе','ресторан',                        // кафе
    'цон','халыққа қызмет',                   // ЦОН
    'айболит',                                // магазин Айболит
    'нефтебаз','заправк','азс',              // нефтебаза, заправки
    'садик','детсад','балабақша',             // детсады
    'парк','саябақ',                          // парки
    'кладбищ','зират',                        // кладбище
    'ровд','полиц',                           // полиция
    'больш','центр',                          // "большой", "центр"
  ]
  if (LANDMARKS.some(w => lo.includes(w))) return true
  return false
}

// Cerebras fallback (llama-3.3-70b, бесплатно, OpenAI-compatible)
const callCerebras = async (text, systemPrompt) => {
  if (!process.env.CEREBRAS_API_KEY) return null;
  const resp = await axios.post('https://api.cerebras.ai/v1/chat/completions', {
    model: 'llama-3.3-70b',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 100,
    temperature: 0,
  }, {
    headers: { Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 5000,
  });
  return resp.data;
};

// Google Gemini fallback (gemini-2.5-flash, бесплатно, 15 RPM, OpenAI-compatible)
const callGemini = async (text, systemPrompt) => {
  if (!process.env.GEMINI_API_KEY) return null;
  const resp = await axios.post('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 100,
    temperature: 0,
  }, {
    headers: { Authorization: `Bearer ${process.env.GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 8000,
  });
  return resp.data;
};

// LLM7.io fallback (deepseek-v4-flash, бесплатно, без ключа, JSON mode)
const callLLM7 = async (text, systemPrompt) => {
  const resp = await axios.post('https://api.llm7.io/v1/chat/completions', {
    model: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: systemPrompt + '\n\nОтвечай ТОЛЬКО JSON объектом без markdown: {"is_address": true или false, "destination": "адрес или пустая строка"}' },
      { role: 'user', content: text },
    ],
    max_tokens: 100,
    temperature: 0,
  }, {
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer no-key' },
    timeout: 8000,
  });
  return resp.data;
};

// OpenRouter fallback (meta-llama/llama-3.3-70b-instruct:free, бесплатно, OpenAI-compatible)
const callOpenRouter = async (text, systemPrompt) => {
  if (!process.env.OPENROUTER_API_KEY) return null;
  const resp = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: 'meta-llama/llama-3.3-70b-instruct:free',
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
    tools: TOOLS,
    tool_choice: 'required',
    max_tokens: 100,
    temperature: 0,
  }, {
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/osakarovka-bot',
    },
    timeout: 8000,
  });
  return resp.data;
};

// Core function — DB first, then Groq → Cerebras → regex fallback. Result cached 1h.
const getAnalysis = async (text) => {
  const lo = (text || '').toLowerCase().trim();
  if (!lo || lo.length < 2) return { is_address: false };
  if (/^\d+$/.test(lo)) return { is_address: false };
  if (lo.endsWith('?') && !/\d/.test(lo)) return { is_address: false };
  if (NOT_ADDRESS.includes(lo)) return { is_address: false };

  if (cache.has(lo)) return cache.get(lo);

  // Fast path: DB lookup
  const dbResult = await findInAddresses(lo);
  if (dbResult.found) {
    const result = { is_address: true, destination: dbResult.name, _db: dbResult };
    cacheSet(lo, result, 3600000);
    return result;
  }

  // Groq function calling (с таймаутом 5 сек)
  try {
    const completion = await withTimeout(
      getGroq().chat.completions.create({
        messages: [{
          role: 'system',
          content: SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента. Вызови инструмент analyze_message.

ЗАДАЧА: определи куда клиент хочет ехать.

is_address=TRUE — клиент хочет поехать куда-то:
• Прямой адрес: "Школьная 5", "Достык 12", "Целинная 10"
• С обёрткой: "можно такси на Целинную 10", "вызовите на рынок", "мне на больницу", "а можно до ЦОНа"
• Место/ориентир: "больница", "рынок", "вокзал", "цон", "айболит", "школа", "аптека"
• Через кого-то: "к маме на Школьную", "к другу на Достык 15", "к бабушке"
• Голосовые формы: "на целинную десять", "до рынка", "к стадиону"

is_address=FALSE — клиент НЕ хочет ехать никуда:
• Просьба без адреса: "такси", "машину пришлите" (без куда)
• Приветствие: "привет", "салем", "здравствуйте"
• Вопрос без адреса: "работаете?", "сколько стоит?", "есть такси?"
• Ответ/реакция: "да", "нет", "ок", "спасибо", "понял", "отмена"
• Бессмыслица: случайные символы, очевидно нереальные адреса ("луна", "марс")

destination — ТОЛЬКО адрес назначения, всё лишнее убери:
• "можно такси на Целинную 10" → "ул. Целинная, 10"
• "вызовите на рынок" → "рынок"
• "к другу на Бокейханова 15" → "ул. Алихана Бокейханова, 15"
• "в больницу" → "больница"
• "на айболит" → "Айболит (магазин)"
• "на цон" → "ЦОН"
• "домой" / "на работу" → оставь destination пустой строкой ""

Переименования улиц (всегда NEW название):
• Литвинская / Литвинова → ул. Алихана Бокейханова
• Первомайская → ул. Алаш
• Октябрьская → ул. Қарағанды
• Советская → ул. Жібек жолы

is_address — строго boolean true или false, НИКОГДА строку.`,
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
    cacheSet(lo, analysis, 3600000);
    return analysis;
  } catch (err) {
    console.error('[addressDetector:groq]', err.message);
    // Gemini fallback (gemini-2.5-flash, бесплатно, tool_calling поддерживается)
    try {
      const geminiResp = await withTimeout(
        callGemini(text, SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента. Вызови инструмент analyze_message.\nis_address — строго boolean true или false.`),
        8000, null
      );
      if (geminiResp) {
        const toolCall = geminiResp.choices?.[0]?.message?.tool_calls?.[0];
        const raw = toolCall ? JSON.parse(toolCall.function.arguments) : { is_address: false };
        const analysis = { ...raw, is_address: raw.is_address === true || raw.is_address === 'true' };
        cacheSet(lo, analysis, 3600000);
        return analysis;
      }
    } catch (e2) {
      console.error('[addressDetector:gemini]', e2.message);
    }
    // LLM7.io fallback (deepseek-v4-flash, без ключа, JSON mode)
    try {
      const llm7Resp = await withTimeout(
        callLLM7(text, SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента.\nis_address — строго boolean true или false.`),
        8000, null
      );
      if (llm7Resp) {
        const content = llm7Resp.choices?.[0]?.message?.content || '';
        const jsonMatch = content.match(/\{[^}]+\}/);
        const raw = jsonMatch ? JSON.parse(jsonMatch[0]) : { is_address: false };
        const analysis = { ...raw, is_address: raw.is_address === true || raw.is_address === 'true' };
        cacheSet(lo, analysis, 3600000);
        return analysis;
      }
    } catch (e3) {
      console.error('[addressDetector:llm7io]', e3.message);
    }
    // Cerebras fallback (llama-3.3-70b, если ключ задан)
    try {
      const cerebrasResp = await withTimeout(
        callCerebras(text, SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента. Вызови инструмент analyze_message.\nis_address — строго boolean true или false.`),
        5000, null
      );
      if (cerebrasResp) {
        const toolCall = cerebrasResp.choices?.[0]?.message?.tool_calls?.[0];
        const raw = toolCall ? JSON.parse(toolCall.function.arguments) : { is_address: false };
        const analysis = { ...raw, is_address: raw.is_address === true || raw.is_address === 'true' };
        cacheSet(lo, analysis, 3600000);
        return analysis;
      }
    } catch (e4) {
      console.error('[addressDetector:cerebras]', e4.message);
    }
    // OpenRouter fallback (llama-3.3-70b:free, OpenAI-compatible)
    try {
      const orResp = await withTimeout(
        callOpenRouter(text, SYSTEM_CONTEXT + `\n\nПроанализируй сообщение клиента. Вызови инструмент analyze_message.\nis_address — строго boolean true или false.`),
        8000, null
      );
      if (orResp) {
        const toolCall = orResp.choices?.[0]?.message?.tool_calls?.[0];
        const raw = toolCall ? JSON.parse(toolCall.function.arguments) : { is_address: false };
        const analysis = { ...raw, is_address: raw.is_address === true || raw.is_address === 'true' };
        cacheSet(lo, analysis, 3600000);
        return analysis;
      }
    } catch (e5) {
      console.error('[addressDetector:openrouter]', e5.message);
    }
    // Финальный fallback — regex; короткий TTL чтобы переспросить LLM позже
    const fallback = { is_address: looksLikeAddress(lo) };
    cacheSet(lo, fallback, 300_000);
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
