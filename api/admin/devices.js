'use strict';
const { sendJSON, corsHeaders } = require('../../lib/http');
const { requireAuth } = require('../../lib/auth');
const storage = require('../../lib/storage');
const { effectiveStatus } = require('../../lib/dbops');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (!requireAuth(req, res)) return;

  try {
    const db = await storage.loadDB();
    const rows = [];
    for (const rec of Object.values(db.keys)) {
      for (const [hash, d] of Object.entries(rec.devices || {})) {
        rows.push({
          device: hash,
          key: rec.key,
          keyStatus: effectiveStatus(rec),
          firstSeen: d.firstSeen,
          lastSeen: d.lastSeen,
          verifies: d.verifies || 0,
          meta: d.meta || null,
        });
      }
    }
    rows.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
    return sendJSON(res, 200, { total: rows.length, devices: rows.slice(0, 200) });
  } catch (e) {
    return sendJSON(res, e.status || 500, { error: e.message || 'Server error' });
  }
};
