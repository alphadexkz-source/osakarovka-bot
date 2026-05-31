const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

const recognizeVoice = async (audioUrl) => {
  let tmpFile = null;
  try {
    // 1. Скачать аудио файл
    const response = await axios.get(audioUrl, { responseType: 'arraybuffer', timeout: 15000 });
    
    // 2. Сохранить во временный файл
    tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.ogg`);
    fs.writeFileSync(tmpFile, Buffer.from(response.data));

    // 3. Отправить в Groq Whisper
    const transcription = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-large-v3',
      language: 'ru', // русский + казахский
      response_format: 'text',
    });

    return transcription?.trim() || null;

  } catch (err) {
    console.error('[voiceRecognizer]', err.message);
    return null;
  } finally {
    // Удалить временный файл
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
};

module.exports = { recognizeVoice };
