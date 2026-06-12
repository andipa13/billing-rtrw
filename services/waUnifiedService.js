/**
 * Unified WhatsApp Service
 * Mengirim WA via Evolution API dengan auto-fallback ke Fonnte.
 * Interface identik dengan evolutionService.js — semua caller tidak perlu diubah.
 */
const axios = require('axios');
const { getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');

// ── helpers ────────────────────────────────────────────────────
function cleanPhone(phone) {
  const cleaned = String(phone).replace(/[^0-9]/g, '');
  return cleaned.startsWith('62') ? cleaned : '62' + cleaned.replace(/^0/, '');
}

// ── FONNTE ─────────────────────────────────────────────────────
async function sendViaFonnte(phone, message) {
  const settings = getSettings();
  const token = settings.wa_fonnte_token;
  if (!token) return { success: false, error: 'Fonnte token not configured' };

  try {
    const res = await axios.post('https://api.fonnte.com/send', {
      target: cleanPhone(phone),
      message: message,
      countryCode: '62'
    }, {
      headers: { Authorization: token },
      timeout: 15000
    });
    logger.info(`[Fonnte] WA sent to ${phone}: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.reason || err.message;
    logger.error(`[Fonnte] Failed to send WA to ${phone}: ${msg}`);
    return { success: false, error: msg };
  }
}

async function sendMediaViaFonnte(phone, filePath, caption = '') {
  const settings = getSettings();
  const token = settings.wa_fonnte_token;
  if (!token) return { success: false, error: 'Fonnte token not configured' };

  try {
    const fs = require('fs');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('target', cleanPhone(phone));
    form.append('caption', caption);
    form.append('file', fs.createReadStream(filePath));

    const res = await axios.post('https://api.fonnte.com/send', form, {
      headers: { ...form.getHeaders(), Authorization: token },
      timeout: 30000
    });
    logger.info(`[Fonnte] WA media sent to ${phone}: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.reason || err.message;
    logger.error(`[Fonnte] Failed to send WA media to ${phone}: ${msg}`);
    return { success: false, error: msg };
  }
}

// ── EVOLUTION ──────────────────────────────────────────────────
async function sendViaEvolution(phone, message) {
  const settings = getSettings();
  if (!settings.wa_evolution_enabled) return { success: false, reason: 'disabled' };

  const url = `${settings.wa_evolution_url}/message/sendText/${settings.wa_evolution_instance}`;
  const headers = {
    apikey: settings.wa_evolution_api_key,
    'Content-Type': 'application/json'
  };
  const number = cleanPhone(phone) + '@s.whatsapp.net';

  try {
    const res = await axios.post(url, {
      number, text: message, options: { linkPreview: false }
    }, { headers, timeout: 15000 });
    logger.info(`[Evo] WA sent to ${phone}: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.warn(`[Evo] Failed to send WA to ${phone}: ${msg}`);
    return { success: false, error: msg };
  }
}

async function sendMediaViaEvolution(phone, filePath, caption = '') {
  const settings = getSettings();
  if (!settings.wa_evolution_enabled) return { success: false, reason: 'disabled' };

  const fs = require('fs');
  const path = require('path');
  const fileBuffer = fs.readFileSync(filePath);
  const base64Content = fileBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase();
  const mediatypeMap = { '.pdf': 'document', '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.mp4': 'video', '.mp3': 'audio' };
  const mediatype = mediatypeMap[ext] || 'document';

  const url = `${settings.wa_evolution_url}/message/sendMedia/${settings.wa_evolution_instance}`;
  const headers = { apikey: settings.wa_evolution_api_key, 'Content-Type': 'application/json' };
  const number = cleanPhone(phone) + '@s.whatsapp.net';

  const payload = { number, caption, mediatype, media: base64Content, fileName: filePath.split('/').pop() };

  try {
    const res = await axios.post(url, payload, { headers, timeout: 20000 });
    logger.info(`[Evo] WA media sent to ${phone}: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.warn(`[Evo] Failed to send WA media to ${phone}: ${msg}`);
    return { success: false, error: msg };
  }
}

// ── UNIFIED (try Evo → fallback Fonnte) ────────────────────────
async function sendWhatsApp(phone, message) {
  // Coba Evolution dulu
  const evoResult = await sendViaEvolution(phone, message);
  if (evoResult.success) return evoResult;

  // Fallback ke Fonnte
  logger.info(`[WA] Evolution gagal → fallback ke Fonnte untuk ${phone}`);
  const fonnteResult = await sendViaFonnte(phone, message);
  if (fonnteResult.success) return fonnteResult;

  return { success: false, error: `Evo: ${evoResult.error}; Fonnte: ${fonnteResult.error}` };
}

async function sendWhatsAppMedia(phone, filePath, caption = '') {
  const evoResult = await sendMediaViaEvolution(phone, filePath, caption);
  if (evoResult.success) return evoResult;

  logger.info(`[WA] Evolution media gagal → fallback ke Fonnte untuk ${phone}`);
  const fonnteResult = await sendMediaViaFonnte(phone, filePath, caption);
  if (fonnteResult.success) return fonnteResult;

  return { success: false, error: `Evo: ${evoResult.error}; Fonnte: ${fonnteResult.error}` };
}

async function sendWhatsAppText(phone, text) {
  return sendWhatsApp(phone, text);
}

// ── Pengecekan status ──────────────────────────────────────────
async function isEvolutionOnline() {
  const settings = getSettings();
  if (!settings.wa_evolution_enabled) return false;
  try {
    const res = await axios.get(
      `${settings.wa_evolution_url}/instance/connectionState/${settings.wa_evolution_instance}`,
      { headers: { apikey: settings.wa_evolution_api_key }, timeout: 5000 }
    );
    return res.data?.instance?.state === 'open';
  } catch { return false; }
}

async function isFonnteReady() {
  const token = getSettings().wa_fonnte_token;
  if (!token) return false;
  try {
    const res = await axios.post('https://api.fonnte.com/device', {}, {
      headers: { Authorization: token }, timeout: 5000
    });
    return res.data?.status === true;
  } catch { return false; }
}

module.exports = { sendWhatsApp, sendWhatsAppMedia, sendWhatsAppText, isEvolutionOnline, isFonnteReady };
