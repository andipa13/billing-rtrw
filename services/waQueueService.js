const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { getSettings } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const axios = require('axios');

const DB_PATH = path.join(__dirname, '..', 'database', 'wa_queue.db');
const db = new Database(DB_PATH);

// Create queue table
db.exec(`
  CREATE TABLE IF NOT EXISTS wa_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'media',
    payload TEXT NOT NULL,
    caption TEXT DEFAULT '',
    file_path TEXT DEFAULT '',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 10,
    last_error TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    next_retry_at TEXT DEFAULT (datetime('now','localtime')),
    completed_at TEXT
  )
`);

db.exec(`CREATE INDEX IF NOT EXISTS idx_waq_status ON wa_queue(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_waq_retry ON wa_queue(next_retry_at)`);

/**
 * Add a media message to the retry queue
 */
function enqueue(phone, filePath, caption, type = 'media') {
  const stmt = db.prepare(`
    INSERT INTO wa_queue (phone, type, payload, caption, file_path, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const fileBuffer = fs.readFileSync(filePath);
  const base64 = fileBuffer.toString('base64');
  const payload = JSON.stringify({
    fileName: path.basename(filePath),
    mediatype: 'document',
    mimetype: 'application/pdf',
    base64
  });
  stmt.run(phone, type, payload, caption, filePath);
  logger.info(`[WA-Queue] Enqueued media for ${phone} (file: ${path.basename(filePath)})`);
}

/**
 * Add a text message to the retry queue
 */
function enqueueText(phone, text) {
  const stmt = db.prepare(`
    INSERT INTO wa_queue (phone, type, payload, caption, file_path, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const payload = JSON.stringify({ text });
  stmt.run(phone, 'text', payload, '', '');
  logger.info(`[WA-Queue] Enqueued text for ${phone}`);
}

/**
 * Check if Evolution API instance is connected
 */
async function isInstanceConnected() {
  const settings = getSettings();
  const url = `${settings.wa_evolution_url}/instance/connectionState/${settings.wa_evolution_instance}`;
  try {
    const res = await axios.get(url, {
      headers: { apikey: settings.wa_evolution_api_key },
      timeout: 5000
    });
    const state = res.data?.instance?.state;
    if (state !== 'open') {
      logger.info(`[WA-Queue] Evolution state: ${state} (url: ${url})`);
    }
    return state === 'open';
  } catch (e) {
    logger.error(`[WA-Queue] isInstanceConnected error: ${e.message} (url: ${url})`);
    return false;
  }
}

/**
 * Send a single queued item (text or media)
 */
async function sendQueueItem(item) {
  const settings = getSettings();
  const headers = {
    'apikey': settings.wa_evolution_api_key,
    'Content-Type': 'application/json'
  };

  const data = JSON.parse(item.payload);
  
  // Normalize phone: add @s.whatsapp.net
  const cleaned = String(item.phone).replace(/[^0-9]/g, '');
  const prefixed = cleaned.startsWith('62') ? cleaned : '62' + cleaned.replace(/^0/, '');
  const number = prefixed + '@s.whatsapp.net';

  if (item.type === 'text') {
    const url = `${settings.wa_evolution_url}/message/sendText/${settings.wa_evolution_instance}`;
    const body = {
      number: number,
      text: data.text,
      options: { linkPreview: false }
    };
    const response = await axios.post(url, body, { headers, timeout: 15000 });
    return response;
  } else {
    // media
    const url = `${settings.wa_evolution_url}/message/sendMedia/${settings.wa_evolution_instance}`;
    const body = {
      number: number,
      caption: item.caption,
      mediatype: data.mediatype,
      media: data.base64,
      fileName: data.fileName
    };
    const response = await axios.post(url, body, { headers, timeout: 30000 });
    return response;
  }
}

/**
 * Process pending queue items. Called periodically.
 * Only processes when instance is connected.
 */
async function processQueue() {
  const connected = await isInstanceConnected();
  if (!connected) {
    logger.info('[WA-Queue] Instance disconnected, skipping queue processing');
    return { processed: 0, reason: 'disconnected' };
  }

  const pending = db.prepare(`
    SELECT * FROM wa_queue
    WHERE status = 'pending' AND next_retry_at <= datetime('now','localtime')
    ORDER BY created_at ASC LIMIT 5
  `).all();

  if (pending.length === 0) return { processed: 0 };

  let processed = 0;
  for (const item of pending) {
    try {
      await sendQueueItem(item);
      db.prepare(`
        UPDATE wa_queue SET status = 'sent', completed_at = datetime('now','localtime')
        WHERE id = ?
      `).run(item.id);
      logger.info(`[WA-Queue] Sent queued item #${item.id} to ${item.phone}`);
      processed++;
      // Delay between sends to avoid API overload
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      const attempts = item.attempts + 1;
      if (attempts >= item.max_attempts) {
        db.prepare(`
          UPDATE wa_queue SET status = 'failed', attempts = ?, last_error = ?
          WHERE id = ?
        `).run(attempts, errMsg, item.id);
        logger.error(`[WA-Queue] Item #${item.id} permanently failed after ${attempts} attempts: ${errMsg}`);
      } else {
        // Exponential backoff: 1m, 2m, 4m, 8m, 16m, 32m, 60m max
        const delayMin = Math.min(Math.pow(2, attempts - 1), 60);
        const nextRetry = new Date(Date.now() + delayMin * 60000)
          .toISOString().replace('T', ' ').slice(0, 19);
        db.prepare(`
          UPDATE wa_queue SET attempts = ?, last_error = ?, next_retry_at = ?
          WHERE id = ?
        `).run(attempts, errMsg, nextRetry, item.id);
        logger.info(`[WA-Queue] Item #${item.id} retry ${attempts}/${item.max_attempts}, next at ${nextRetry}`);
      }
    }
  }
  return { processed };
}

/**
 * Get queue stats
 */
function getQueueStats() {
  const stats = db.prepare(`
    SELECT status, COUNT(*) as count FROM wa_queue GROUP BY status
  `).all();
  return stats.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {});
}

/**
 * Start the queue worker (call once at app startup)
 */
let workerInterval = null;
function startWorker(intervalMs = 60000) {
  if (workerInterval) return;
  logger.info(`[WA-Queue] Worker started, interval=${intervalMs}ms`);
  workerInterval = setInterval(() => {
    processQueue().catch(e => logger.error(`[WA-Queue] Worker error: ${e.message}`));
  }, intervalMs);
  // Run once immediately
  processQueue().catch(e => logger.error(`[WA-Queue] Worker error: ${e.message}`));
}

function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

module.exports = { enqueue, enqueueText, processQueue, isInstanceConnected, getQueueStats, startWorker, stopWorker };
