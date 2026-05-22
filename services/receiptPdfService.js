const db = require('../config/database');
const { formatRupiah, numberToWords } = require('./utils');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ||
  '/root/.cache/puppeteer/chrome/linux-148.0.7778.97/chrome-linux64/chrome';

function generateReceipt(invoiceId, outputPath) {
  return new Promise(async (resolve, reject) => {
    try {
      // Fetch invoice data
      const invoice = db.prepare(`
        SELECT i.*, c.name as customer_name, c.address, c.phone as customer_phone, c.id as customer_id, c.isolate_day, p.name as package_name
        FROM invoices i
        JOIN customers c ON i.customer_id = c.id
        LEFT JOIN packages p ON c.package_id = p.id
        WHERE i.id = ?
      `).get(invoiceId);

      if (!invoice) {
        throw new Error('Invoice not found');
      }

      const dateStr = new Date(invoice.paid_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
      const monthStr = new Date(invoice.paid_at).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });

      // Hitung tanggal aktif sampai (isolate_day bulan berikutnya dari periode invoice)
      const isolateDay = invoice.isolate_day || 10;
      const nextMonth = (invoice.period_month % 12) + 1;
      const nextYear = invoice.period_month === 12 ? invoice.period_year + 1 : invoice.period_year;
      const activeUntilDate = new Date(nextYear, nextMonth - 1, isolateDay);
      const activeUntilStr = activeUntilDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });

      const html = `
<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bukti Pembayaran ZYA NET</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @media print {
            .no-print { display: none; }
            body { background-color: white; }
            .invoice-card { border: none; shadow: none; }
        }
    </style>
</head>
<body class="bg-gray-100 p-4 md:p-10 font-sans">

    <!-- Kontainer Utama -->
    <div class="max-w-3xl mx-auto bg-white shadow-xl rounded-lg overflow-hidden relative invoice-card">
        
        <!-- Header -->
        <div class="bg-blue-600 p-8 text-white flex flex-col md:flex-row justify-between items-center">
            <div class="text-center md:text-left">
                <h1 class="text-3xl font-bold tracking-wider">ZYA NET BULUKUMBA</h1>
                <p class="text-blue-100 italic">Internet Cepat & Stabil</p>
            </div>
            <div class="mt-4 md:mt-0 text-center md:text-right">
                <h2 class="text-xl font-semibold border-b-2 border-blue-400 pb-1">BUKTI PEMBAYARAN</h2>
                <p class="text-sm mt-1 opacity-90">Invoice #${invoice.id}</p>
            </div>
        </div>

        <!-- Detail Pelanggan -->
        <div class="p-8 grid grid-cols-1 md:grid-cols-2 gap-6 border-b border-gray-100">
            <div>
                <h3 class="text-gray-500 text-xs font-bold uppercase tracking-widest mb-2">Informasi Pelanggan</h3>
                <p class="text-lg font-semibold text-gray-800">${invoice.customer_name}</p>
                <p class="text-gray-600">ID: <span class="font-mono">${invoice.customer_id}</span></p>
                <p class="text-gray-600 text-sm mt-1">${invoice.address || 'Bulukumba, Sulawesi Selatan'}</p>
            </div>
            <div class="md:text-right">
                <h3 class="text-gray-500 text-xs font-bold uppercase tracking-widest mb-2">Rincian Transaksi</h3>
                <p class="text-gray-600 text-sm">Metode: <span class="font-medium text-gray-800">${invoice.paid_by_name || 'Admin'}</span></p>
                <p class="text-gray-600 text-sm">Tanggal: <span class="font-medium text-gray-800">${dateStr}</span></p>
                <p class="text-gray-600 text-sm">Status: <span class="inline-block bg-green-100 text-green-700 px-2 py-0.5 rounded-full text-xs font-bold">LUNAS</span></p>
                <p class="text-gray-600 text-sm mt-1">Aktif sampai: <span class="font-medium text-gray-800">${activeUntilStr}</span></p>
            </div>
        </div>

        <!-- Tabel Item -->
        <div class="p-8">
            <table class="w-full text-left border-collapse">
                <thead>
                    <tr class="text-gray-500 border-b border-gray-200">
                        <th class="py-3 font-semibold text-sm">No</th>
                        <th class="py-3 font-semibold text-sm">Deskripsi</th>
                        <th class="py-3 font-semibold text-sm">Periode</th>
                        <th class="py-3 font-semibold text-sm text-right">Jumlah</th>
                    </tr>
                </thead>
                <tbody>
                    <tr class="border-b border-gray-50">
                        <td class="py-4 text-gray-800">1</td>
                        <td class="py-4 text-gray-800">${invoice.package_name || 'Paket Internet Bulanan'}</td>
                        <td class="py-4 text-gray-800 text-sm">${monthStr}</td>
                        <td class="py-4 text-gray-800 text-right font-semibold">${formatRupiah(invoice.amount)}</td>
                    </tr>
                </tbody>
            </table>
            <!-- Total -->
            <div class="mt-6 flex flex-col items-end">
                <div class="w-full md:w-1/2">
                    <div class="flex justify-between py-2 text-gray-600 border-t border-gray-100">
                        <span>Subtotal</span>
                        <span>${formatRupiah(invoice.amount)}</span>
                    </div>
                    <div class="flex justify-between py-3 border-t-2 border-gray-800 text-xl font-bold text-gray-900">
                        <span>TOTAL</span>
                        <span>${formatRupiah(invoice.amount)}</span>
                    </div>
                    <p class="text-xs text-gray-500 italic mt-2 text-right">Terbilang: ${numberToWords(invoice.amount)}</p>
                </div>
            </div>
        </div>

        <!-- Footer / Tanda Tangan -->
        <div class="p-8 bg-gray-50 flex flex-col md:flex-row justify-between items-start">
            <div class="text-xs text-gray-500 max-w-xs mb-6 md:mb-0">
                <p class="font-bold mb-1">Catatan Penting:</p>
                <ul class="list-disc ml-4 space-y-1">
                    <li>Invoice ini adalah bukti pembayaran yang sah.</li>
                    <li>Simpan dokumen ini sebagai referensi layanan.</li>
                    <li>Terima kasih telah menggunakan layanan ZYA NET.</li>
                </ul>
            </div>
            
            <div class="text-center w-full md:w-auto">
                <p class="text-sm text-gray-600 mb-1">Bulukumba, ${dateStr}</p>
                <p class="text-xs text-gray-500 uppercase tracking-tighter mb-4">Mengetahui, Manager Operasional</p>
                
                <!-- Stempel Lunas -->
                <div class="inline-block border-[3px] border-blue-600 rounded-lg px-8 py-2 mb-4 bg-white">
                    <p class="text-blue-600 font-bold text-xl tracking-widest">ZYA NET</p>
                    <p class="text-blue-500 text-sm tracking-widest mt-0.5">PAID / LUNAS</p>
                </div>
                
                <div class="relative inline-block w-full">
                    <p class="text-xl font-serif text-blue-800 font-bold underline decoration-double">ANDI PARAWANSAH</p>
                    <p class="text-xs text-gray-500 mt-1 uppercase font-bold">ZYA NET BULUKUMBA</p>
                </div>
            </div>
        </div>
    </div>
</body>
</html>`;

      const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.pdf({
        path: outputPath,
        format: 'A4',
        printBackground: true,
        margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
      });
      await browser.close();

      resolve(outputPath);
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceipt };

