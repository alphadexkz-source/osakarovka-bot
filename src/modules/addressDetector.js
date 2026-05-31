const Groq = require('groq-sdk');
const db   = require('../db/index');

let groq = null;
const getGroq = () => {
 if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
 return groq;
};

const cache = new Map();

const NOT_ADDRESS = [
 'да','нет','ок','окей','ok','ладно','хорошо','конечно','поехали','подтверждаю',
 'на линию','на линии','с линии','офлайн','онлайн','старт','стоп',
 'принял','принять','прибыл','свободен','ложный','пропустить','статистика',
 'привет','здравствуйте','салем','сәлем','пока','спасибо','рахмет',
 'такси','машину','машина','отмена','отменить','cancel','нет','жоқ',
 'помощь','help','команды','изменить','сменить данные',
];

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

const isAddress = async (text) => {
 const lo = (text || '').toLowerCase().trim();
 if (!lo || lo.length < 2) return false;
 if (/^\d+$/.test(lo)) return false;
 if (lo.includes('?')) return false;
 if (NOT_ADDRESS.includes(lo)) return false;
 if (cache.has(lo)) return cache.get(lo);
 const found = await findInAddresses(lo);
 if (found.found) {
   cache.set(lo, true);
   setTimeout(() => cache.delete(lo), 3600000);
   return true;
 }
 try {
   const completion = await getGroq().chat.completions.create({
     messages: [
       {
         role: 'system',
         content: `Ты — умный диспетчер такси в посёлке Осакаровка, Казахстан.
Определи является ли сообщение АДРЕСОМ НАЗНАЧЕНИЯ для поездки на такси.
Отвечай ТОЛЬКО одним словом: ДА или НЕТ

ДА — если это улица, место, объект, село, город куда нужно ехать
ДА — если адрес с номером дома ("Ленина 5", "дом 12")
ДА — если клиент говорит куда ехать ("домой", "на работу", "к другу на Ленина")

НЕТ — если просьба вызвать такси БЕЗ адреса ("машину", "такси", "пришлите")
НЕТ — если приветствие ("привет", "здравствуйте", "салем")
НЕТ — если вопрос ("работаете?", "есть такси?", "сколько стоит?")
НЕТ — если ответ/реакция ("да", "нет", "ок", "хорошо", "спасибо", "отмена")`
       },
       { role: 'user', content: text }
     ],
     model: 'llama-3.3-70b-versatile',
     max_tokens: 5,
     temperature: 0,
   });
   const answer = completion.choices[0]?.message?.content?.trim().toUpperCase();
   const result = answer === 'ДА' || answer === 'DA' || answer === 'YES';
   cache.set(lo, result);
   setTimeout(() => cache.delete(lo), 3600000);
   return result;
 } catch (err) {
   console.error('[addressDetector:groq]', err.message);
   return lo.length >= 3;
 }
};

const resolveAddress = async (text) => {
 const lo = (text || '').toLowerCase().trim();
 const found = await findInAddresses(lo);
 if (found.found) return found;
 return { found: false, name: text, address: text };
};

module.exports = { isAddress, resolveAddress, findInAddresses };
