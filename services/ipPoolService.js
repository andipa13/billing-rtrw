/**
 * IP Pool Service — auto-allocate next available IP from pool
 * Checks both allocated_ips table AND MikroTik PPPoE secrets for used IPs
 */
const db = require('../config/database');
const { logger } = require('../config/logger');

function ipToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}

function intToIp(num) {
  return [(num >>> 24) & 255, (num >>> 16) & 255, (num >>> 8) & 255, num & 255].join('.');
}

/**
 * Get all used IPs from allocated_ips table
 */
function getAllocatedIps(poolId = 1) {
  const rows = db.prepare('SELECT ip_address FROM allocated_ips WHERE pool_id = ? AND status = ?').all(poolId, 'active');
  return new Set(rows.map(r => r.ip_address));
}

/**
 * Get used IPs from MikroTik PPPoE secrets (remote-address field)
 */
function getUsedIpsFromSecrets(secrets) {
  const used = new Set();
  for (const s of secrets) {
    const ra = s['remote-address'] || s.remoteAddress || '';
    if (ra) used.add(ra);
  }
  return used;
}

/**
 * Find next available IP in pool, checking both DB and MikroTik
 * @param {Array} mikrotikSecrets - PPPoE secrets from MikroTik
 * @param {number} poolId - IP pool ID (default 1)
 * @returns {string|null} next available IP or null
 */
function getNextAvailableIp(mikrotikSecrets = [], poolId = 1) {
  const pool = db.prepare('SELECT * FROM ip_pools WHERE id = ? AND is_active = 1').get(poolId);
  if (!pool) return null;

  const startInt = ipToInt(pool.start_ip);
  const endInt = ipToInt(pool.end_ip);

  // Combine used IPs from DB + MikroTik
  const dbUsed = getAllocatedIps(poolId);
  const mtUsed = getUsedIpsFromSecrets(mikrotikSecrets);
  const allUsed = new Set([...dbUsed, ...mtUsed]);

  // Also exclude gateway
  if (pool.gateway) allUsed.add(pool.gateway);

  for (let i = startInt; i <= endInt; i++) {
    const ip = intToIp(i);
    if (!allUsed.has(ip)) return ip;
  }
  return null;
}

/**
 * Get list of all available IPs
 */
function getAvailableIps(mikrotikSecrets = [], poolId = 1, limit = 10) {
  const pool = db.prepare('SELECT * FROM ip_pools WHERE id = ? AND is_active = 1').get(poolId);
  if (!pool) return [];

  const startInt = ipToInt(pool.start_ip);
  const endInt = ipToInt(pool.end_ip);
  const dbUsed = getAllocatedIps(poolId);
  const mtUsed = getUsedIpsFromSecrets(mikrotikSecrets);
  const allUsed = new Set([...dbUsed, ...mtUsed]);
  if (pool.gateway) allUsed.add(pool.gateway);

  const available = [];
  for (let i = startInt; i <= endInt && available.length < limit; i++) {
    const ip = intToIp(i);
    if (!allUsed.has(ip)) available.push(ip);
  }
  return available;
}

/**
 * Allocate an IP to a customer
 */
function allocateIp(customerId, ipAddress, poolId = 1) {
  db.prepare('INSERT INTO allocated_ips (customer_id, ip_address, pool_id, status) VALUES (?, ?, ?, ?)').run(customerId, ipAddress, poolId, 'active');
}

/**
 * Release an allocated IP
 */
function releaseIp(customerId) {
  db.prepare("UPDATE allocated_ips SET status = 'released' WHERE customer_id = ?").run(customerId);
}

module.exports = {
  getNextAvailableIp,
  getAvailableIps,
  allocateIp,
  releaseIp,
  getAllocatedIps,
  ipToInt,
  intToIp
};
