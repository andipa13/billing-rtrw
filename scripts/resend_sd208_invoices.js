/**
 * Script: Resend invoice April & Mei 2026 untuk SD 208 via WhatsApp
 * Usage: node scripts/resend_sd208_invoices.js
 */
const path = require('path');
const fs = require('fs');
const db = require('../config/database');
const { getSettings } = require('../config/settingsManager');
const waSvc = require('../services/waUnifiedService');

// ── Load settings (sync) ─────────────────────────────────────────
const settings = getSettings();
const COMPANY = settings.company_header || 'ZYA NET';
const BASE_URL = settings.public_base_url || 'http://billingzyandra.zyanet.cloud';

// ── Customer & Invoice data ──────────────────────────────────────
const CUSTOMER_ID = 85199796;
const CUSTOMER_NAME = 'SD 208';
const CUSTOMER_PHONE = '085341855111';
const INVOICE_IDS = [546, 547]; // April=546, Mei=547

// ── Helpers ──────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agt','Sep','Okt','Nov','Des'];

function getInvoice(invId) {
  return db.prepare(`
    SELECT i.*, c.name as customer_name, c.phone as customer_phone, c.pppoe_username,
           p.name as package_name, p.price as package_price
    FROM invoices i
    JOIN customers c ON i.customer_id = c.id
    LEFT JOIN packages p ON c.package_id = p.id
    WHERE i.id = ?
  `).get(invId);
}

