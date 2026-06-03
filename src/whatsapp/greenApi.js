const axios  = require('axios');
const config = require('../config');

const BASE = `https://api.green-api.com/waInstance${config.INSTANCE_ID}`;

const fmt = (phone) => {
  const clean = String(phone).replace(/\D/g, '');
  return clean.endsWith('@c.us') ? clean : `${clean}@c.us`;
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RETRY_DELAYS = [1000, 2000]; // задержка после 1-й и 2-й неудачи

const postWithRetry = async (method, data) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(`${BASE}/${method}/${config.API_TOKEN}`, data, {
        timeout: 10_000,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || status >= 500 ||
        err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';

      if (attempt < 3 && isRetryable) {
        await sleep(RETRY_DELAYS[attempt - 1]);
        continue;
      }
      // После всех попыток или при не-ретраябельной ошибке — логируем и возвращаем null
      console.error(`[GreenAPI] ${method} failed (attempt ${attempt}):`, err.response?.data || err.message);
      return null;
    }
  }
  return null;
};

// Отправить текст
const sendText = async (phone, message) => {
  return postWithRetry('sendMessage', { chatId: fmt(phone), message });
};

// Отправить сообщение с кнопками (до 3 кнопок)
const sendButtons = async (phone, message, buttons, footer = '') => {
  const result = await postWithRetry('sendButtons', {
    chatId: fmt(phone),
    message,
    footer,
    buttons: buttons.map((b, i) => ({
      buttonId:   b.id   || `btn_${i}`,
      buttonText: b.text,
    })),
  });

  // Если кнопки не поддерживаются — fallback на текст
  if (!result) {
    const lines = buttons.map((b, i) => `[${i + 1}] ${b.text}`).join('\n');
    return sendText(phone, `${message}\n\n${lines}`);
  }
  return result;
};

// Отправить картинку по URL с подписью
const sendImage = async (phone, urlFile, caption = '') => {
  return postWithRetry('sendFileByUrl', {
    chatId: fmt(phone),
    urlFile,
    fileName: 'photo.jpg',
    caption,
  });
};

// Получить состояние инстанса
const getState = async () => {
  try {
    const res = await axios.get(`${BASE}/getStateInstance/${config.API_TOKEN}`);
    return res.data;
  } catch (e) {
    return null;
  }
};

// Установить URL вебхука
const setWebhook = async (webhookUrl) => {
  return postWithRetry('setSettings', {
    webhookUrl,
    incomingWebhook:         'yes',
    outgoingMessageWebhook:  'no',
    outgoingAPIMessageWebhook: 'no',
  });
};

module.exports = { sendText, sendButtons, sendImage, getState, setWebhook, fmt };
