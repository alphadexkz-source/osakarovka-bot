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
    if (!audioUrl) {
      console.error('[voiceRecognizer] no audioUrl');
      return null;
    }

    console.log('[voiceRecognizer] downloading:', audioUrl.slice(0, 80));

    const response = await axios.get(audioUrl, {
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

    const ext = audioUrl.includes('.mp4') ? 'mp4'
               : audioUrl.includes('.mp3') ? 'mp3'
               : 'ogg';
    tmpFile = path.join(os.tmpdir(), `voice_${Date.now()}.${ext}`);
    fs.writeFileSync(tmpFile, Buffer.from(response.data));

    const raw = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tmpFile),
      model: 'whisper-large-v3',
      language: 'ru',
      response_format: 'text',
    });

    const result = typeof raw === 'string' ? raw.trim() : (raw?.text || '').trim();
    const ts = new Date().toLocaleTimeString('ru-RU', { timeZone: 'Asia/Almaty' });
    console.log(`[VOICE ${ts}] ${result?.slice(0, 100) || '(пусто)'}`);
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
