/**
 * Ambil daftar voucher hotspot yg sudah terpakai dari MikroTik
 * lalu kirim ke Telegram admin.
 */
const { RouterOSClient } = require('routeros-client');
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs');

// Baca settings.json
const settingsPath = path.join(__dirname, '..', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));

const host = settings.mikrotik_host;
const port = settings.mikrotik_port || 8728;
const user = settings.mikrotik_user;
const password = settings.mikrotik_password;
const token = settings.telegram_bot_token;
const adminIds = settings.telegram_admin_chat_ids || [settings.telegram_admin_id].filter(Boolean);

async function main() {
  // 1. Konek MikroTik
  const api = new RouterOSClient({ host, port, user, password, timeout: 10000 });
  const client = await api.connect();

  const users = await client.menu('/ip/hotspot/user').get();
  api.close();

  // 2. Filter voucher yg sudah terpakai
  // Voucher = comment starts with "vc-"
  // Terpakai = uptime is not empty and not "0s"
  const used = users.filter(u => {
    const comment = (u.comment || '').trim();
    if (!comment.startsWith('vc-')) return false;
    const uptime = (u.uptime || '').trim();
    return uptime !== '' && uptime !== '0s';
  });

  if (used.length === 0) {
    const bot = new TelegramBot(token, { polling: false });
    for (const chatId of adminIds) {
      await bot.sendMessage(chatId, '✅ Tidak ada voucher terpakai.');
    }
    console.log('Tidak ada voucher terpakai.');
    return;
  }

  // 3. Group by profile
  const grouped = {};
  used.forEach(v => {
    const p = v.profile || 'default';
    if (!grouped[p]) grouped[p] = [];
    grouped[p].push(v);
  });

  // 4. Format message
  let msg = `📊 *VOUCHER TERPAKAI* (${used.length} total)\n\n`;

  for (const [profile, vouchers] of Object.entries(grouped)) {
    // Sort by uptime descending (yang paling lama dipakai di atas)
    vouchers.sort((a, b) => (b.uptime || '').localeCompare(a.uptime || ''));
    msg += `*${profile}* — ${vouchers.length} pcs\n`;
    msg += '```\n';
    vouchers.forEach(v => {
      const code = v.name || '-';
      const uptime = v.uptime || '0s';
      msg += `${code} (${uptime})\n`;
    });
    msg += '```\n';
  }

  // 5. Kirim ke Telegram
  const bot = new TelegramBot(token, { polling: false });
  for (const chatId of adminIds) {
    // Split kalo kepanjangan
    if (msg.length > 4000) {
      const parts = [];
      let current = '';
      msg.split('\n').forEach(line => {
        if (current.length + line.length > 4000) {
          parts.push(current);
          current = line + '\n';
        } else {
          current += line + '\n';
        }
      });
      if (current) parts.push(current);
      for (const part of parts) {
        await bot.sendMessage(chatId, part, { parse_mode: 'Markdown' });
      }
    } else {
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
  }

  console.log(`Berhasil: ${used.length} voucher terpakai dikirim ke ${adminIds.length} admin.`);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
