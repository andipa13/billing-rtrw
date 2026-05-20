const { getSetting } = require('../config/settingsManager.js');
const { logger } = require('../config/logger.js');

function getBaseConfig() {
  return {
    url: getSetting('wa_evolution_url', 'http://10.10.10.100:8080'),
    apiKey: getSetting('wa_evolution_api_key', ''),
    instance: getSetting('wa_evolution_instance', 'zya'),
    enabled: getSetting('wa_evolution_enabled', true),
  };
}

async function sendText(number, text) {
  const cfg = getBaseConfig();
  if (!cfg.enabled || !cfg.apiKey) return { ok: false, reason: 'not_enabled' };
  const cleanNumber = String(number).replace(/[^0-9]/g, '');
  const endpoint = `${cfg.url}/message/sendText/${cfg.instance}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({ number: cleanNumber, text }),
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error(`Evolution sendText error: ${JSON.stringify(data)}`);
      return { ok: false, error: data };
    }
    logger.info(`Evolution sendText OK to ${cleanNumber}`);
    return { ok: true, data };
  } catch (err) {
    logger.error(`Evolution sendText exception: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function sendMedia(number, mediaBase64, mimeType, filename, caption = '') {
  const cfg = getBaseConfig();
  if (!cfg.enabled || !cfg.apiKey) return { ok: false, reason: 'not_enabled' };
  const cleanNumber = String(number).replace(/[^0-9]/g, '');
  // infer mediatype
  let mediatype = 'document';
  if (mimeType.startsWith('image/')) mediatype = 'image';
  else if (mimeType.startsWith('video/')) mediatype = 'video';
  else if (mimeType.startsWith('audio/')) mediatype = 'audio';

  const endpoint = `${cfg.url}/message/sendMedia/${cfg.instance}`;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: cfg.apiKey,
      },
      body: JSON.stringify({
        number: cleanNumber,
        mediatype,
        media: mediaBase64,
        fileName: filename || 'file',
        caption,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      logger.error(`Evolution sendMedia error: ${JSON.stringify(data)}`);
      return { ok: false, error: data };
    }
    logger.info(`Evolution sendMedia OK to ${cleanNumber}`);
    return { ok: true, data };
  } catch (err) {
    logger.error(`Evolution sendMedia exception: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  sendText,
  sendMedia,
};
