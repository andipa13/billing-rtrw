#!/usr/bin/env node
/**
 * sync_ip_mikrotik.js — Deteksi & auto-fix mismatch IP antara MikroTik dan billing DB.
 * 
 * Jalankan: node scripts/sync_ip_mikrotik.js
 * Atau via cron: setiap jam / setiap hari
 */

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// ─── Load settings ───
const settingsPath = path.join(__dirname, '..', 'settings.json');
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
const dbPath = path.join(__dirname, '..', 'database', 'billing.db');
const db = new Database(dbPath);

const MIKROTIK_HOST = settings.mikrotik_host || '10.10.10.1';
const MIKROTIK_USER = settings.mikrotik_user || 'zya';
const MIKROTIK_PASS = settings.mikrotik_password || 'zya';
const MIKROTIK_REST_PORT = 80;  // REST always on :80, not :8728 (API)

const log = (msg) => {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  console.log(`[${ts}] ${msg}`);
};

// ─── Fetch MikroTik PPPoE secrets via curl (REST) ───
function fetchMikrotikSecrets() {
  const { execSync } = require('child_process');
  const url = `http://${MIKROTIK_USER}:${MIKROTIK_PASS}@${MIKROTIK_HOST}:${MIKROTIK_REST_PORT}/rest/ppp/secret`;
  try {
    const out = execSync(`curl -s --connect-timeout 10 --max-time 15 "${url}"`, {
      encoding: 'utf-8',
      maxBuffer: 5 * 1024 * 1024
    });
    const data = JSON.parse(out);
    return data;
  } catch (err) {
    log(`ERROR fetch MikroTik: ${err.message}`);
    return null;
  }
}

// ─── Main sync ───
function main() {
  log('Starting IP sync check...');

  const secrets = fetchMikrotikSecrets();
  if (!secrets) {
    log('FATAL: Cannot fetch MikroTik secrets. Aborting.');
    process.exit(1);
  }
  log(`Fetched ${secrets.length} PPPoE secrets from MikroTik`);

  // Build map: pppoe_username → { ip, profile, disabled }
  const mtMap = new Map();
  for (const s of secrets) {
    const name = (s.name || '').trim();
    if (!name) continue;
    mtMap.set(name.toLowerCase(), {
      name: name,
      ip: s['remote-address'] || '',
      profile: s.profile || '?',
      disabled: s.disabled === 'true' || s.disabled === true
    });
  }

  // Get all customers with pppoe_username
  const customers = db.prepare(`
    SELECT id, name, pppoe_username, ip_address, status 
    FROM customers 
    WHERE pppoe_username IS NOT NULL AND pppoe_username != ''
  `).all();
  log(`Found ${customers.length} customers with PPPoE username in DB`);

  let fixes = 0;
  let issues = [];
  const ipUsage = new Map(); // Track IP usage across customers

  for (const cust of customers) {
    const pppoe = (cust.pppoe_username || '').trim().toLowerCase();
    if (!pppoe) continue;

    const mt = mtMap.get(pppoe);
    if (!mt) {
      issues.push(`DB: "${cust.name}" (pppoe=${cust.pppoe_username}) — NOT FOUND on MikroTik`);
      continue;
    }

    const dbIp = (cust.ip_address || '').trim();
    const mtIp = (mt.ip || '').trim();

    // Track IP usage
    if (mtIp) {
      if (!ipUsage.has(mtIp)) ipUsage.set(mtIp, []);
      ipUsage.get(mtIp).push({ name: cust.name, pppoe, source: 'mikrotik' });
    }
    if (dbIp) {
      if (!ipUsage.has(dbIp)) ipUsage.set(dbIp, []);
      ipUsage.get(dbIp).push({ name: cust.name, pppoe, source: 'db' });
    }

    if (dbIp && mtIp && dbIp !== mtIp) {
      // MISMATCH — DB has wrong IP
      issues.push(`MISMATCH: "${cust.name}" (${cust.pppoe_username}) DB=${dbIp} MT=${mtIp}`);
      
      // Auto-fix: update DB to match MikroTik
      try {
        db.prepare('UPDATE customers SET ip_address = ? WHERE id = ?').run(mtIp, cust.id);
        // Update allocated_ips: release old, insert new
        db.prepare('UPDATE allocated_ips SET status = ? WHERE customer_id = ? AND ip_address = ?')
          .run('released', cust.id, dbIp);
        // Check if new IP already allocated
        const existing = db.prepare('SELECT id FROM allocated_ips WHERE ip_address = ? AND status = ?').get(mtIp, 'active');
        if (!existing) {
          db.prepare('INSERT INTO allocated_ips (customer_id, ip_address, pool_id, status) VALUES (?, ?, 1, ?)')
            .run(cust.id, mtIp, 'active');
        } else {
          db.prepare('UPDATE allocated_ips SET customer_id = ?, status = ? WHERE ip_address = ? AND status = ?')
            .run(cust.id, 'active', mtIp, 'active');
        }
        log(`FIXED: ${cust.name} IP ${dbIp} → ${mtIp}`);
        fixes++;
      } catch (e) {
        log(`ERROR fixing ${cust.name}: ${e.message}`);
      }
    }
  }

  // Check for duplicate IPs in MikroTik
  const mtIpCounts = new Map();
  for (const s of secrets) {
    const ip = (s['remote-address'] || '').trim();
    if (!ip) continue;
    mtIpCounts.set(ip, (mtIpCounts.get(ip) || 0) + 1);
  }
  for (const [ip, count] of mtIpCounts) {
    if (count > 1) {
      const names = secrets.filter(s => s['remote-address'] === ip).map(s => s.name);
      issues.push(`DUPLIKAT di MikroTik: IP ${ip} → ${count}x: ${names.join(', ')}`);
    }
  }

  // Report
  log('──────────────────────────────────');
  if (issues.length === 0 && fixes === 0) {
    log('✅ All clean — no IP mismatches or duplicates');
  } else {
    if (fixes > 0) log(`🔧 Auto-fixed ${fixes} IP mismatch(es)`);
    if (issues.length > 0) {
      for (const issue of issues) {
        log(`⚠️  ${issue}`);
      }
    }
  }
  log('Sync complete.');
  db.close();
}

main();