async function generateInvoiceHtml(inv) {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Invoice #${inv.id}</title>
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #222; margin: 40px; max-width: 700px; }
    .header { border-bottom: 3px solid #1a56db; padding-bottom: 16px; margin-bottom: 24px; }
    .company { font-size: 22px; font-weight: bold; color: #1a56db; }
    .sub { color: #666; font-size: 12px; }
    .section { margin-bottom: 20px; }
    .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .value { font-size: 15px; font-weight: bold; }
    .invoice-box { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px; margin: 20px 0; }
    .row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
    .row:last-child { border-bottom: none; }
    .total { background: #1a56db; color: white; border-radius: 6px; padding: 14px 18px; margin-top: 12px; }
    .total-label { font-size: 13px; opacity: 0.9; }
    .total-amount { font-size: 22px; font-weight: bold; }
    .footer { margin-top: 32px; font-size: 11px; color: #888; text-align: center; }
    .badge { background: #fef3c7; color: #92400e; padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: bold; display: inline-block; }
    .period-badge { background: #dbeafe; color: #1e40af; padding: 6px 14px; border-radius: 6px; font-size: 14px; font-weight: bold; }
    .qr-section { margin-top: 20px; }
    .method-label { font-size: 12px; color: #666; margin-top: 6px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="company">${COMPANY}</div>
    <div class="sub">Tagihan Internet — Periode ${MONTHS[inv.period_month-1]} ${inv.period_year}</div>
  </div>

  <div class="section">
    <div class="label">Pelanggan</div>
    <div class="value">${inv.customer_name}</div>
  </div>

  <div class="section">
    <div class="label">ID Pelanggan</div>
    <div>${inv.customer_phone || '-'}</div>
  </div>

  <div class="section">
    <div class="label">Paket</div>
    <div>${inv.package_name || 'Internet Service'}</div>
  </div>

  <div class="invoice-box">
    <div style="margin-bottom: 12px;">
      <span class="period-badge">${MONTHS[inv.period_month-1]} ${inv.period_year}</span>
    </div>
    <div class="row">
      <span>Tagihan Internet</span>
      <span>Rp ${Number(inv.amount).toLocaleString('id-ID')}</span>
    </div>
    <div class="row">
      <span>Admin / Lainnya</span>
      <span>Rp 0</span>
    </div>
    <div class="total">
      <div class="total-label">TOTAL TAGIHAN</div>
      <div class="total-amount">Rp ${Number(inv.amount).toLocaleString('id-ID')}</div>
    </div>
  </div>

  <div style="margin: 20px 0;">
    <span class="badge">STATUS: BELUM BAYAR</span>
  </div>

  <div class="section" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:16px;">
    <div style="font-weight:bold;color:#92400e;margin-bottom:8px;">⚠️ Perhatian</div>
    <div style="font-size:13px;color:#78350f;">
      Segera lakukan pembayaran sebelum <strong>hari ke-10</strong> setiap bulan.<br>
      Setelah batas waktu, layanan internet akan otomatis dibatasi/isolir.
    </div>
  </div>

  <div class="section">
    <div class="label">Pembayaran via</div>
    <div class="method-label">Transfer BCA / BRI / BSI — No. Rekoming akan dikirim terpisah</div>
    <div style="margin-top:10px;font-size:12px;color:#666;">
      Atau bayar langsung via portal: <a href="${BASE_URL}/customer/login">${BASE_URL}/customer/login</a>
    </div>
  </div>

  <div class="footer">
    Dicetak dari sistem billing ${COMPANY} · Invoice #${inv.id} · ${MONTHS[inv.period_month-1]} ${inv.period_year}<br>
    Jika sudah membayar, abaikan pesan ini. Terima kasih.
  </div>
</body>
</html>`;
  return html;
}

async function htmlToPdfBuffer(html) {
  const puppeteer = require('puppeteer-core');
  const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ||
    '/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome';

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
  await browser.close();
  return pdfBuffer;
}

async function main() {
  console.log('=== Resend Invoice SD 208 (April & Mei 2026) ===\n');

  for (const invId of INVOICE_IDS) {
    const inv = getInvoice(invId);
    if (!inv) {
      console.log(`❌ Invoice #${invId} tidak ditemukan`);
      continue;
    }

    console.log(`\n📄 Proses Invoice #${invId} (${MONTHS[inv.period_month-1]} ${inv.period_year})`);
    console.log(`   Customer : ${inv.customer_name}`);
    console.log(`   Paket    : ${inv.package_name}`);
    console.log(`   Jumlah   : Rp ${Number(inv.amount).toLocaleString('id-ID')}`);
    console.log(`   Status   : ${inv.status}`);

    if (inv.status === 'paid') {
      console.log(`   ⚠️ Invoice sudah LUNAS — skip`);
      continue;
    }

    // 1. Generate PDF
    console.log(`   🔧 Generate PDF...`);
    const html = await generateInvoiceHtml(inv);
    const pdfBuffer = await htmlToPdfBuffer(html);

    const tmpPath = `/tmp/invoice_${invId}_${Date.now()}.pdf`;
    fs.writeFileSync(tmpPath, pdfBuffer);
    console.log(`   ✅ PDF saved: ${tmpPath}`);

    // 2. Format WA message
    const msg = `📋 *TAGIHAN INTERNET*

Yth. *${inv.customer_name}*

Berikut tagihan internet yang belum dibayar:

━━━━━━━━━━━━━━━
🗓 *Periode:* ${MONTHS[inv.period_month-1]} ${inv.period_year}
📦 *Paket:* ${inv.package_name}
💰 *Jumlah:* Rp ${Number(inv.amount).toLocaleString('id-ID')}
━━━━━━━━━━━━━━━

⚠️ *Segera bayar sebelum hari ke-10* setiap bulan agar layanan tidak terputus.

Bayar via transfer:
🏦 BCA / BRI / BSI
(No. rekening akan dikirim terpisah)

Atau login di:
🌐 ${BASE_URL}/customer/login

Jika sudah membayar, abaikan pesan ini.
Terima kasih.

*${COMPANY}* 🌐`;

    // 3. Send WhatsApp with PDF
    console.log(`   📤 Kirim WA ke ${CUSTOMER_PHONE}...`);
    const phone = CUSTOMER_PHONE.startsWith('62') ? CUSTOMER_PHONE : '62' + CUSTOMER_PHONE.replace(/^0/, '');
    const result = await waSvc.sendWhatsAppMedia(phone, tmpPath, msg);

    if (result.success) {
      console.log(`   ✅ WA terkirim! (Invoice #${invId})`);
    } else {
      console.log(`   ❌ WA gagal: ${result.error}`);
      // Fallback: try text only
      console.log(`   📝 Fallback: kirim text only...`);
      const textResult = await waSvc.sendWhatsAppText(phone, msg);
      console.log(`   ${textResult.success ? '✅' : '❌'} Text WA: ${textResult.success ? 'terkirim' : textResult.error}`);
    }

    // Clean up
    fs.unlinkSync(tmpPath);
    console.log(`   🧹 Cleanup done`);
  }

  console.log('\n=== Selesai ===');
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
