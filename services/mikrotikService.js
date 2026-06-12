const { RouterOSClient } = require('routeros-client');
const { getSettingsWithCache } = require('../config/settingsManager');
const { logger } = require('../config/logger');
const db = require('../config/database');

// Convert camelCase keys to kebab-case for MikroTik API
function toMikrotikKeys(obj) {
  const map = {
    callerId: 'caller-id',
    remoteAddress: 'remote-address',
    localAddress: 'local-address',
    ipv6Routes: 'ipv6-routes',
    limitBytesIn: 'limit-bytes-in',
    limitBytesOut: 'limit-bytes-out',
    lastLoggedOut: 'last-logged-out',
    service: 'service',
    profile: 'profile',
    password: 'password',
    name: 'name',
    comment: 'comment',
    disabled: 'disabled',
    routes: 'routes',
  };
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[map[k] || k] = v;
  }
  return out;
}

async function getConnection(routerId = null) {
  let host, port, user, password;

  if (routerId) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId);
    if (!router) throw new Error(`Router with ID ${routerId} not found`);
    host = router.host;
    port = router.port || 8728;
    user = router.user;
    password = router.password;
  } else {
    const settings = getSettingsWithCache();
    host = settings.mikrotik_host;
    port = settings.mikrotik_port || 8728;
    user = settings.mikrotik_user;
    password = settings.mikrotik_password;
  }

  if (!host || !user) {
    throw new Error('MikroTik settings not configured');
  }

  const api = new RouterOSClient({
    host,
    port,
    user,
    password,
    timeout: 5000
  });

  // Catch errors from RouterOSClient event emitter to prevent uncaughtException (!empty bug)
  api.on('error', (err) => {
    logger.error(`MikroTik API error (${host}): ${err.message}`);
  });

  try {
    const client = await api.connect();
    // Also catch connection-level errors
    if (client && typeof client.on === 'function') {
      client.on('error', (err) => {
        logger.error(`MikroTik client error (${host}): ${err.message}`);
      });
    }
    return { client, api };
  } catch (err) {
    logger.error(`Failed to connect to MikroTik (${host}):`, err);
    throw err;
  }
}

