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

const recognizeVoice = async (audioUrl, phone, messageId) => {
  let tmpFile = null;
  try {
    if (!audioUrl) {
      console.error('[voiceRecognizer] no audioUrl');
      return null;
    }

    console.log('[voiceRecognizer] downloading:', audioUrl.slice(0, 80));

    // Скачиваем файл
    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const fileSize = Buffer.byteLength(response.data);
    console.log('[voiceRecognizer] file size:', fileSize, 'bytes');

    if (fileSize < 100) {
      console.error('[voiceRecognizer] file too small:', fileSize);
      return null;
    }

    // Сохраняем во временный файл
    const ext = audioUrl.includes('.mp4') ? 'mp4'
               : audioUrl.includes('.mp3') ? 'mp3'
               : 'ogg';
    tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(response.data));

    // Отправляем в Groq Whisper
    const raw = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-large-v3',
      language: 'ru',
      response_format: 'text',
    });

    // Groq SDK может вернуть string или { text: "..." }
    const result = typeof raw === 'string' ? raw.trim() : (raw?.text || '').trim();
    console.log('[voiceRecognizer] result:', result?.slice(0, 80) || '(empty)');
    return result || null;

  } catch (err) {
    console.error('[voiceRecognizer] error:', err.message);
    return null;
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
};

module.exports = { recognizeVoice };
