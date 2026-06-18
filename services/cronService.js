/**
 * Service: Penjadwalan Tugas Otomatis (Cron)
 */
const cron = require('node-cron');
const billingSvc = require('./billingService');
const { logger } = require('../config/logger');

const customerSvc = require('./customerService');
const mikrotikService = require('./mikrotikService');
const usageSvc = require('./usageService');
const { getSetting } = require('../config/settingsManager');

// Helper: Random delay generator untuk smart rate limiting
function getRandomDelay(baseDelayMs, varianceMs = 3000) {
  const minDelay = Math.max(baseDelayMs - varianceMs, 2000);
  const maxDelay = baseDelayMs + varianceMs;
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

// Helper: Exponential backoff untuk error handling
function getBackoffDelay(attemptCount, baseDelayMs = 2000) {
  const maxDelay = 30000;
  const delay = Math.min(baseDelayMs * Math.pow(2, attemptCount), maxDelay);
  return delay + Math.floor(Math.random() * 1000);
}

// Helper: Cek apakah error adalah permanent (tidak perlu retry)
function isPermanentError(errorMessage) {
  const permanentErrorPatterns = [
    /invalid.*number/i,
    /number.*not.*found/i,
    /phone.*not.*exist/i,
    /blocked/i,
    /banned/i,
    /not.*registered/i,
    /user.*not.*found/i,
    /404/i,
    /400/i
  ];
  return permanentErrorPatterns.some(pattern => pattern.test(errorMessage));
}

// Helper: Message variation untuk menghindari spam detection
function addMessageVariation(message, index) {
  const variations = [
    '',
    '\n\n_',
    '\n\n•',
    '\n\n▪',
    '\n\n▫'
  ];
  const suffix = variations[index % variations.length];
  return message + suffix;
}

function startCronJobs() {
  // 1. Generate Tagihan Otomatis H-1 sebelum isolate_day masing-masing pelanggan
  // Contoh: isolate_day=24 → invoice di-generate tgl 23 jam 08:00
  cron.schedule('0 8 * * *', async () => {
    const now = new Date();
    const today = now.getDate();
    const month = now.getMonth() + 1;
    const year = now.getFullYear();

    // Tentukan periode tagihan: jika H-1 sebelum isolate_day di bulan ini,
    // generate invoice untuk bulan berjalan.
    // Jika isolate_day sudah lewat bulan ini (misal isolate_day=5, hari ini tgl 4),
    // invoice tetap untuk bulan berjalan.
    try {
      const db = require('../config/database');
      const customers = db.prepare(
        "SELECT * FROM customers WHERE status = 'active' AND package_id IS NOT NULL"
      ).all();

      let created = 0;
      for (const c of customers) {
        const dueDay = Number(c.isolate_day) || Number(getSetting('isolir_day', 1)) || 1;
        // H-1 sebelum isolir — handle wrap-around untuk isolate_day=1
        let h1;
        if (dueDay === 1) {
          // H-1 dari tgl 1 = hari terakhir bulan ini (misal 31 Mei, 30 Juni)
          h1 = new Date(year, month, 0).getDate(); // day 0 of next month = last day of current month
        } else {
          h1 = dueDay - 1;
        }

        if (today !== h1) continue; // Bukan hari generate untuk pelanggan ini

        // Tentukan periode: bulan berjalan
        // Jika isolate_day sudah lewat bulan ini (misal isolate_day=5, sekarang tgl 4 bulan depan),
        // tetap generate untuk bulan berjalan
        try {
          const result = billingSvc.generateInvoiceForCustomer(c.id, month, year);
          if (result.created) {
            created++;
            logger.info(`[CRON] Invoice bulan ${month}/${year} dibuat untuk ${result.customerName} (isolir tgl ${dueDay})`);
          }
        } catch (err) {
          logger.error(`[CRON] Gagal generate invoice untuk customer ${c.id}: ${err.message}`);
        }
      }

      if (created > 0) {
        logger.info(`[CRON] Generate tagihan H-1: ${created} invoice baru dibuat.`);
      } else {
        logger.info(`[CRON] Generate tagihan H-1: tidak ada invoice baru hari ini (tgl ${today}).`);
      }
    } catch (error) {
      logger.error(`[CRON] Gagal generate tagihan H-1: ${error.message}`);
    }
  });

  // 2. Notif WA setiap hari jam 10:30
  cron.schedule('30 10 * * *', async () => {
    const enabled = getSetting('whatsapp_auto_billing_enabled', false);
    const waEnabled = getSetting('whatsapp_enabled', false) || getSetting('wa_evolution_enabled', false);
    if (!enabled || !waEnabled) return;

    let sendWA;
    try {
      const mod = await import('./evolutionService.js');
      sendWA = mod.sendWhatsApp;
    } catch (e) {
      logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
      return;
    }

    const resolveBaseUrl = () => {
      const explicit = String(getSetting('public_base_url', '') || '').trim();
      if (explicit) return explicit.replace(/\/+$/, '');

      const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
      const port = Number(getSetting('server_port', 3001) || 3001);
      const hasProto = /^https?:\/\//i.test(hostRaw);
      const proto = port === 443 ? 'https' : 'http';
      const host = hasProto ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
      const withPort = (port === 80 || port === 443) ? host : `${host}:${port}`;
      return withPort.replace(/\/+$/, '');
    };

    const loginLink = `${resolveBaseUrl()}/customer/dashboard`;
    const baseDelayMs = (Number(getSetting('whatsapp_broadcast_delay', 5) || 5) * 1000); // Default 5 detik
    const batchSize = 15; // 15 pesan per batch (dari 20)
    const batchPauseMs = 120000; // Pause 2 menit setelah batch (dari 1 menit)

    const today = new Date();
    const day = today.getDate();

    const customers = customerSvc.getAllCustomers();
    let targetCount = 0;
    let sent = 0;
    let failed = 0;
    let batchCount = 0;

    const defaultTemplate =
      `⚠️ *PENGINGAT PEMBAYARAN*\n\n` +
      `Yth. Pelanggan ZYA NET,\n` +
      `Tagihan Anda akan jatuh tempo. Segera lakukan pembayaran untuk menghindari isolir.\n\n` +
      `📅 *Tgl Isolir:* {{tgl_isolir}}\n` +
      `🔑 *ID Login:* {{id}}\n\n` +
      `Bayar di sini:\nbillingzyandra.zyanet.cloud/customer/dashboard\n\n` +
      `*ZYA - NET* 🌐\n` +
      `_Internet Stabil & Unlimited_`;

    for (const c of customers) {
        // ... (sisanya tidak berubah) ...
    }
  });

  // 3. Isolir Otomatis setiap hari jam 02:00
  //    - auto_isolate = 1 (Tagihan): isolir kalau today >= isolate_day
  //    - auto_isolate = 0 (Penagihan): isolir kalau invoice unpaid ≥ 30 hari
  cron.schedule('0 2 * * *', async () => {
    const today = new Date().getDate();
    logger.info(`[CRON] Menjalankan pengecekan isolir otomatis harian (Tanggal ${today})`);

    const db = require('../config/database');
    const customers = customerSvc.getAllCustomers();
    let isolatedCount = 0;
    let skippedCount = 0;

    for (const c of customers) {
      // Safety net: kalau 1 customer error, jangan hentikan loop
      try {
        // Hanya proses pelanggan aktif dengan tagihan belum bayar
        if (c.status !== 'active' || (c.unpaid_count || 0) <= 0) continue;

        // Cari invoice unpaid tertua
        const oldestUnpaid = db.prepare(
          "SELECT created_at, period_month, period_year FROM invoices WHERE customer_id = ? AND status = 'unpaid' ORDER BY created_at ASC LIMIT 1"
        ).get(c.id);

        if (!oldestUnpaid || !oldestUnpaid.created_at) continue;

        const invoiceDate = new Date(oldestUnpaid.created_at);
        const now = new Date();
        const daysSinceInvoice = Math.floor((now - invoiceDate) / (1000 * 60 * 60 * 24));

        // Dua jalur:
        // - auto_isolate = 1 (Tagihan): trigger berdasarkan isolate_day
        // - auto_isolate = 0 (Penagihan): grace 30 hari sejak invoice
        if (c.auto_isolate === 1) {
          if (today < c.isolate_day) continue; // Belum waktunya isolir
        } else {
          // Penagihan (auto_isolate = 0): tunggu 30 hari
          if (daysSinceInvoice < 30) continue;
        }

        // Saatnya isolir
        let attempt = 0;
        const maxAttempts = 3;
        let lastErr = null;
        while (++attempt <= maxAttempts) {
          try {
            const triggerLabel = c.auto_isolate === 1 ? `Tagihan (isolate_day=${c.isolate_day})` : `Penagihan (${daysSinceInvoice} hari)`;
            logger.info(`[CRON] Isolir otomatis: ${c.name} (${c.pppoe_username}) - ${triggerLabel} - Invoice ${oldestUnpaid.period_month}/${oldestUnpaid.period_year}`);
            // Gunakan fungsi terpusat untuk isolir
            await customerSvc.suspendCustomer(c.id);
            isolatedCount++;
            lastErr = null;
            break; // success
          } catch (err) {
            lastErr = err;
            logger.error(`[CRON] Gagal isolir ${c.name} (attempt ${attempt}/${maxAttempts}): ${err.message}`);
            if (attempt < maxAttempts) {
              const delay = attempt * 5 * 1000; // 5s, 10s, 15s
              logger.info(`[CRON] Retry in ${delay/1000}s...`);
              await new Promise(r => setTimeout(r, delay));
            }
          }
        }
        if (lastErr) {
          logger.error(`[CRON] Gagal isolir ${c.name} setelah ${maxAttempts} attempts: ${lastErr.message}`);
          skippedCount++;
        }
      } catch (outerErr) {
        // Tangkap error per-customer supaya loop tidak berhenti
        logger.error(`[CRON] Error saat proses customer ${c.name} (id=${c.id}): ${outerErr.message}`);
        skippedCount++;
      }
    }
    logger.info(`[CRON] Selesai pengecekan isolir. Total ${isolatedCount} pelanggan baru di-isolir, ${skippedCount} dilewati.`);
  });

  cron.schedule('0 10 * * *', async () => {
    const enabled = getSetting('whatsapp_auto_billing_enabled', false);
    const waEnabled = getSetting('wa_evolution_enabled', false);
    if (!enabled || !waEnabled) return;

    let sendWA;
    try {
      const mod = await import('./evolutionService.js');
      sendWA = mod.sendWhatsApp;
    } catch (e) {
      logger.error(`[CRON] Gagal load WhatsApp bot: ${e.message || e}`);
      return;
    }

    const resolveBaseUrl = () => {
      const explicit = String(getSetting('public_base_url', '') || '').trim();
      if (explicit) return explicit.replace(/\/+$/, '');

      const hostRaw = String(getSetting('server_host', 'localhost') || 'localhost').trim();
      const port = Number(getSetting('server_port', 3001) || 3001);
      const hasProto = /^https?:\/\//i.test(hostRaw);
      const proto = port === 443 ? 'https' : 'http';
      const host = hasProto ? hostRaw.replace(/\/+$/, '') : `${proto}://${hostRaw}`;
      const withPort = (port === 80 || port === 443) ? host : `${host}:${port}`;
      return withPort.replace(/\/+$/, '');
    };

    const loginLink = `${resolveBaseUrl()}/customer/dashboard`;
    const baseDelayMs = (Number(getSetting('whatsapp_broadcast_delay', 5) || 5) * 1000); // Default 5 detik
    const batchSize = 15; // 15 pesan per batch (dari 20)
    const batchPauseMs = 120000; // Pause 2 menit setelah batch (dari 1 menit)

    const today = new Date();
    const day = today.getDate();

    const customers = customerSvc.getAllCustomers();
    let targetCount = 0;
    let sent = 0;
    let failed = 0;
    let batchCount = 0;

    const defaultTemplate =
      `⚠️ *PENGINGAT PEMBAYARAN*\n\n` +
      `Yth. Pelanggan ZYA NET,\n` +
      `Tagihan Anda akan jatuh tempo. Segera lakukan pembayaran untuk menghindari isolir.\n\n` +
      `📅 *Tgl Isolir:* {{tgl_isolir}}\n` +
      `🔑 *ID Login:* {{id}}\n\n` +
      `Bayar di sini:\nbillingzyandra.zyanet.cloud/customer/dashboard\n\n` +
      `*ZYA - NET* 🌐\n` +
      `_Internet Stabil & Unlimited_`;
    const template = String(getSetting('whatsapp_auto_billing_message', defaultTemplate) || defaultTemplate);

    // Filter pelanggan yang perlu diingatkan
    const targetCustomers = [];
    for (const c of customers) {
      const phone = c.phone ? String(c.phone).trim() : '';
      if (!phone || phone.length < 9) continue;
      if (c.status !== 'active') continue;
      const unpaidCount = Number(c.unpaid_count || 0) || 0;
      if (unpaidCount <= 0) continue;

      const dueDay = Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 1) || 1) || 1;
      const remind1 = dueDay - 1;
      const shouldSend = remind1 >= 1 && day === remind1;
      if (!shouldSend) continue;

      targetCustomers.push(c);
    }

    if (targetCustomers.length === 0) {
      logger.info('[CRON] Tidak ada pelanggan yang perlu diingatkan hari ini.');
      return;
    }

    logger.info(`[CRON] Memulai pengingat tagihan otomatis untuk ${targetCustomers.length} pelanggan dengan smart rate limit.`);

    // Kirim pesan dengan smart rate limit
    for (let i = 0; i < targetCustomers.length; i++) {
      const c = targetCustomers[i];
      let attemptCount = 0;
      const maxAttempts = 3;

      while (attemptCount < maxAttempts) {
        let formattedMsg = '';
        try {
          // Smart Random Delay
          const randomDelay = getRandomDelay(baseDelayMs, 2000);
          await new Promise(r => setTimeout(r, randomDelay));

          const unpaidInvoices = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
          const totalTagihan = unpaidInvoices.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
          const rincianBulan = unpaidInvoices.map(inv => `${inv.period_month}/${inv.period_year}`).join(', ');

          // Format pesan dengan variation untuk anti-spam
          const dueDay = Number(c.isolate_day || 0) || Number(getSetting('isolir_day', 1) || 1) || 1;
          formattedMsg = template
            .replace(/{{nama}}/gi, c.name || 'Pelanggan')
            .replace(/{{tagihan}}/gi, totalTagihan.toLocaleString('id-ID'))
            .replace(/{{rincian}}/gi, rincianBulan || '-')
            .replace(/{{paket}}/gi, c.package_name || '-')
            .replace(/{{link}}/gi, loginLink)
            .replace(/{{tgl_isolir}}/gi, String(dueDay))
            .replace(/{{id}}/gi, c.customer_code || '-');

          // Add subtle variation untuk menghindari spam detection
          formattedMsg = addMessageVariation(formattedMsg, i);

          const result = await sendWA(c.phone, formattedMsg);
          const ok = result && result.success === true;
          if (ok) {
            sent++;
            targetCount++;
            batchCount++;
          } else {
            throw new Error('Gagal kirim pesan');
          }

          // Batch Processing: Pause setelah N pesan
          if (batchCount >= batchSize && i < targetCustomers.length - 1) {
            logger.info(`[CRON] Selesai batch ${Math.floor(i / batchSize) + 1} (${batchSize} pesan). Pause ${Math.floor(batchPauseMs / 1000)} detik...`);
            await new Promise(r => setTimeout(r, batchPauseMs));
            batchCount = 0;
          }

          break; // Sukses, keluar dari retry loop
        } catch (e) {
          attemptCount++;
          const errorMsg = e.message || e.toString();

          // Cek apakah error permanent (tidak perlu retry)
          if (isPermanentError(errorMsg)) {
            logger.warn(`[CRON] SKIP: Error permanent untuk ${c.phone} - ${errorMsg}`);
            failed++;
            break; // Skip retry langsung ke pelanggan berikutnya
          }

          // Error temporary, bisa retry
          logger.error(`[CRON] Gagal kirim ke ${c.phone} (attempt ${attemptCount}/${maxAttempts}): ${errorMsg}`);

          if (attemptCount >= maxAttempts) {
            logger.warn(`[CRON] Max attempts tercapai untuk ${c.phone}`);
            failed++;

            // Simpan ke pending_notifications untuk auto-retry
            try {
              const db = require('../config/database');
              db.prepare(`INSERT INTO pending_notifications (customer_id, type, phone, message, retry_count, max_retries, error, next_retry_at) VALUES (?, ?, ?, ?, 0, 5, ?, datetime('now', '+1 hour'))`).run(c.id, 'h1_reminder', c.phone, formattedMsg, errorMsg);
              logger.info('[CRON] Disimpan ke pending_notifications untuk retry otomatis: ' + c.name);
            } catch (dbErr) { logger.error('[CRON] Gagal simpan pending: ' + dbErr.message); }
          } else {
            // Exponential backoff untuk retry
            const backoffDelay = getBackoffDelay(attemptCount);
            logger.info(`[CRON] Retry ke ${c.phone} dalam ${Math.floor(backoffDelay / 1000)} detik...`);
            await new Promise(r => setTimeout(r, backoffDelay));
          }
        }
      }
    }

    logger.info(`[CRON] Pengingat tagihan otomatis selesai: target=${targetCount}, terkirim=${sent}, gagal=${failed}`);

    // Kirim laporan summary ke admin
    try {
      const adminPhones = String(getSetting('whatsapp_admin_numbers', '') || '').split(',').map(s => s.trim()).filter(Boolean);
      if (adminPhones.length > 0) {
        const summaryMsg = `📋 *Laporan Pengingat Tagihan*\n\n` +
          `📅 Tanggal: ${new Date().toLocaleDateString('id-ID')}\n` +
          `👥 Target: ${targetCount} pelanggan\n` +
          `✅ Terkirim: ${sent}\n` +
          `❌ Gagal: ${failed}\n\n` +
          `_Cron otomatis jam 09:00 WITA_`;
        for (const adminPhone of adminPhones) {
          try { await sendWA(adminPhone, summaryMsg); } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore admin summary errors */ }
  });

  // 4. Jam Kalong (Night Speed) Start - Jam 00:00
  cron.schedule('0 0 * * *', async () => {
    logger.info('[CRON] Memulai Jam Kalong (Night Speed) - Ganti Profile...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        if (c.status === 'suspended') continue; // SKIP user suspended (sudah isolir)
        
        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1 && pkg.night_profile_name) {
          try {
            logger.info(`[CRON] Switching ${c.name} to Night Profile: ${pkg.night_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, pkg.night_profile_name, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal switch Jam Kalong untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Jam Kalong aktif untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong Start: ${e.message}`);
    }
  });

  // 5. Jam Kalong (Night Speed) End - Jam 06:00
  cron.schedule('0 6 * * *', async () => {
    logger.info('[CRON] Mengakhiri Jam Kalong (Night Speed) - Kembali ke Profile Normal...');
    try {
      const customers = customerSvc.getAllCustomers();
      let count = 0;

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        if (c.status === 'suspended') continue; // SKIP user suspended (sudah isolir)

        const pkg = customerSvc.getPackageById(c.package_id);
        if (pkg && pkg.use_night_speed === 1) {
          try {
            // Kembali ke profile asli (nama paket)
            const normalProfile = pkg.name;
            logger.info(`[CRON] Restoring ${c.name} to Normal Profile: ${normalProfile}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, normalProfile, c.router_id);
            count++;
          } catch (err) {
            logger.error(`[CRON] Gagal restore profil normal untuk ${c.name}: ${err.message}`);
          }
        }
      }
      logger.info(`[CRON] Profil normal dikembalikan untuk ${count} pelanggan.`);
    } catch (e) {
      logger.error(`[CRON] Error Jam Kalong End: ${e.message}`);
    }
  });

  // 6. Track Usage Pelanggan (Data Traffic) - Setiap 10 Menit
  cron.schedule('*/10 * * * *', async () => {
    const enabled = getSetting('usage_tracking_enabled', true);
    if (!enabled) return;

    try {
      const routers = mikrotikService.getAllRouters();
      const customers = customerSvc.getAllCustomers();
      const customerMap = new Map();
      customers.forEach(c => { if (c.pppoe_username) customerMap.set(c.pppoe_username, c); });

      for (const r of routers) {
        try {
          const actives = await mikrotikService.getPppoeActive(r.id);
          for (const s of actives) {
            const username = s.name;
            const cust = customerMap.get(username);
            if (!cust) continue;

            const totalIn = parseInt(s['bytes-in']) || 0;
            const totalOut = parseInt(s['bytes-out']) || 0;

            const now = new Date();
            const currentUsage = usageSvc.getUsage(cust.id, now.getMonth()+1, now.getFullYear());

            let deltaIn = 0;
            let deltaOut = 0;

            if (currentUsage) {
              // Jika total bytes saat ini lebih kecil dari sebelumnya, berarti user baru reconnect (counter reset di mikrotik)
              if (totalIn < currentUsage.last_total_bytes_in || totalOut < currentUsage.last_total_bytes_out) {
                deltaIn = totalIn;
                deltaOut = totalOut;
              } else {
                deltaIn = totalIn - currentUsage.last_total_bytes_in;
                deltaOut = totalOut - currentUsage.last_total_bytes_out;
              }
            } else {
              deltaIn = totalIn;
              deltaOut = totalOut;
            }

            if (deltaIn > 0 || deltaOut > 0) {
              usageSvc.updateUsage(cust.id, deltaIn, deltaOut, totalIn, totalOut);
            }
          }
        } catch (err) {
          logger.error(`[CRON] Gagal track usage di router ${r.name}: ${err.message}`);
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error Usage Tracking: ${e.message}`);
    }
  });

  // 7. FUP (Fair Usage Policy) Check - Setiap Jam
  cron.schedule('0 * * * *', async () => {
    logger.info('[CRON] Mengecek FUP Pelanggan...');
    try {
      const customers = customerSvc.getAllCustomers();
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();

      for (const c of customers) {
        if (!c.package_id || !c.pppoe_username) continue;
        
        const pkg = customerSvc.getPackageById(c.package_id);
        if (!pkg || pkg.use_fup !== 1 || !pkg.fup_limit_gb || pkg.fup_limit_gb <= 0 || !pkg.fup_profile_name) continue;

        const usage = usageSvc.getUsage(c.id, month, year);
        if (!usage) continue;

        const totalGB = (usage.bytes_in + usage.bytes_out) / (1024 * 1024 * 1024);
        
        if (totalGB >= pkg.fup_limit_gb) {
          logger.warn(`[CRON] Pelanggan ${c.name} melewati FUP (${totalGB.toFixed(2)} GB / ${pkg.fup_limit_gb} GB). Menurunkan kecepatan (Ganti Profile)...`);
          
          try {
            // Ganti ke profile FUP yang sudah ditentukan di paket
            logger.info(`[CRON] Switching ${c.name} to FUP Profile: ${pkg.fup_profile_name}`);
            await mikrotikService.setPppoeProfile(c.pppoe_username, pkg.fup_profile_name, c.router_id);
          } catch (err) {
            logger.error(`[CRON] Gagal apply FUP untuk ${c.name}: ${err.message}`);
          }
        }
      }
    } catch (e) {
      logger.error(`[CRON] Error FUP Check: ${e.message}`);
    }
  });

  // ============================================================
  // CRON: Retry pending notifications setiap jam (menit ke-30)
  // ============================================================
  cron.schedule("30 * * * *", async () => {
    const db = require("../config/database");
    let sendWA;
    try {
      const mod = await import("./evolutionService.js");
      sendWA = mod.sendWhatsApp;
    } catch (e) {
      logger.error("[RETRY-CRON] Gagal load WA module: " + e.message);
      return;
    }

    const pending = db.prepare(
      "SELECT * FROM pending_notifications WHERE retry_count < max_retries AND (next_retry_at IS NULL OR next_retry_at <= datetime('now', '+8 hours')) ORDER BY created_at ASC LIMIT 10"
    ).all();

    if (pending.length === 0) return;

    logger.info("[RETRY-CRON] Memproses " + pending.length + " notifikasi pending...");
    let retried = 0, success = 0, stillFailed = 0;

    for (const p of pending) {
      retried++;
      await new Promise(r => setTimeout(r, 60000));

      const result = await sendWA(p.phone, p.message);
      if (result && result.success === true) {
        db.prepare("DELETE FROM pending_notifications WHERE id = ?").run(p.id);
        try {
          db.prepare("INSERT INTO notification_log (customer_id, type, status, sent_at, created_at) VALUES (?, ?, 'sent', datetime('now', '+8 hours'), datetime('now', '+8 hours'))").run(p.customer_id, p.type);
        } catch(e) {}
        // Jika type=receipt, mark invoice receipt_sent=1
        if (p.type === 'receipt') {
          try {
            const inv = db.prepare("SELECT id FROM invoices WHERE customer_id = ? AND status = 'paid' AND receipt_sent = 0 ORDER BY paid_at DESC LIMIT 1").get(p.customer_id);
            if (inv) db.prepare("UPDATE invoices SET receipt_sent = 1 WHERE id = ?").run(inv.id);
          } catch(e2) {}
        }
        success++;
        logger.info("[RETRY-CRON] Berhasil kirim ulang ke " + p.phone);
      } else {
        const newRetry = p.retry_count + 1;
        const errMsg = (result && result.error) || "unknown";
        if (newRetry >= p.max_retries) {
          db.prepare("UPDATE pending_notifications SET retry_count = ?, error = ?, updated_at = datetime('now', '+8 hours') WHERE id = ?").run(newRetry, errMsg, p.id);
          logger.warn("[RETRY-CRON] Max retries untuk " + p.phone);
        } else {
          db.prepare("UPDATE pending_notifications SET retry_count = ?, error = ?, next_retry_at = datetime('now', '+1 hour', '+8 hours'), updated_at = datetime('now', '+8 hours') WHERE id = ?").run(newRetry, errMsg, p.id);
        }
        stillFailed++;
      }
    }

    logger.info("[RETRY-CRON] Selesai: " + retried + " diproses, " + success + " berhasil, " + stillFailed + " masih gagal");

    if (success > 0) {
      try {
        const adminPhones = String(getSetting("whatsapp_admin_numbers", "") || "").split(",").map(s => s.trim()).filter(Boolean);
        const msg = "Retry Notifikasi: " + success + " pesan berhasil dikirim ulang, " + stillFailed + " masih gagal. (auto-retry cron)";
        for (const ph of adminPhones) {
          try { await sendWA(ph, msg); } catch(e) {}
        }
      } catch(e) {}
    }
  });

  logger.info('[CRON] Semua tugas penjadwalan telah aktif.');
}

module.exports = { startCronJobs };
