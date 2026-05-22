const customerSvc = require("/root/ali-jaya-billing/services/customerService");
const billingSvc = require("/root/ali-jaya-billing/services/billingService");
const { sendWhatsApp } = require("/root/ali-jaya-billing/services/evolutionService");

function cleanPhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^0-9]/g, '');
  if (p.startsWith('0')) p = '62' + p.substring(1);
  return p.length >= 10 ? p : null;
}

const delay = (ms) => new Promise(res => setTimeout(res, ms));

async function run() {
  const customers = customerSvc.getAllCustomers();
  const targetCustomers = customers.filter(c => Number(c.isolate_day || 20) === 23);

  console.log(`Menemukan ${targetCustomers.length} target.`);

  for (const c of targetCustomers) {
    const phone = cleanPhone(c.phone);
    const unpaid = billingSvc.getUnpaidInvoicesByCustomerId(c.id);
    
    if (phone && unpaid.length > 0) {
      const total = unpaid.reduce((sum, inv) => sum + (Number(inv.amount) || 0), 0);
      const msg = `📢 *PENGINGAT PEMBAYARAN*\n\nHalo ${c.name},\nTagihan Anda sebesar *Rp ${total.toLocaleString("id-ID")}* jatuh tempo besok (Tgl 23).\nMohon segera bayar untuk menghindari isolir.\n\n*ZYA NET*`;
      
      console.log(`Menunggu 2 menit sebelum kirim ke ${c.name} (${phone})...`);
      await delay(120000); // 2 menit
      
      try {
        await sendWhatsApp(phone, msg);
        console.log(`✅ Sukses: ${c.name}`);
      } catch (e) {
        console.error(`❌ Gagal: ${c.name} - ${e.message}`);
      }
    }
  }
}
run();
