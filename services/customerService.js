/**
 * Service: CRUD Pelanggan & Paket
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

// ─── CUSTOMERS ───────────────────────────────────────────────
function getAllCustomers(search = '', sort = 'name', dir = 'asc') {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const allowedCols = { name: 'c.name', id: 'c.id', phone: 'c.phone', package_name: 'p.name', address: 'c.address', status: 'c.status', install_date: 'c.install_date', unpaid_count: 'unpaid_count', customer_code: 'c.customer_code', isolate_day: 'c.isolate_day' };
  const col = allowedCols[sort] || allowedCols.name;
  const direction = (dir === 'desc') ? 'DESC' : 'ASC';

  const base = `
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           p.speed_down, p.speed_up, p.fup_limit_gb, p.use_fup,
           r.name as router_name,
           o.name as olt_name,
           odp.name as odp_name,
           (SELECT COUNT(*) FROM invoices WHERE customer_id=c.id AND status='unpaid') as unpaid_count,
           u.bytes_in, u.bytes_out
    FROM customers c
    LEFT JOIN packages p ON c.package_id = p.id
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    LEFT JOIN customer_usage u ON u.customer_id = c.id AND u.period_month = ${month} AND u.period_year = ${year}
  `;
  const order = ` ORDER BY ${col} ${direction}`;
  if (search) {
    const s = `%${search}%`;
    return db.prepare(base + ` WHERE c.name LIKE ? OR c.phone LIKE ? OR c.genieacs_tag LIKE ? OR c.address LIKE ?` + order).all(s, s, s, s);
  }
  return db.prepare(base + order).all();
}

function resetPromoCyclesUsed(customerId) {
  const id = Number(customerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('ID pelanggan tidak valid');
  return db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
}

function getCustomerById(id) {
  return db.prepare(`
    SELECT c.*, p.name as package_name, p.price as package_price,
           p.promo_cycles as package_promo_cycles,
           p.prorate_first_invoice as package_prorate_first_invoice,
           r.name as router_name, o.name as olt_name, odp.name as odp_name
    FROM customers c 
    LEFT JOIN packages p ON c.package_id = p.id 
    LEFT JOIN routers r ON c.router_id = r.id
    LEFT JOIN olts o ON c.olt_id = o.id
    LEFT JOIN odps odp ON c.odp_id = odp.id
    WHERE c.id = ?
  `).get(id);
}

function normalizePhone(input) {
  if (!input) return '';
  const digits = String(input).replace(/\D/g, '');
  if (digits.length < 8) return '';
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('62')) return digits;
  if (digits.startsWith('60')) return digits; // Malaysia
  if (digits.startsWith('65')) return digits; // Singapore
  if (digits.startsWith('8') && digits.length >= 10 && digits.length <= 12) return '62' + digits;
  return digits;
}

function formatPhone(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return '-';
  
  // Pengecualian untuk nomor Malaysia (dimulai dengan 60)
  if (normalized.startsWith('60')) {
    const parts = [];
    let i = 0;
    while (i < normalized.length) {
      parts.push(normalized.slice(i, i + 3));
      i += 3;
    }
    return parts.join(' ');
  }

  // Format standar Indonesia: 62 822 349 24646
  const without62 = normalized.startsWith('62') ? normalized.slice(2) : normalized;
  const parts = [];
  let i = 0;
  while (i < without62.length) {
    parts.push(without62.slice(i, i + 3));
    i += 3;
  }
  return '62 ' + parts.join(' ');
}

function generateCustomerCode() {
  let code;
  let exists;
  do {
    code = Math.floor(10000 + Math.random() * 90000).toString();
    exists = db.prepare('SELECT 1 FROM customers WHERE customer_code = ?').get(code);
  } while (exists);
  return code;
}

function createCustomer(data) {
  const phone = normalizePhone(data.phone);
  const customerCode = data.customer_code || generateCustomerCode();
  return db.prepare(`
    INSERT INTO customers (name, phone, email, address, package_id, router_id, olt_id, odp_id, pon_port, lat, lng, genieacs_tag, pppoe_username, isolir_profile, status, install_date, notes, auto_isolate, isolate_day, connection_type, static_ip, mac_address, customer_code, ip_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, phone, data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '', 
    data.isolir_profile || 'ISOLIR-1-SEGMEN',
    data.status || 'active',
    data.install_date || new Date().toISOString().split('T')[0], data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : (data.install_date ? new Date(data.install_date).getDate() : 1),
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    customerCode,
    data.ip_address || null
  );
}

function updateCustomer(id, data) {
  const prev = db.prepare('SELECT package_id FROM customers WHERE id=?').get(id);
  const newPkgId = data.package_id ? parseInt(data.package_id, 10) : null;
  const pkgChanged = prev && Number(prev.package_id || 0) !== Number(newPkgId || 0);

  const result = db.prepare(`
    UPDATE customers SET name=?, phone=?, email=?, address=?, package_id=?, router_id=?, olt_id=?, odp_id=?, pon_port=?, lat=?, lng=?, genieacs_tag=?, pppoe_username=?, isolir_profile=?, status=?, install_date=?, notes=?, auto_isolate=?, isolate_day=?, cable_path=?, connection_type=?, static_ip=?, mac_address=?, customer_code=?
    WHERE id=?
  `).run(
    data.name, data.phone || '', data.email || '', data.address || '',
    data.package_id ? parseInt(data.package_id) : null,
    data.router_id ? parseInt(data.router_id) : null,
    data.olt_id ? parseInt(data.olt_id) : null,
    data.odp_id ? parseInt(data.odp_id) : null,
    data.pon_port || '',
    data.lat || '',
    data.lng || '',
    data.genieacs_tag || '', data.pppoe_username || '', 
    data.isolir_profile || 'ISOLIR-1-SEGMEN',
    data.status || 'active',
    data.install_date || null, data.notes || '',
    data.auto_isolate !== undefined ? parseInt(data.auto_isolate) : 1,
    data.isolate_day !== undefined ? parseInt(data.isolate_day) : (data.install_date ? new Date(data.install_date).getDate() : 1),
    data.cable_path || null,
    data.connection_type || 'pppoe',
    data.static_ip || '',
    data.mac_address || '',
    data.customer_code || '',
    id
  );

  if (pkgChanged) {
    db.prepare('UPDATE customers SET promo_cycles_used = 0 WHERE id=?').run(id);
  }

  return result;
}

function updateCustomerCablePath(id, path) {
  return db.prepare('UPDATE customers SET cable_path = ? WHERE id = ?').run(path, id);
}

async function deleteCustomer(id) {
  const customer = getCustomerById(id);
  if (customer && customer.connection_type === 'static' && customer.static_ip) {
    const mikrotikSvc = require('./mikrotikService');
    try {
      await mikrotikSvc.removeStaticIp(customer.static_ip, customer.router_id);
    } catch (e) {
      console.error('Failed to remove static IP from MikroTik during customer deletion:', e);
    }
  }
  return db.prepare('DELETE FROM customers WHERE id=?').run(id);
}

function getCustomerStats() {
  return {
    total:     db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    active:    db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='active'").get().c,
    suspended: db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='suspended'").get().c,
    inactive:  db.prepare("SELECT COUNT(*) as c FROM customers WHERE status='inactive'").get().c,
  };
}

// ─── PACKAGES ────────────────────────────────────────────────
function getAllPackages() {
  return db.prepare(`
    SELECT p.*, COUNT(c.id) as customer_count
    FROM packages p LEFT JOIN customers c ON c.package_id = p.id
    GROUP BY p.id ORDER BY p.price ASC
  `).all();
}

function getPackageById(id) {
  return db.prepare('SELECT * FROM packages WHERE id=?').get(id);
}

function createPackage(data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);

  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;

  return db.prepare(`
    INSERT INTO packages (
      name, price, promo_price, promo_cycles, prorate_first_invoice,
      speed_down, speed_up, 
      use_night_speed, night_profile_name, night_speed_down, night_speed_up, 
      use_fup, fup_profile_name, fup_limit_gb, fup_speed_down, 
      description
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || ''
  );
}

function parsePromoPrice(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function updatePackage(id, data) {
  const down = Math.round(parseFloat(data.speed_down || 0) * 1000);
  const up = Math.round(parseFloat(data.speed_up || 0) * 1000);
  const n_down = Math.round(parseFloat(data.night_speed_down || 0) * 1000);
  const n_up = Math.round(parseFloat(data.night_speed_up || 0) * 1000);
  const f_down = Math.round(parseFloat(data.fup_speed_down || 0) * 1000);
  const f_limit = parseFloat(data.fup_limit_gb || 0);
  const promoPrice = parsePromoPrice(data.promo_price);
  const promoCycles = Math.max(0, parseInt(data.promo_cycles, 10) || 0);
  const prorateFirst = data.prorate_first_invoice ? 1 : 0;

  return db.prepare(`
    UPDATE packages 
    SET name=?, price=?, promo_price=?, promo_cycles=?, prorate_first_invoice=?,
        speed_down=?, speed_up=?, 
        use_night_speed=?, night_profile_name=?, night_speed_down=?, night_speed_up=?, 
        use_fup=?, fup_profile_name=?, fup_limit_gb=?, fup_speed_down=?, 
        description=?, is_active=? 
    WHERE id=?
  `).run(
    data.name, parseInt(data.price) || 0, promoPrice, promoCycles, prorateFirst,
    down, up,
    data.use_night_speed ? 1 : 0, data.night_profile_name || null, n_down, n_up,
    data.use_fup ? 1 : 0, data.fup_profile_name || null, f_limit, f_down,
    data.description || '', data.is_active == '1' ? 1 : 0, id
  );
}

function deletePackage(id) {
  return db.prepare('DELETE FROM packages WHERE id=?').run(id);
}

function findCustomerByAny(val) {
  if (!val) return null;
  const cleanVal = val.toString().trim();
  
  // 1. Try Phone (Priority for Login)
  const phoneDigits = cleanVal.replace(/\D/g, '');
  if (phoneDigits.length >= 8) {
    // Cari yang 8-10 digit terakhirnya sama (lebih akurat untuk 08 vs 62)
    const suffix = phoneDigits.slice(-9);
    const p1 = db.prepare('SELECT id FROM customers WHERE phone LIKE ?').get(`%${suffix}`);
    if (p1) return getCustomerById(p1.id);
  }

  // 2. Try Customer Code (5 digit ID login)
  if (/^\d{5}$/.test(cleanVal)) {
    const c = db.prepare('SELECT id FROM customers WHERE customer_code = ?').get(cleanVal);
    if (c) return getCustomerById(c.id);
  }

  // 3. Try GenieACS Tag atau PPPoE Username (Exact Match)
  const t = db.prepare('SELECT id FROM customers WHERE genieacs_tag = ? OR pppoe_username = ?').get(cleanVal, cleanVal);
  if (t) return getCustomerById(t.id);

  // 4. Try ID if numeric
  if (/^\d+$/.test(cleanVal) && cleanVal.length < 8) {
    const c = getCustomerById(parseInt(cleanVal));
    if (c) return c;
  }
  
  return null;
}

async function suspendCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'suspended' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: true
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const isolirProfile = customer.isolir_profile || 'ISOLIR-1-SEGMEN';
    await mikrotikSvc.setPppoeProfile(customer.pppoe_username, isolirProfile, customer.router_id);
  }

  // Tambahkan IP ke address-list ISOLIR-1-SEGMEN agar firewall forward drop traffic.
  // Berlaku untuk semua tipe (PPPoE, static, hotspot) selama customer punya IP.
  const isolirIp = customer.static_ip || customer.ip_address;
  if (isolirIp) {
    try {
      await mikrotikSvc.addIsolirAddressList(isolirIp, customer.name, customer.router_id);
    } catch (e) {
      logger.warn(`[Customer] Gagal add address-list untuk ${customer.name} (${isolirIp}): ${e.message}`);
    }
  }
  return true;
}

async function activateCustomer(id) {
  const customer = getCustomerById(id);
  if (!customer) throw new Error('Pelanggan tidak ditemukan');
  
  updateCustomer(id, { ...customer, status: 'active' });
  const mikrotikSvc = require('./mikrotikService');

  if (customer.connection_type === 'static' && customer.static_ip) {
    const pkg = getPackageById(customer.package_id);
    const limit = pkg ? `${Math.round(pkg.speed_up/1000)}M/${Math.round(pkg.speed_down/1000)}M` : '5M/5M';
    await mikrotikSvc.manageStaticIp({
      ip: customer.static_ip,
      name: customer.name,
      limit: limit,
      isolate: false
    }, customer.router_id);
  } else if (customer.pppoe_username) {
    const pkg = getPackageById(customer.package_id);
    const targetProfile = pkg ? pkg.name : 'default';
    try {
      await mikrotikSvc.setPppoeProfile(customer.pppoe_username, targetProfile, customer.router_id);
    } catch (e) {
      if (/not found in MikroTik|secret missing/i.test(e.message)) {
        // Secret missing on MikroTik — re-add it with the target profile and a default password.
        // Admin can reset the password later if needed.
        logger.warn(`[Customer] PPPoE secret missing for ${customer.pppoe_username} — re-adding with profile ${targetProfile}`);
        await mikrotikSvc.addPppoeSecret({
          name: customer.pppoe_username,
          password: customer.pppoe_password || customer.login_pin || 'changeme',
          service: 'pppoe',
          profile: targetProfile
        }, customer.router_id);
      } else {
        throw e;
      }
    }
  }

  // Hapus IP dari address-list ISOLIR-1-SEGMEN saat pelunasan agar firewall tidak drop traffic.
  // Berlaku untuk semua tipe (PPPoE, static, hotspot) selama customer punya IP.
  const isolirIp = customer.static_ip || customer.ip_address;
  if (isolirIp) {
    try {
      await mikrotikSvc.removeIsolirAddressList(isolirIp, customer.router_id);
    } catch (e) {
      logger.warn(`[Customer] Gagal remove address-list untuk ${customer.name} (${isolirIp}): ${e.message}`);
    }
  }
  return true;
}

module.exports = {
  getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerStats,
  getAllPackages, getPackageById, createPackage, updatePackage, deletePackage,
  suspendCustomer, activateCustomer, findCustomerByAny, updateCustomerCablePath,
  resetPromoCyclesUsed, formatPhone
};
