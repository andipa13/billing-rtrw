/**
 * Helper: Kirim notifikasi pelunasan via WA dengan fallback ke pending_notifications
 * Jika WA offline/gagal, otomatis masuk antrian retry (cron tiap jam)
 */
const { logger } = require('../config/logger');
const db = require('../config/database');

/**
 * Kirim receipt WA. Kalau gagal, simpan ke pending_notifications.
 * @param {number} customerId
 * @param {string} phone - nomor WA (format 62xxx)
 * @param {string} message - teks notifikasi
 * @param {number} invoiceId - ID invoice (untuk logging)
 * @returns {Promise<{success: boolean, queued?: boolean}>}
 */
async function sendReceiptOrQueue(customerId, phone, message, invoiceId) {
  if (!phone) {
    logger.info(`[Receipt] Skipped: no phone for customer ${customerId}`);
    return { success: false };
  }

  try {
    const { sendWhatsAppText } = await import('./evolutionService.js');
    const waResult = await sendWhatsAppText(phone, message);

    if (waResult.success) {
      logger.info(`[Receipt] Sent to ${phone} (invoice ${invoiceId})`);
      // Mark receipt_sent = 1
      db.prepare('UPDATE invoices SET receipt_sent = 1 WHERE id = ?').run(invoiceId);
      return { success: true };
    }

    // WA gagal — queue untuk retry
    const errMsg = typeof waResult.error === 'object'
      ? JSON.stringify(waResult.error) : String(waResult.error || 'unknown');
    logger.warn(`[Receipt] WA failed for ${phone} (invoice ${invoiceId}): ${errMsg} — queued for retry`);

    db.prepare(
      `INSERT INTO pending_notifications 
       (customer_id, type, phone, message, retry_count, max_retries, error, next_retry_at)
       VALUES (?, 'receipt', ?, ?, 0, 5, ?, datetime('now', '+10 minutes', '+8 hours'))`
    ).run(customerId, phone, message, errMsg);

    return { success: false, queued: true };
  } catch (e) {
    const errMsg = e.message || String(e);
    logger.error(`[Receipt] Exception sending to ${phone} (invoice ${invoiceId}): ${errMsg} — queued for retry`);

    db.prepare(
      `INSERT INTO pending_notifications 
       (customer_id, type, phone, message, retry_count, max_retries, error, next_retry_at)
       VALUES (?, 'receipt', ?, ?, 0, 5, ?, datetime('now', '+10 minutes', '+8 hours'))`
    ).run(customerId, phone, message, errMsg);

    return { success: false, queued: true };
  }
}

module.exports = { sendReceiptOrQueue };
