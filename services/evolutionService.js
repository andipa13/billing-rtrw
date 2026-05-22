const axios = require('axios');
const { getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');

async function sendWhatsApp(phone, message) {
  const settings = getSettings();
  if (!settings.wa_evolution_enabled) {
    logger.info('Evolution API disabled, skipping WA send');
    return { success: false, reason: 'disabled' };
  }

  const url = `${settings.wa_evolution_url}/message/sendText/${settings.wa_evolution_instance}`;
  const headers = {
    'apikey': settings.wa_evolution_api_key,
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios.post(url, {
      number: phone,
      text: message
    }, { headers });

    logger.info(`WA sent to ${phone}: ${response.status}`);
    return { success: true, data: response.data };
  } catch (error) {
    logger.error(`Failed to send WA to ${phone}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

async function sendWhatsAppMedia(phone, filePath, caption = '') {
  const settings = getSettings();
  if (!settings.wa_evolution_enabled) {
    logger.info('Evolution API disabled, skipping WA media send');
    return { success: false, reason: 'disabled' };
  }

  const fs = require('fs');
  const path = require('path');
  const fileBuffer = fs.readFileSync(filePath);
  const base64Content = fileBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase();

  const mediatypeMap = {
    '.pdf': 'document',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.png': 'image',
    '.mp4': 'video',
    '.mp3': 'audio'
  };
  const mediatype = mediatypeMap[ext] || 'document';

  const url = `${settings.wa_evolution_url}/message/sendMedia/${settings.wa_evolution_instance}`;
  const headers = {
    'apikey': settings.wa_evolution_api_key,
    'Content-Type': 'application/json'
  };

  const payload = {
    number: phone,
    caption: caption,
    mediatype: mediatype,
    media: base64Content,
    fileName: filePath.split('/').pop()
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await axios.post(url, payload, { headers });
      logger.info(`WA media sent to ${phone}: ${response.status} (attempt ${attempt})`);
      return { success: true, data: response.data };
    } catch (error) {
      let errorMsg = `Failed to send WA media to ${phone}: ${error.message}`;
      if (error.response) {
        errorMsg += '\nStatus: ' + error.response.status + ', data: ' + JSON.stringify(error.response.data);
      }
      logger.error(`${errorMsg} (attempt ${attempt}/3)`);
      if (attempt === 3) {
        return { success: false, error: errorMsg };
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

module.exports = { sendWhatsApp, sendWhatsAppMedia };
