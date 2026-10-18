'use strict';
const { readJSON, sendJSON, parseQuery, corsHeaders } = require('../../lib/http');
const { requireAuth } = require('../../lib/auth');
const storage = require('../../lib/storage');
const {
  normalizeKey,
  parseLimits,
  parseExpiry,
  addLog,
  createKey,
  details,
  summarize,
  generateLicenseKey,
} = require('../../lib/dbops');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (!requireAuth(req, res)) return;

  try {
    const q = parseQuery(req);

    // ---------- LIST or DETAIL ----------
    if (req.method === 'GET') {
      const db = await storage.loadDB();
      if (q.key) {
        const key = q.key.trim().toUpperCase();
        const d = details(db, key);
        if (!d) return sendJSON(res, 404, { error: 'Key not found' });
        return sendJSON(res, 200, { key: d });
      }
      const list = Object.values(db.keys)
        .map(summarize)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
      return sendJSON(res, 200, { keys: list });
    }

    const body = await readJSON(req);

    // ---------- CREATE ----------
    if (req.method === 'POST') {
      const errors = [];
      const mode = body.mode === 'custom' ? 'custom' : 'auto';
      let keyStr;
      if (mode === 'custom') {
        const n = normalizeKey(body.key);
        if (n.error) errors.push(n.error);
        else keyStr = n.key;
      } else {
        const prefix =
          typeof body.prefix === 'string' && body.prefix.trim() ? body.prefix.trim().toUpperCase() : 'SHADOW';
        if (!/^[A-Z0-9]{2,20}$/.test(prefix)) {
          errors.push('Prefix may contain A–Z and 0–9 only (2–20 characters).');
        } else {
          keyStr = generateLicenseKey(prefix);
        }
      }
      const limits = parseLimits(body, errors);
      const exp = parseExpiry(body, errors);
      if (body.note !== undefined && typeof body.note !== 'string') errors.push('Note must be a string.');
      if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });

      const opts = {
        expiresAt: exp.expiresAt === undefined ? null : exp.expiresAt,
        maxUses: limits.maxUses === undefined ? null : limits.maxUses,
        maxDevices: limits.maxDevices === undefined ? null : limits.maxDevices,
        note: (body.note || '').trim(),
      };
      const result = await storage.saveDB((db) => {
        const r = createKey(db, keyStr, opts, mode);
        if (r.error) throw Object.assign(new Error(r.error), { status: 409 });
        return db;
      });
      const rec = result.keys[keyStr];
      return sendJSON(res, 201, { ok: true, key: summarize(rec) });
    }

    // ---------- UPDATE ----------
    if (req.method === 'PATCH') {
      const key = (q.key || '').trim().toUpperCase();
      if (!key) return sendJSON(res, 400, { error: 'key query parameter is required' });
      const errors = [];
      const patch = {};
      if (body.status !== undefined) {
        if (body.status !== 'active' && body.status !== 'revoked') errors.push('status must be "active" or "revoked".');
        else patch.status = body.status;
      }
      Object.assign(patch, parseLimits(body, errors));
      Object.assign(patch, parseExpiry(body, errors, { allowPast: true }));
      if (body.note !== undefined) {
        if (typeof body.note !== 'string') errors.push('Note must be a string.');
        else patch.note = body.note.slice(0, 200);
      }
      if (errors.length) return sendJSON(res, 400, { error: errors.join(' ') });

      const ops = { resetUses: body.resetUses === true, clearDevices: body.clearDevices === true };
      const hasPatch = Object.entries(patch).some(([, v]) => v !== undefined);
      if (!hasPatch && !ops.resetUses && !ops.clearDevices) {
        return sendJSON(res, 400, { error: 'Nothing to update.' });
      }

      let updated;
      await storage.saveDB((db) => {
        const rec = db.keys[key];
        if (!rec) throw Object.assign(new Error('Key not found'), { status: 404 });
        const changes = [];
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) {
            rec[k] = v;
            changes.push(k);
          }
        }
        if (ops.resetUses) {
          rec.usesCount = 0;
          changes.push('resetUses');
        }
        if (ops.clearDevices) {
          rec.devices = {};
          changes.push('clearDevices');
        }
        rec.updatedAt = new Date().toISOString();
        addLog(db, 'key_updated', { key: rec.key, changes });
        updated = rec;
        return db;
      });
      return sendJSON(res, 200, { ok: true, key: summarize(updated) });
    }

    // ---------- DELETE ----------
    if (req.method === 'DELETE') {
      const key = (q.key || '').trim().toUpperCase();
      if (!key) return sendJSON(res, 400, { error: 'key query parameter is required' });
      await storage.saveDB((db) => {
        const rec = db.keys[key];
        if (!rec) throw Object.assign(new Error('Key not found'), { status: 404 });
        delete db.keys[key];
        addLog(db, 'key_deleted', { key, uses: rec.usesCount || 0, devices: Object.keys(rec.devices || {}).length });
        return db;
      });
      return sendJSON(res, 200, { ok: true, deleted: key });
    }

    return sendJSON(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    return sendJSON(res, e.status || 500, { error: e.message || 'Server error' });
  }
};
