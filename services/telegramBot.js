const TelegramBot = require('node-telegram-bot-api');
const { getSetting } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const customerSvc = require('./customerService');
const billingSvc = require('./billingService');
const mikrotikSvc = require('./mikrotikService');
const ipPoolSvc = require('../services/ipPoolService');
const db = require('../config/database');

let bot = null;
const addWizard = {}; // chatId -> wizard state

function initTelegram() {
  const enabled = getSetting('telegram_enabled', false);
  const token = getSetting('telegram_bot_token', '');
  const webhookUrl = (getSetting('telegram_webhook_url', '') || '').replace(/\/+$/, '');

  if (!enabled || !token) {
    if (bot) {
      try { bot.stopPolling(); } catch (e) {}
      bot = null;
      logger.info('Telegram Bot: Dihentikan (Nonaktif)');
    }
    return;
  }

  // Jika token berubah, kita harus stop bot lama dan buat baru
  if (bot && bot.token !== token) {
    try { bot.stopPolling(); } catch (e) {}
    bot = null;
    logger.info('Telegram Bot: Token berubah, me-restart bot...');
  }

  if (bot) {
    logger.info('Telegram Bot: Sudah berjalan, melewati inisialisasi.');
    return;
  }

  // Webhook mode (preferred — kebal EHOSTUNREACH/Starlink flap)
  if (webhookUrl) {
    bot = new TelegramBot(token, { webHook: false }); // no built-in webhook server; kita terima manual
    bot.getMe().then(me => {
      logger.info(`Telegram Bot: Terhubung sebagai @${me.username} (webhook: ${webhookUrl})`);
    }).catch(e => logger.error('Telegram Bot Error (getMe):', e.message));
    // Daftarkan URL webhook ke Telegram (best-effort, sekali saat init)
    bot.setWebHook(`${webhookUrl}/api/telegram-webhook/${token}`).then(r => {
      logger.info(`Telegram Bot: setWebHook result = ${JSON.stringify(r)}`);
    }).catch(e => logger.error('Telegram Bot setWebHook error:', e.message));
    // Lanjut mount handlers di bawah (jangan return di sini)
  } else {
    // Polling mode (fallback)
    bot = new TelegramBot(token, { polling: true });
    bot.getMe().then(me => {
      logger.info(`Telegram Bot: Terhubung sebagai @${me.username} (polling)`);
    }).catch(e => logger.error('Telegram Bot Error (getMe):', e.message));
  }

  // Middleware Admin Check (Fetch latest ID every time)
  const isAdmin = (msg) => {
    const currentAdminId = getSetting('telegram_admin_id', '').toString();
    return msg.from.id.toString() === currentAdminId;
  };

  // Helper Mikhmon Parser
  const parseMikhmon = (script) => {
    if (!script) return null;
    // Format: :put (",rem,ID,VALIDITY,PRICE,MODE,")
    const match = script.match(/",rem,.*?,(.*?),(.*?),.*?"/);
    if (match) {
      return {
        validity: match[1],
        price: match[2]
      };
    }
    return null;
  };

  // Main Menu (Inline Keyboard for better visibility)
  const mainMenu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📊 Statistik', callback_data: 'menu_stats' }, { text: '👥 Pelanggan', callback_data: 'menu_cust' }],
        [{ text: '🎫 Voucher', callback_data: 'menu_vouch' }, { text: '💰 Tagihan', callback_data: 'menu_bill' }],
        [{ text: '⚙️ MikroTik Status', callback_data: 'menu_mt' }],
        [{ text: '🔄 Refresh', callback_data: 'menu_main' }]
      ]
    }
  };

  bot.onText(/\/start|\/menu/i, (msg) => {
    if (!isAdmin(msg)) return bot.sendMessage(msg.chat.id, `Maaf, Anda tidak memiliki akses admin.\nChat ID Anda: ${msg.from.id}`);
    bot.sendMessage(msg.chat.id, '🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', { parse_mode: 'Markdown', ...mainMenu });
  });

  bot.on('message', async (msg) => {
    if (!isAdmin(msg)) return;
    const text = (msg.text || '').trim();
    const chatId = msg.chat.id;
    if (!text || text.startsWith('/')) return; // Commands handled by onText

    // ─── WIZARD HANDLER ─────────────────────────────────────────
    const wiz = addWizard[chatId];
    if (!wiz) return;

    try {
      if (wiz.step === 1) {
        // Nama
        wiz.data.name = text;
        wiz.step = 2;
        bot.sendMessage(chatId, `✅ Nama: *${text}*\n\n*Step 2/5* — Ketik *No. WA* pelanggan (08xx):`, { parse_mode: 'Markdown' });
      } else if (wiz.step === 2) {
        // WA number
        let phone = text.replace(/[+\-.\s]/g, '').replace(/[^0-9]/g, '');
        if (phone.length < 10) return bot.sendMessage(chatId, '⚠️ Nomor WA minimal 10 digit. Coba lagi:');
        if (phone.startsWith('0')) phone = '62' + phone.slice(1);
        else if (!phone.startsWith('62')) phone = '62' + phone;
        wiz.data.phone = phone;
        wiz.step = 3;
        // Show packages
        const packages = customerSvc.getAllPackages();
        let pkgText = `✅ WA: *${phone}*\n\n*Step 3/5* — Pilih *Paket*:\n\n`;
        packages.forEach((p, i) => { pkgText += `${i + 1}. ${p.name} — Rp ${Number(p.price).toLocaleString('id-ID')}\n`; });
        pkgText += `\nKetik *nomor* paket:`;
        bot.sendMessage(chatId, pkgText, { parse_mode: 'Markdown' });
      } else if (wiz.step === 3) {
        // Package selection
        const packages = customerSvc.getAllPackages();
        const idx = parseInt(text) - 1;
        if (isNaN(idx) || idx < 0 || idx >= packages.length) return bot.sendMessage(chatId, `⚠️ Pilih 1-${packages.length}:`);
        wiz.data.package_id = packages[idx].id;
        wiz.data.package_name = packages[idx].name;
        wiz.step = 4;
        bot.sendMessage(chatId, `✅ Paket: *${packages[idx].name}*\n\n*Step 4/5* — Ketik *PPPoE Username*:`, { parse_mode: 'Markdown' });
      } else if (wiz.step === 4) {
        // PPPoE username
        const username = text.replace(/\s/g, '').toLowerCase();
        if (!username) return bot.sendMessage(chatId, '⚠️ Username tidak boleh kosong:');
        wiz.data.pppoe_username = username;
        wiz.step = 5;
        // Show routers
        const routers = mikrotikSvc.getAllRouters();
        if (routers.length <= 1) {
          // Auto-skip router selection
          wiz.data.router_id = routers.length === 1 ? routers[0].id : null;
          wiz.step = 6;
          await finishAddWizard(chatId);
        } else {
          let rText = `✅ PPPoE: *${username}*\n\n*Step 5/5* — Pilih *Router*:\n\n`;
          routers.forEach((r, i) => { rText += `${i + 1}. ${r.name} (${r.host})\n`; });
          rText += `\nKetik *nomor* router (atau \`skip\` untuk default):`;
          bot.sendMessage(chatId, rText, { parse_mode: 'Markdown' });
        }
      } else if (wiz.step === 5) {
        // Router selection
        const routers = mikrotikSvc.getAllRouters();
        if (text.toLowerCase() === 'skip' || text === '0') {
          wiz.data.router_id = null;
        } else {
          const idx = parseInt(text) - 1;
          if (isNaN(idx) || idx < 0 || idx >= routers.length) return bot.sendMessage(chatId, `⚠️ Pilih 1-${routers.length} atau ketik \`skip\`:`);
          wiz.data.router_id = routers[idx].id;
        }
        wiz.step = 6;
        await finishAddWizard(chatId);
      }
    } catch (e) {
      bot.sendMessage(chatId, `❌ Error: ${e.message}`);
      delete addWizard[chatId];
    }
  });

  async function finishAddWizard(chatId) {
    const wiz = addWizard[chatId];
    if (!wiz) return;
    const d = wiz.data;
    delete addWizard[chatId];

    bot.sendMessage(chatId, '⏳ Membuat pelanggan & PPPoE di MikroTik...');

    try {
      const routerId = d.router_id || null;

      // Check duplicate username in DB
      const existing = db.prepare('SELECT id, name FROM customers WHERE pppoe_username = ? LIMIT 1').get(d.pppoe_username);
      if (existing) throw new Error(`Username "${d.pppoe_username}" sudah dipakai: ${existing.name}`);

      // Get MikroTik secrets + find available IP
      const secrets = await mikrotikSvc.getPppoeSecrets(routerId);
      const existsInMt = secrets.find(s => s.name === d.pppoe_username);

      let allocatedIp = null;
      if (!existsInMt) {
        const nextIp = ipPoolSvc.getNextAvailableIp(secrets, 1);
        if (!nextIp) throw new Error('Pool IP habis!');

        const pool = db.prepare('SELECT gateway FROM ip_pools WHERE id = 1').get();
        const localIp = pool ? pool.gateway : '192.168.55.1';

        await mikrotikSvc.addPppoeSecret({
          name: d.pppoe_username,
          password: 'rumah',
          service: 'pppoe',
          profile: d.package_name || 'ISOLIR-1-SEGMEN',
          'local-address': localIp,
          'remote-address': nextIp
        }, routerId);
        allocatedIp = nextIp;
      } else {
        allocatedIp = existsInMt['remote-address'] || existsInMt.remoteAddress || null;
      }

      // Create customer in DB
      const todayStr = new Date().toISOString().split('T')[0];
      const todayDay = new Date().getDate();
      const result = customerSvc.createCustomer({
        name: d.name,
        phone: d.phone,
        package_id: d.package_id,
        pppoe_username: d.pppoe_username,
        router_id: routerId,
        status: 'active',
        install_date: todayStr,
        isolate_day: todayDay,
        isolir_profile: 'ISOLIR-1-SEGMEN',
        ip_address: allocatedIp,
        connection_type: 'pppoe'
      });

      // Track IP allocation
      if (allocatedIp && result && result.lastInsertRowid) {
        try { ipPoolSvc.allocateIp(result.lastInsertRowid, allocatedIp, 1); } catch (e) {}
      }

      let msg = `✅ *PELANGGAN BERHASIL DITAMBAHKAN*\n\n`;
      msg += `👤 Nama: *${d.name}*\n`;
      msg += `📞 WA: ${d.phone}\n`;
      msg += `📦 Paket: ${d.package_name}\n`;
      msg += `🔑 PPPoE: \`${d.pppoe_username}\`\n`;
      msg += `🌐 IP: \`${allocatedIp || '-'}\`\n`;
      msg += `🔒 Password: \`rumah\`\n`;
      msg += `📅 Install: ${todayStr}\n`;
      msg += `🛡️ Profile Isolir: ISOLIR-1-SEGMEN\n`;
      msg += `📆 Tgl Isolir: ${todayDay}\n`;
      msg += existsInMt ? `\n⚠️ Secret sudah ada di MikroTik, IP diambil dari sana.` : `\n✅ PPPoE secret berhasil dibuat di MikroTik.`;

      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Gagal: ${e.message}`);
    }
  }

  // Callback Query Handling
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    if (!isAdmin(query)) return bot.answerCallbackQuery(query.id, { text: 'Akses Ditolak' });

    if (data === 'menu_main') {
      bot.editMessageText('🏠 *PANEL ADMIN RTRW-NET*\nSilakan pilih menu di bawah ini:', {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        ...mainMenu
      });
    }

    else if (data === 'menu_stats') {
      const stats = customerSvc.getCustomerStats();
      const billing = billingSvc.getDashboardStats();
      let res = `*📊 STATISTIK SISTEM*\n\n`;
      res += `👥 Pelanggan: ${stats.total}\n`;
      res += `✅ Aktif: ${stats.active}\n`;
      res += `🚫 Terisolir: ${stats.suspended}\n\n`;
      res += `💰 Pendapatan Bulan Ini: Rp ${billing.thisMonth.toLocaleString('id-ID')}\n`;
      res += `⏳ Belum Dibayar: ${billing.unpaidCount} Tagihan`;
      
      bot.sendMessage(chatId, res, { 
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_main' }]] }
      });
    }

    else if (data === 'menu_cust') {
      bot.sendMessage(chatId, '👥 *MANAJEMEN PELANGGAN*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Tambah Pelanggan', callback_data: 'cust_add' }],
            [{ text: '📋 List Pelanggan', callback_data: 'cust_list' }],
            [{ text: '🔍 Cari Pelanggan', callback_data: 'cust_search' }],
            [{ text: '🚫 Daftar Terisolir', callback_data: 'cust_suspended' }],
            [{ text: '📡 List ONU (GenieACS)', callback_data: 'cust_listonu' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }
    else if (data === 'cust_chgpkg' || data === 'cust_list' || data.startsWith('cust_list_')) {
      const page = data.startsWith('cust_list_') ? parseInt(data.replace('cust_list_', '')) || 0 : 0;
      const pageSize = 25;
      const allCustomers = customerSvc.getAllCustomers().filter(c => c.status === 'active' && c.pppoe_username);
      if (allCustomers.length === 0) return bot.sendMessage(chatId, '📭 Tidak ada pelanggan aktif.');
      
      const totalPages = Math.ceil(allCustomers.length / pageSize);
      const customers = allCustomers.slice(page * pageSize, (page + 1) * pageSize);
      
      const buttons = customers.map(c => ([{
        text: `${c.name} (${c.package_name || 'no pkg'})`,
        callback_data: `chgpkg_${c.id}`
      }]));
      
      if (page > 0) buttons.push([{ text: '◀️ Prev', callback_data: `cust_list_${page - 1}` }]);
      if (page < totalPages - 1) buttons.push([{ text: '▶️ Next', callback_data: `cust_list_${page + 1}` }]);
      buttons.push([{ text: '⬅️ Kembali', callback_data: 'menu_cust' }]);
      
      bot.sendMessage(chatId, `📋 *LIST PELANGGAN AKTIF* (${allCustomers.length} total)\n_Halaman ${page + 1}/${totalPages}_\n\nPilih pelanggan untuk ubah paket:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      });
    }
    else if (data.startsWith('chgpkg_')) {
      const custId = data.replace('chgpkg_', '');
      const customer = customerSvc.getCustomerById(custId);
      if (!customer) return bot.sendMessage(chatId, '❌ Pelanggan tidak ditemukan.');
      
      const packages = customerSvc.getAllPackages();
      const buttons = packages.map((p, i) => ([{
        text: `${p.name} — Rp ${Number(p.price).toLocaleString('id-ID')}`,
        callback_data: `setpkg_${customer.id}_${p.id}`
      }]));
      buttons.push([{ text: '⬅️ Kembali', callback_data: 'cust_list' }]);
      
      bot.sendMessage(chatId, `📦 *UBAH PAKET*\n\n👤 ${customer.name}\n📦 Paket saat ini: *${customer.package_name || 'Tidak ada'}*\n\nPilih paket baru:`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      });
    }
    else if (data.startsWith('setpkg_')) {
      const [, custId, pkgId] = data.split('_');
      const customer = customerSvc.getCustomerById(custId);
      const newPkg = customerSvc.getPackageById(pkgId);
      if (!customer || !newPkg) return bot.sendMessage(chatId, '❌ Data tidak ditemukan.');
      
      try {
        db.prepare('UPDATE customers SET package_id = ? WHERE id = ?').run(newPkg.id, customer.id);
        await mikrotikSvc.setPppoeProfile(customer.pppoe_username, newPkg.name);
        bot.sendMessage(chatId, 
          `✅ *PAKET BERHASIL DIUBAH*\n\n👤 ${customer.name}\n📦 ${customer.package_name || 'Tidak ada'} → *${newPkg.name}*\n💰 Rp ${Number(newPkg.price).toLocaleString('id-ID')}`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) {
        bot.sendMessage(chatId, '❌ Gagal: ' + e.message);
      }
    }

    else if (data === 'menu_bill') {
      bot.sendMessage(chatId, '💰 *MANAJEMEN TAGIHAN*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⏳ Tagihan Belum Bayar', callback_data: 'bill_unpaid' }],
            [{ text: '📈 Pendapatan Hari Ini', callback_data: 'bill_today' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'menu_vouch') {
      bot.sendMessage(chatId, '🎫 *MENU VOUCHER*\nPilih aksi:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Buat Voucher', callback_data: 'vouch_create' }],
            [{ text: '📝 List Belum Terpakai', callback_data: 'vouch_unused' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'vouch_create') {
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const buttons = [];
        const filtered = profiles.filter(p => parseMikhmon(p.onLogin));

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, '⚠️ Tidak ditemukan paket voucher.\nPastikan profil hotspot memiliki format Mikhmon di on-login script.', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]] }
          });
        }

        filtered.forEach((p, index) => {
          const meta = parseMikhmon(p.onLogin);
          if (index % 2 === 0) buttons.push([]);
          buttons[buttons.length - 1].push({ text: `🎫 ${p.name} (${meta.validity})`, callback_data: `vouch_gen:${p.name}` });
        });
        buttons.push([{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]);

        bot.sendMessage(chatId, '🎫 *BUAT VOUCHER*\nPilih paket untuk generate PIN:', {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (e) {
        bot.sendMessage(chatId, '❌ Error: ' + e.message);
      }
    }

    else if (data === 'vouch_unused') {
      try {
        const allUsers = await mikrotikSvc.getHotspotUsers();
        // Voucher = comment starts with "vc-" + uptime 0s/empty (belum pernah login)
        const unused = allUsers.filter(u => (u.comment || '').startsWith('vc-') && (!u.uptime || u.uptime === '0s'));

        if (unused.length === 0) {
          return bot.sendMessage(chatId, '✅ Semua voucher sudah terpakai!', {
            reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]] }
          });
        }

        // Group by profile
        const grouped = {};
        unused.forEach(v => {
          const p = v.profile || 'default';
          if (!grouped[p]) grouped[p] = [];
          grouped[p].push(v);
        });

        let msg = `📝 *VOUCHER BELUM TERPAKAI* (${unused.length} total)\n\n`;
        for (const [profile, vouchers] of Object.entries(grouped)) {
          msg += `*${profile}* — ${vouchers.length} pcs\n`;
          msg += `\`\`\`\n`;
          vouchers.forEach(v => {
            msg += `${v.name}\n`;
          });
          msg += `\`\`\`\n`;
        }

        bot.sendMessage(chatId, msg, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]] }
        });
      } catch (e) {
        bot.sendMessage(chatId, '❌ Error: ' + e.message);
      }
    }

        else if (data === 'menu_mt') {
      bot.sendMessage(chatId, '⚙️ *STATUS MIKROTIK*\nPilih data:', {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Resource System', callback_data: 'mt_resource' }],
            [{ text: '🟢 User Aktif (PPPoE/HS)', callback_data: 'mt_active' }],
            [{ text: '🔴 User Offline (PPPoE)', callback_data: 'mt_offline' }],
            [{ text: '🔑 List PPPoE Secrets', callback_data: 'mt_pppoe' }],
            [{ text: '⬅️ Kembali', callback_data: 'menu_main' }]
          ]
        }
      });
    }

    else if (data === 'mt_resource') {
      try {
        const res = await mikrotikSvc.getSystemResource();
        let txt = `*⚙️ MIKROTIK STATUS*\n\n`;
        txt += `Model: ${res.boardName || res['board-name'] || '-'}\n`;
        txt += `CPU: ${res.cpuLoad || res['cpu-load'] || '0'}%\n`;
        txt += `Uptime: ${res.uptime}\n`;
        txt += `Version: ${res.version}`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal mengambil data MikroTik: ' + e.message);
      }
    }

    else if (data === 'mt_active') {
      try {
        const pppoe = await mikrotikSvc.getPppoeActive();
        const hs = await mikrotikSvc.getHotspotActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        
        let txt = `*🟢 USER AKTIF*\n\n`;
        txt += `🌐 *PPPoE (${pppoe.length}):*\n`;
        pppoe.slice(0, 15).forEach(a => {
          const s = scripts.find(sc => sc.name === a.name);
          const failCount = s ? (s.source || '0') : '0';
          txt += `• \`${a.name}\` (${a.address}) [⚡${failCount}]\n`;
        });
        
        txt += `\n📶 *Hotspot (${hs.length}):*\n`;
        hs.slice(0, 5).forEach(h => {
          txt += `• \`${h.user}\` (${h.address})\n`;
        });
        
        txt += `\n_⚡ = Jumlah Gangguan Terdeteksi_`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_offline') {
      try {
        const secrets = await mikrotikSvc.getPppoeSecrets();
        const active = await mikrotikSvc.getPppoeActive();
        const scripts = await mikrotikSvc.getSystemScripts();
        const activeNames = active.map(a => a.name);
        
        const offline = secrets.filter(s => !activeNames.includes(s.name) && s.disabled === false);
        
        let txt = `*🔴 USER PPPoE OFFLINE*\n`;
        txt += `============================\n`;
        txt += `📅 *${new Date().toLocaleString('id-ID')}*\n`;
        txt += `============================\n\n`;
        
        txt += `📋 *RINGKASAN:*\n`;
        txt += `• Total Secret: ${secrets.length}\n`;
        txt += `• Total Aktif: ${active.length}\n`;
        txt += `• *Terputus: ${offline.length}*\n\n`;
        
        txt += `👤 *DAFTAR USER OFFLINE:*\n`;
        if (offline.length === 0) {
          txt += `✅ Semua user online.\n`;
        } else {
          offline.slice(0, 25).forEach(s => {
            const sc = scripts.find(scr => scr.name === s.name);
            const failCount = sc ? (sc.source || '0') : '0';
            txt += `• \`${s.name}\` [⚡${failCount}x]\n`;
          });
          if (offline.length > 25) txt += `\n_...dan ${offline.length - 25} lainnya._\n`;
        }
        
        txt += `\n============================\n`;
        txt += `_Powered by Admin Portal_`;
        
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'mt_pppoe') {
      try {
        const secrets = await mikrotikSvc.getPppoeSecrets();
        let txt = `*🔑 PPPoE SECRETS (${secrets.length})*\n\n`;
        secrets.slice(0, 20).forEach(s => {
          txt += `• \`${s.name}\` (${s.profile})\n`;
        });
        if (secrets.length > 20) txt += `\n_Menampilkan 20 dari ${secrets.length}..._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'cust_search') {
      bot.sendMessage(chatId, '🔍 *CARI PELANGGAN*\nKetik perintah `/cari [nama/wa]`\n\nContoh: `/cari budi` atau `/cari 0812`', { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_add') {
      startAddWizard(chatId);
      bot.answerCallbackQuery(query.id);
    }

    else if (data === 'cust_listonu') {
      const customerDevice = require('./customerDeviceService');
      let res = await customerDevice.listDevicesWithTags(30);
      
      // Jika kosong, coba ambil semua perangkat
      if (!res.ok || res.devices.length === 0) {
        res = await customerDevice.listAllDevices(30);
      }

      if (!res.ok || res.devices.length === 0) {
        return bot.sendMessage(chatId, '📭 Tidak ada perangkat ONU yang terdeteksi di GenieACS.');
      }

      let txt = `*📡 DAFTAR ONU (GenieACS)*\n\n`;
      res.devices.forEach(d => {
        const id = d._id || 'Unknown ID';
        const tags = Array.isArray(d._tags) ? d._tags.join(', ') : (d._tags || '-');
        txt += `• \`${id}\`\n  └ Tag: ${tags}\n`;
      });
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'cust_suspended') {
      const customers = customerSvc.getAllCustomers().filter(c => c.status === 'suspended');
      if (customers.length === 0) return bot.sendMessage(chatId, '✅ Tidak ada pelanggan yang terisolir.');
      let txt = `*🚫 PELANGGAN TERISOLIR (${customers.length})*\n\n`;
      customers.slice(0, 15).forEach(c => {
        txt += `• *${c.name}* (${c.phone})\n`;
      });
      if (customers.length > 15) txt += `\n_...dan ${customers.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_unpaid') {
      const invoices = billingSvc.getAllInvoices().filter(i => i.status === 'unpaid');
      if (invoices.length === 0) return bot.sendMessage(chatId, '✅ Semua tagihan sudah lunas!');
      let txt = `*⏳ TAGIHAN BELUM BAYAR (${invoices.length})*\n\n`;
      invoices.slice(0, 15).forEach(i => {
        const c = customerSvc.getCustomerById(i.customer_id);
        txt += `• ${c ? c.name : 'Unknown'} - Rp ${i.amount.toLocaleString('id-ID')}\n`;
      });
      if (invoices.length > 15) txt += `\n_...dan ${invoices.length - 15} lainnya._`;
      bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
    }

    else if (data === 'bill_today') {
      try {
        const stats = billingSvc.getTodayRevenue();
        const total = stats.total || 0;
        const count = stats.count || 0;
        
        let txt = `*📈 PENDAPATAN HARI INI*\n\n`;
        txt += `💰 Total: *Rp ${total.toLocaleString('id-ID')}*\n`;
        txt += `🧾 Jumlah: ${count} Transaksi\n\n`;
        txt += `_Data berdasarkan pembayaran yang diverifikasi hari ini (Waktu Lokal)._`;
        bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }

    else if (data === 'vouch_profiles') {
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const buttons = [];
        
        // Filter profiles that have Mikhmon Price
        const filtered = profiles.filter(p => parseMikhmon(p.onLogin));

        if (filtered.length === 0) {
          return bot.sendMessage(chatId, '⚠️ Tidak ditemukan paket yang memiliki harga jual (Format Mikhmon).');
        }

        filtered.forEach((p, index) => {
          const meta = parseMikhmon(p.onLogin);
          if (index % 2 === 0) buttons.push([]);
          buttons[buttons.length - 1].push({ text: `🎫 ${p.name} (Rp ${meta.price})`, callback_data: `vouch_gen:${p.name}` });
        });
        buttons.push([{ text: '⬅️ Kembali', callback_data: 'menu_vouch' }]);
        
        bot.sendMessage(chatId, '*📜 PILIH PAKET VOUCHER*\nSilakan klik paket untuk langsung membuat PIN:', { 
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: buttons }
        });
      } catch (e) {
        bot.sendMessage(chatId, 'Error: ' + e.message);
      }
    }
    
    else if (data.startsWith('vouch_gen:')) {
      const profileName = data.split(':')[1];
      try {
        const profiles = await mikrotikSvc.getHotspotUserProfiles();
        const profile = profiles.find(p => p.name === profileName);
        if (!profile) throw new Error('Profil tidak ditemukan');

        const meta = parseMikhmon(profile.onLogin);
        if (!meta) throw new Error('Data harga/durasi profil tidak ditemukan (Format Mikhmon)');

        const pin = Math.floor(1000 + Math.random() * 9000).toString();

        // Hitung expiry date untuk Mikhmon Expire-Monitor
        const now = new Date();
        const validityMs = (() => {
          if (!meta.validity) return 0;
          const s = String(meta.validity).toLowerCase();
          let totalMin = 0;
          const re = /(\d+)\s*([wdhm])/g;
          let m;
          while ((m = re.exec(s)) !== null) {
            const n = parseInt(m[1], 10);
            if (m[2] === 'm') totalMin += n;
            else if (m[2] === 'h') totalMin += n * 60;
            else if (m[2] === 'd') totalMin += n * 60 * 24;
            else if (m[2] === 'w') totalMin += n * 60 * 24 * 7;
          }
          return totalMin * 60 * 1000;
        })();
        let expStr = '';
        if (meta.validity) {
          const expiresAt = new Date(now.getTime() + validityMs);
          const pad = (n) => String(n).padStart(2, '0');
          expStr = `${expiresAt.getFullYear()}-${pad(expiresAt.getMonth()+1)}-${pad(expiresAt.getDate())} ${pad(expiresAt.getHours())}:${pad(expiresAt.getMinutes())}:${pad(expiresAt.getSeconds())}`;
        }

        const voucherData = {
          server: 'all',
          name: pin,
          password: pin,
          profile: profileName,
          comment: `${expStr} vc-${pin}-${profileName}`.trim()
        };
        if (meta.validity) voucherData['limit-uptime'] = meta.validity;

        await mikrotikSvc.addHotspotUser(voucherData);
        
        let res = `*🎫 VOUCHER BERHASIL (INSTAN)*\n\n`;
        res += `🎫 KODE VOUCHER: \`${pin}\`\n`;
        res += `💰 Harga: Rp ${meta.price}\n`;
        res += `⏳ Durasi: ${meta.validity}\n`;
        res += `📦 Paket: ${profileName}\n`;
        res += `\n_Silakan masukkan kode di atas pada halaman login hotspot._`;
        
        bot.sendMessage(chatId, res, { parse_mode: 'Markdown' });
      } catch (e) {
        bot.sendMessage(chatId, 'Gagal: ' + e.message);
      }
    }
    
    bot.answerCallbackQuery(query.id);
  });

  // Custom Commands
  bot.onText(/\/vouch (\S+) (\S+) (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const [_, profile, limit, comment] = match;
    try {
      const pin = Math.floor(1000 + Math.random() * 9000).toString();
      await mikrotikSvc.addHotspotUser({
        server: 'all', name: pin, password: pin, profile, 'limit-uptime': limit, comment
      });
      bot.sendMessage(msg.chat.id, `*🎫 VOUCHER BERHASIL*\n\n🎫 KODE VOUCHER: \`${pin}\`\n📦 Paket: ${profile}\n⏳ Limit: ${limit}`, { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/kick (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const user = match[1];
      await mikrotikSvc.kickPppoeUser(user);
      await mikrotikSvc.kickHotspotUser(user);
      bot.sendMessage(msg.chat.id, `✅ Session *${user}* berhasil diputus.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/editpppoe (\S+) (\S+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const [_, user, profile] = match;
      await mikrotikSvc.setPppoeProfile(user, profile);
      bot.sendMessage(msg.chat.id, `✅ Profile *${user}* diubah ke *${profile}*.`);
    } catch (e) {
      bot.sendMessage(msg.chat.id, 'Gagal: ' + e.message);
    }
  });

  bot.onText(/\/ubhpaket (\S+)(?:\s+(\d+))?/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    try {
      const [_, username, paketIdx] = match;
      
      // Find customer by pppoe_username
      const customer = db.prepare('SELECT * FROM customers WHERE pppoe_username = ?').get(username);
      if (!customer) return bot.sendMessage(msg.chat.id, `❌ Username *${username}* tidak ditemukan.`);
      
      // Get all packages
      const packages = customerSvc.getAllPackages();
      
      // If no package index provided, show package list
      if (!paketIdx) {
        let pkgText = `*📦 UBAH PAKET - ${customer.name}*\n\nPaket saat ini: *${customer.package_name || 'Tidak ada'}*\n\nPilih paket baru:\n\n`;
        packages.forEach((p, i) => {
          pkgText += `${i + 1}. ${p.name} — Rp ${Number(p.price).toLocaleString('id-ID')}\n`;
        });
        pkgText += `\nKetik: /ubhpaket ${username} <nomor>`;
        return bot.sendMessage(msg.chat.id, pkgText, { parse_mode: 'Markdown' });
      }
      
      // Validate package selection
      const idx = parseInt(paketIdx) - 1;
      if (isNaN(idx) || idx < 0 || idx >= packages.length) {
        return bot.sendMessage(msg.chat.id, `⚠️ Nomor paket tidak valid. Pilih 1-${packages.length}`);
      }
      
      const newPkg = packages[idx];
      
      // Update customer in DB
      db.prepare('UPDATE customers SET package_id = ? WHERE id = ?').run(newPkg.id, customer.id);
      
      // Update MikroTik profile
      await mikrotikSvc.setPppoeProfile(username, newPkg.name);
      
      bot.sendMessage(msg.chat.id, 
        `✅ *PAKET BERHASIL DIUBAH*\n\n👤 ${customer.name}\n📦 ${customer.package_name || 'Tidak ada'} → *${newPkg.name}*\n💰 Rp ${Number(newPkg.price).toLocaleString('id-ID')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(msg.chat.id, '❌ Gagal: ' + e.message);
    }
  });

  bot.onText(/\/cari (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) return;
    const query = match[1].toLowerCase();
    const customers = customerSvc.getAllCustomers().filter(c => 
      c.name.toLowerCase().includes(query) || c.phone.includes(query)
    );
    
    if (customers.length === 0) return bot.sendMessage(msg.chat.id, `❌ Pelanggan dengan keyword "${query}" tidak ditemukan.`);
    
    let res = `*🔍 HASIL PENCARIAN (${customers.length})*\n\n`;
    customers.slice(0, 10).forEach(c => {
      res += `👤 *${c.name}*\n📞 ${c.phone}\n🚦 Status: ${c.status === 'active' ? '✅ Aktif' : '🚫 Terisolir'}\n\n`;
    });
    if (customers.length > 10) res += `_...dan ${customers.length - 10} lainnya._`;
    bot.sendMessage(msg.chat.id, res, { parse_mode: 'Markdown' });
  });

  // ─── TAMBAH PELANGGAN WIZARD ─────────────────────────────────────────
  bot.onText(/\/tambah/i, (msg) => {
    if (!isAdmin(msg)) return;
    startAddWizard(msg.chat.id);
  });

  function startAddWizard(chatId) {
    addWizard[chatId] = { step: 1, data: {} };
    bot.sendMessage(chatId, '➕ *TAMBAH PELANGGAN BARU*\n\nPPPoE + IP otomatis dibuat di MikroTik.\n\n*Step 1/5* — Ketik *Nama* pelanggan:', { parse_mode: 'Markdown' });
  }

  // Handle cust_add callback
  // (inserted into callback_query handler below)


}

// Export for manual re-init from settings
module.exports = { initTelegram, getBot: () => bot };