async function getPppoeProfiles(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const results = await conn.client.menu('/ppp/profile').get();
    return results.map(r => ({
      id: r['.id'],
      name: r.name,
      localAddress: r.localAddress || r['local-address'] || '-',
      remoteAddress: r.remoteAddress || r['remote-address'] || '-',
      rateLimit: r.rateLimit || r['rate-limit'] || '-'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeUsers(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    // Only get secrets for pppoe service
    const results = await conn.client.menu('/ppp/secret').where('service', 'pppoe').get();
    return results.map(r => ({
      id: r['.id'],
      name: r.name,
      profile: r.profile,
      disabled: r.disabled === 'true'
    }));
  } catch (e) {
    logger.error('Error getting PPPoE users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Function to isolate a user
async function setPppoeProfile(username, profileName, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const secretMenu = conn.client.menu('/ppp/secret');
    const secrets = await secretMenu.where('name', username).get();

    if (!secrets || secrets.length === 0) {
      // Secret missing on MikroTik (e.g. failed earlier delete, or never added).
      // Log warning dan return false (idempotent) — caller (activateCustomer) bisa
      // re-add via addPppoeSecret kalau perlu. Untuk suspendCustomer, skip saja
      // dan biarkan caller handle.
      logger.warn(`[MikroTik] setPppoeProfile: PPPoE secret "${username}" not found in MikroTik, skipping.`);
      return false;
    }

    const secret = secrets[0];
    const secretId = secret['.id'] || secret.id;
    if (!secretId) {
      throw new Error(`PPPoE secret ID not found for user ${username}`);
    }
    const currentProfile = secret.profile;

    // Hanya update dan kick jika profil berubah
    if (currentProfile !== profileName) {
      logger.info(`[MikroTik] Changing profile for ${username}: ${currentProfile} -> ${profileName}`);
      // Use delete+add instead of set to avoid MikroTik API bug corrupting records
      // Exclude internal, read-only, and system fields
      const READONLY = ['.id', 'id', '$$path', 'last-logged-out', 'lastLoggedOut', 'caller-id', 'callerId', 'last-caller-id', 'lastCallerId', 'last-disconnect-reason', 'lastDisconnectReason', 'last-updated', 'lastUpdated'];
      const newSecret = {};
      for (const [k, v] of Object.entries(secret)) {
        if (READONLY.includes(k) || k.startsWith('$$')) continue;
        newSecret[k] = v;
      }
      newSecret.profile = profileName;
      // Remove old record first ( MikroTik rejects add if name already exists)
      await secretMenu.remove(secretId);
      await secretMenu.add(toMikrotikKeys(newSecret));
      // Disconnect active connection so they reconnect with new profile
      await kickPppoeUser(username, routerId);
    } else {
      logger.info(`[MikroTik] Profile for ${username} is already ${profileName}. Skipping update and kick.`);
    }

    return true;
  } catch (e) {
    logger.error(`Error setting PPPoE profile for ${username}:`, e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickPppoeUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) {
    logger.warn('[MikroTik] kickPppoeUser called without username. Skipping.');
    return false;
  }
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ppp/active').where('name', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping PPPoE active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ppp/active').remove(sessionId);
      }
      return true;
    }
    
    logger.info(`[MikroTik] No active PPPoE session found for user: ${normalizedUsername}`);
    return false;
  } catch (e) {
    logger.error(`Error kicking PPPoE user ${normalizedUsername}:`, e);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function kickHotspotUser(username, routerId = null) {
  const normalizedUsername = String(username || '').trim();
  if (!normalizedUsername) return false;
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const sessions = await conn.client.menu('/ip/hotspot/active').where('user', normalizedUsername).get();
    
    if (sessions.length > 0) {
      logger.info(`[MikroTik] Kicking ${sessions.length} active hotspot session(s) for user: ${normalizedUsername}`);
      for (const s of sessions) {
        const sessionId = s['.id'] || s.id;
        if (!sessionId) {
          logger.warn(`[MikroTik] Skipping Hotspot active remove because session id missing for user: ${normalizedUsername}`);
          continue;
        }
        await conn.client.menu('/ip/hotspot/active').remove(sessionId);
      }
      return true;
    }
    return false;
  } catch (e) {
    logger.warn(`Could not kick active hotspot connection for ${normalizedUsername}: ${e.message}`);
    return false;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeSecrets(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').get();
  } catch (e) {
    logger.error('Error getting PPPoE secrets:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addPppoeSecret(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeSecret(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeSecret(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/secret').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getPppoeActive(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/active').get();
  } catch (e) {
    logger.error('Error getting active PPPoE sessions:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotActive(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/active').get();
  } catch (e) {
    logger.error('Error getting active Hotspot sessions:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// PPPoE Profiles CRUD
async function addPppoeProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').add(data);
  } catch (e) {
    logger.error('Error adding PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updatePppoeProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').set(data, id);
  } catch (e) {
    logger.error('Error updating PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deletePppoeProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ppp/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting PPPoE profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Hotspot Profiles CRUD (User Profiles)
async function getHotspotUserProfiles(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').get();
  } catch (e) {
    logger.error('Error getting Hotspot user profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUserProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').add(data);
  } catch (e) {
    logger.error('Error adding Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUserProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').set(data, id);
  } catch (e) {
    logger.error('Error updating Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUserProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user/profile').remove(id);
  } catch (e) {
    logger.error('Error deleting Hotspot user profile:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotUsers(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').get();
  } catch (e) {
    logger.error('Error getting Hotspot users:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotUser(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotUser(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotUser(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/user').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getBackup(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/').exec('export');
    return result;
  } catch (e) {
    logger.error('Error exporting MikroTik config:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemScripts(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/system/script').get();
  } catch (e) {
    logger.error('Error getting MikroTik system scripts:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getSystemResource(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const result = await conn.client.menu('/system/resource').get();
    return result[0];
  } catch (e) {
    logger.error('Error getting MikroTik system resource:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function getHotspotProfiles(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').get();
  } catch (e) {
    logger.error('Error getting Hotspot profiles:', e);
    return [];
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function addHotspotProfile(data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').add(data);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function updateHotspotProfile(id, data, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').set(data, id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function deleteHotspotProfile(id, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    return await conn.client.menu('/ip/hotspot/profile').remove(id);
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// Router CRUD Services
function getAllRouters() {
  return db.prepare('SELECT * FROM routers ORDER BY name ASC').all();
}

function getRouterById(id) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(id);
}

function createRouter(data) {
  return db.prepare(`
    INSERT INTO routers (name, host, port, user, password, description, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(data.name, data.host, data.port || 8728, data.user, data.password, data.description || '', data.is_active || 1);
}

function updateRouter(id, data) {
  return db.prepare(`
    UPDATE routers SET name=?, host=?, port=?, user=?, password=?, description=?, is_active=?
    WHERE id=?
  `).run(data.name, data.host, data.port || 8728, data.user, data.password, data.description || '', data.is_active || 1, id);
}

function deleteRouter(id) {
  return db.prepare('DELETE FROM routers WHERE id = ?').run(id);
}

// --- FIREWALL & ISOLIR STATIC IP ---
async function setupIsolirFirewall(routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // 1. Ensure Address List exists (implicitly by adding or just checking)
    // We'll add a dummy entry to ensure it's there or just proceed to rules
    
    // 2. Add NAT Rule for Redirect to Isolir Page (Port 80)
    const natMenu = conn.client.menu('/ip/firewall/nat');
    const existingNat = await natMenu.where('comment', 'ISOLIR_REDIRECT').get();
    
    // Auto-detect server IP or use a setting
    const settings = getSettingsWithCache();
    const serverUrl = settings.app_url || 'http://192.168.1.1:3002'; // Fallback
    
    if (existingNat.length === 0) {
      await natMenu.add({
        chain: 'dstnat',
        'src-address-list': 'ISOLIR-1-SEGMEN',
        protocol: 'tcp',
        'dst-port': '80',
        action: 'redirect',
        'to-ports': '3002', // Port internal aplikasi billing
        comment: 'ISOLIR_REDIRECT'
      });
    }

    // 3. Add Filter Rule to block all other traffic for isolated users
    const filterMenu = conn.client.menu('/ip/firewall/filter');
    const existingFilter = await filterMenu.where('comment', 'BLOCK_ISOLIR').get();
    if (existingFilter.length === 0) {
      await filterMenu.add({
        chain: 'forward',
        'src-address-list': 'ISOLIR-1-SEGMEN',
        action: 'drop',
        comment: 'BLOCK_ISOLIR'
      });
    }

    return { success: true, message: 'Firewall Isolir berhasil disiapkan di MikroTik' };
  } catch (e) {
    logger.error('Error setupIsolirFirewall:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// REST API helper for MikroTik (avoids node-routeros "!empty reply" bug on queue/simple & address-list)
async function restApi(path, method = 'GET', body = null) {
  let host, port, user, password;
  // Default to settings.mikrotik_host (we only have one router — 10.10.10.1 — in production)
  const settings = getSettingsWithCache();
  host = settings.mikrotik_host;
  port = settings.mikrotik_rest_port || 80; // RouterOS REST runs on port 80 by default
  user = settings.mikrotik_user;
  password = settings.mikrotik_password;
  if (!host || !user) throw new Error('MikroTik settings not configured');
  const auth = Buffer.from(`${user}:${password}`).toString('base64');
  const url = `http://${host}:${port}${path}`;
  const opts = { method, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`MikroTik REST ${method} ${path} failed: ${r.status} ${txt}`);
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) return r.json();
  return r.text();
}

async function manageStaticIp(data, routerId = null) {
  const { ip, name, limit, isolate } = data;
  try {
    // 1. Manage Simple Queue for Bandwidth (via REST API — avoids node-routeros !empty bug)
    const queues = await restApi('/rest/queue/simple', 'GET');
    const existingQueue = (queues || []).find(q => q.target === `${ip}/32`);

    const queueData = {
      name: `CUST-${name}`,
      target: `${ip}/32`,
      'max-limit': limit || '5M/5M',
      comment: `Managed by Billing - ${name}`
    };

    if (existingQueue) {
      await restApi('/rest/queue/simple/' + existingQueue['.id'], 'PATCH', queueData);
    } else {
      await restApi('/rest/queue/simple', 'PUT', queueData);
    }

    // 2. Manage Address List for Isolation (via REST API)
    const allAddr = await restApi('/rest/ip/firewall/address-list', 'GET');
    const existingEntry = (allAddr || []).find(e => e.address === ip && e.list === 'ISOLIR-1-SEGMEN');

    if (isolate) {
      if (!existingEntry) {
        await restApi('/rest/ip/firewall/address-list', 'PUT', { list: 'ISOLIR-1-SEGMEN', address: ip, comment: name });
      }
    } else {
      if (existingEntry) {
        await restApi('/rest/ip/firewall/address-list/' + existingEntry['.id'], 'DELETE');
      }
    }

    return true;
  } catch (e) {
    logger.error('Error manageStaticIp:', e);
    throw e;
  }
}

async function removeStaticIp(ip, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    
    // Remove Queue
    const queueMenu = conn.client.menu('/queue/simple');
    const queues = await queueMenu.where('target', `${ip}/32`).get();
    for (const q of queues) await queueMenu.remove(q['.id']);

    // Remove from Address List (filter manual)
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const allAddr = await addrListMenu.get();
    const entries = allAddr.filter(e => e.address === ip && e.list === 'ISOLIR-1-SEGMEN');
    for (const e of entries) {
      const eid = e['.id'] || e.id;
      if (!eid) continue;
      try {
        await addrListMenu.remove(eid);
      } catch (innerErr) {
        if (!/no such item/i.test(innerErr.message)) throw innerErr;
      }
    }

    return true;
  } catch (e) {
    logger.error('Error removeStaticIp:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

// --- ADDRESS LIST HELPERS (isolir/un-isolir untuk PPPoE & static) ---
// Catatan: pakai .get() tanpa .where() karena library node-routeros 1.6.8
// tidak handle reply "!empty" (ketika query match zero entry) — crash.
// Filter manual di client-side lebih aman.
async function addIsolirAddressList(ip, name = '', routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const all = await addrListMenu.get();
    const exists = all.find(e => e.address === ip && e.list === 'ISOLIR-1-SEGMEN');
    if (!exists) {
      await addrListMenu.add({ list: 'ISOLIR-1-SEGMEN', address: ip, comment: name });
      logger.info(`[Mikrotik] Add ISOLIR-1-SEGMEN address-list: ${ip} (${name})`);
    }
    return true;
  } catch (e) {
    logger.error('Error addIsolirAddressList:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

async function removeIsolirAddressList(ip, routerId = null) {
  let conn = null;
  try {
    conn = await getConnection(routerId);
    const addrListMenu = conn.client.menu('/ip/firewall/address-list');
    const all = await addrListMenu.get();
    const matches = all.filter(e => e.address === ip && e.list === 'ISOLIR-1-SEGMEN');
    for (const e of matches) {
      const eid = e['.id'] || e.id;
      if (!eid) continue;
      try {
        await addrListMenu.remove(eid);
        logger.info(`[Mikrotik] Remove ISOLIR-1-SEGMEN address-list: ${ip}`);
      } catch (innerErr) {
        // "no such item" = entry sudah dihapus (idempotent), aman di-skip
        if (/no such item/i.test(innerErr.message)) {
          logger.warn(`[Mikrotik] Address-list entry ${ip} sudah tidak ada, skip.`);
        } else {
          throw innerErr;
        }
      }
    }
    return true;
  } catch (e) {
    logger.error('Error removeIsolirAddressList:', e);
    throw e;
  } finally {
    if (conn && conn.api) conn.api.close();
  }
}

module.exports = {
  getConnection,
  getPppoeProfiles,
  getPppoeUsers,
  setPppoeProfile,
  getPppoeSecrets,
  addPppoeSecret,
  updatePppoeSecret,
  deletePppoeSecret,
  getHotspotUsers,
  addHotspotUser,
  updateHotspotUser,
  deleteHotspotUser,
  getHotspotProfiles,
  getPppoeActive,
  getHotspotActive,
  addPppoeProfile,
  updatePppoeProfile,
  deletePppoeProfile,
  addIsolirAddressList,
  removeIsolirAddressList,
  getHotspotUserProfiles,
  addHotspotUserProfile,
  updateHotspotUserProfile,
  deleteHotspotUserProfile,
  getBackup,
  kickPppoeUser,
  kickHotspotUser,
  getSystemResource,
  getSystemScripts,
  getAllRouters,
  getRouterById,
  createRouter,
  updateRouter,
  deleteRouter,
  setupIsolirFirewall,
  manageStaticIp,
  removeStaticIp
};
