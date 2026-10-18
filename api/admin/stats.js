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
    const now = Date.now();
    const t = { total: 0, active: 0, revoked: 0, expired: 0, expiringSoon: 0, uses: 0, devices: 0 };
    for (const rec of Object.values(db.keys)) {
      t.total += 1;
      const eff = effectiveStatus(rec);
      if (eff === 'revoked') t.revoked += 1;
      else if (eff === 'expired') t.expired += 1;
      else {
        t.active += 1;
        if (rec.expiresAt && new Date(rec.expiresAt).getTime() - now < 7 * 864e5) t.expiringSoon += 1;
      }
      t.uses += rec.usesCount || 0;
      t.devices += Object.keys(rec.devices || {}).length;
    }
    const dayAgo = now - 864e5;
    const weekAgo = now - 7 * 864e5;
    let ok24 = 0;
    let fail24 = 0;
    let keys7d = 0;
    for (const l of db.logs) {
      const ts = new Date(l.ts).getTime();
      if (ts >= dayAgo) {
        if (l.type === 'verify_ok') ok24 += 1;
        else if (l.type === 'verify_fail') fail24 += 1;
      }
      if (l.type === 'key_created' && ts >= weekAgo) keys7d += 1;
    }
    return sendJSON(res, 200, {
      stats: t,
      last24h: { ok: ok24, fail: fail24 },
      keysCreated7d: keys7d,
    });
  } catch (e) {
    return sendJSON(res, e.status || 500, { error: e.message || 'Server error' });
  }
};
