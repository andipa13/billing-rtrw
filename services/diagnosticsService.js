/**
 * Service: System Diagnostics & Troubleshooting
 */
const { logger } = require('../config/logger');
const db = require('../config/database');
const mikrotikService = require('./mikrotikService');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

/**
 * Perform a full system dependency check
 */
async function checkDependencies() {
  const results = {
    mikrotik: [],
    genieacs: { status: 'unknown', message: '' },
    whatsapp: { status: 'unknown', message: '' },
    paymentGateways: [],
    timestamp: new Date().toISOString()
  };

  // 1. Check MikroTik Routers
  try {
    const routers = db.prepare('SELECT * FROM routers').all();
    for (const r of routers) {
      try {
        await mikrotikService.getPppoeActive(r.id);
        results.mikrotik.push({ name: r.name, host: r.host, status: 'online', error: null });
      } catch (err) {
        results.mikrotik.push({ name: r.name, host: r.host, status: 'offline', error: err.message });
      }
    }
  } catch (err) {
    logger.error(`[Diagnostics] MikroTik check failed: ${err.message}`);
  }

  // 2. Check GenieACS — gunakan /devices endpoint bukan root
  try {
    const { getSetting } = require('../config/settingsManager');
    const acsUrl = getSetting('genieacs_url', 'http://localhost:7557');
    const user = getSetting('genieacs_username', 'admin');
    const pass = getSetting('genieacs_password', 'admin');
    const response = await axios.get(`${acsUrl}/devices/?limit=1`, {
      timeout: 3000,
      auth: user && pass ? { username: user, password: pass } : undefined
    });
    results.genieacs = {
      status: response.status === 200 ? 'online' : 'warning',
      message: `GenieACS OK (${response.status})`
    };
  } catch (err) {
    results.genieacs = {
      status: 'offline',
      message: `GenieACS unreachable: ${err.message}`
    };
  }

  // 3. Check WhatsApp via Evolution API
  try {
    const { getSetting } = require('../config/settingsManager');
    const evoUrl = getSetting('evolution_api_url', 'http://10.10.10.100:8080');
    const evoToken = getSetting('evolution_api_token', 'FCE130974DA7-499E-8518-607F023CC89C');
    const instance = getSetting('evolution_instance', 'billing');
    const response = await axios.get(`${evoUrl}/instance/connectionState/${instance}`, {
      timeout: 3000,
      headers: { apikey: evoToken }
    });
    const state = response.data?.instance?.state;
    results.whatsapp = {
      status: state === 'open' ? 'online' : 'offline',
      message: `Evolution API: ${state || 'unknown'}`
    };
  } catch (err) {
    results.whatsapp = {
      status: 'offline',
      message: `Evolution API error: ${err.message}`
    };
  }

  return results;
}

/**
 * Get recent errors from log file
 */
function getRecentErrors(limit = 10) {
  try {
    const logPath = path.join(__dirname, '../logs/error.log');
    if (!fs.existsSync(logPath)) return [];
    const content = fs.readFileSync(logPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim() !== '');
    return lines.slice(-limit).reverse();
  } catch (err) {
    return [`Error reading log: ${err.message}`];
  }
}

/**
 * Comprehensive Customer Diagnostics
 */
async function diagnoseCustomer(customerId) {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) throw new Error('Customer not found');

  const report = {
    customer: { name: customer.name, pppoe: customer.pppoe_username },
    billing: { status: 'clean', unpaidCount: 0 },
    mikrotik: { status: 'unknown', details: null },
    genieacs: { status: 'unknown', signal: null },
    timestamp: new Date().toISOString()
  };

  const unpaid = db.prepare("SELECT COUNT(*) as count FROM invoices WHERE customer_id = ? AND status = 'unpaid'").get(customerId);
  report.billing.unpaidCount = unpaid.count;
  if (unpaid.count > 0) report.billing.status = 'warning';

  if (customer.pppoe_username && customer.router_id) {
    try {
      const active = await mikrotikService.getPppoeActive(customer.router_id);
      const session = active.find(s => s.name === customer.pppoe_username);
      if (session) {
        report.mikrotik = {
          status: 'online',
          details: { uptime: session.uptime, address: session.address, caller_id: session['caller-id'] }
        };
      } else {
        report.mikrotik.status = 'offline';
      }
    } catch (err) {
      report.mikrotik.status = 'error';
      report.mikrotik.error = err.message;
    }
  }

  return report;
}

module.exports = { checkDependencies, getRecentErrors, diagnoseCustomer };
