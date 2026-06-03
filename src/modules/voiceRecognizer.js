'use strict';

const Groq = require('groq-sdk');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('../logger');

let groq = null;
const getGroq = () => {
  if (!groq) groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return groq;
};

const recognizeVoice = async (audioUrl, phone = 'unknown') => {
  let tmpFile = null;
  const started = Date.now();

  try {
    if (!audioUrl) {
      log.voice(phone, 'error', { reason: 'no_audioUrl' });
      return null;
    }

    log.voice(phone, 'downloading', { url: audioUrl.slice(0, 80) });

    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });

    const fileSize = Buffer.byteLength(response.data);

    if (fileSize < 100) {
      log.voice(phone, 'error', { reason: 'file_too_small', size: fileSize });
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
    const ms = Date.now() - started;

    log.voice(phone, 'ok', {
      size: fileSize,
      ms,
      text: result?.slice(0, 80) || '(пусто)',
    });

    return result || null;

  } catch (err) {
    log.voice(phone, 'error', {
      reason: err.message?.slice(0, 100),
      ms: Date.now() - started,
    });
    return null;
  } finally {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }
};

module.exports = { recognizeVoice };
