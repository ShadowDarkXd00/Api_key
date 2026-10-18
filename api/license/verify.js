'use strict';
/**
 * Public license verification endpoint — this is what your apps call.
 *
 *   POST /api/license/verify
 *     body: { apiKey, deviceId?, deviceMeta? }
 *     → consumes one use, registers the device, returns status.
 *
 *   GET /api/license/verify?apiKey=...
 *     → status check only (consumes nothing, registers nothing).
 */
const { readJSON, sendJSON, parseQuery, clientIp, corsHeaders } = require('../../lib/http');
const storage = require('../../lib/storage');
const { addLog, evaluate, summarize, deviceHash } = require('../../lib/dbops');

const REASONS = {
  invalid_key: 'Invalid license key.',
  revoked: 'This license key has been revoked.',
  expired: 'This license has expired.',
  max_uses: 'The use limit for this key has been reached.',
  max_devices: 'The device limit for this key has been reached.',
};

// Light in-memory rate limiting (per isolate).
const buckets = new Map();
function rateOk(bucketKey, limit, windowMs = 60 * 1000) {
  const now = Date.now();
  let list = buckets.get(bucketKey);
  if (!list) {
    list = [];
    buckets.set(bucketKey, list);
  }
  while (list.length && now - list[0] > windowMs) list.shift();
  if (list.length >= limit) {
    list.push(now);
    return false;
  }
  list.push(now);
  return true;
}

function pickMeta(meta) {
  const out = {};
  for (const k of ['app', 'appVersion', 'platform', 'os', 'hostname']) {
    if (typeof meta[k] === 'string' && meta[k].length <= 100) out[k] = meta[k];
  }
  return Object.keys(out).length ? out : null;
}

function failPayload(reason, summary) {
  return {
    valid: false,
    reason,
    message: REASONS[reason] || 'License verification failed.',
    usesCount: summary ? summary.usesCount : undefined,
    maxUses: summary ? summary.maxUses : undefined,
    deviceCount: summary ? summary.deviceCount : undefined,
    maxDevices: summary ? summary.maxDevices : undefined,
  };
}

function okPayload(s, devHash) {
  return {
    valid: true,
    key: s.key,
    expiresAt: s.expiresAt,
    usesUsed: s.usesCount,
    usesLeft: s.maxUses == null ? null : Math.max(0, s.maxUses - s.usesCount),
    deviceCount: s.deviceCount,
    maxDevices: s.maxDevices,
    deviceRegistered: devHash ? true : null,
    message: 'OK',
  };
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }

  // ---------- GET: status check (no side effects) ----------
  if (req.method === 'GET') {
    const q = parseQuery(req);
    const apiKey = (q.apiKey || '').trim().toUpperCase();
    if (!apiKey) {
      return sendJSON(res, 400, { valid: false, reason: 'missing_key', message: 'Provide ?apiKey=YOUR_KEY' });
    }
    let db;
    try {
      db = await storage.loadDB();
    } catch (e) {
      return sendJSON(res, 502, { valid: false, reason: 'server_error', message: e.message });
    }
    const rec = db.keys[apiKey];
    if (!rec) return sendJSON(res, 200, failPayload('invalid_key', null));
    const s = summarize(rec);
    const ev = evaluate(rec);
    if (!ev.ok) {
      return sendJSON(res, 200, { ...failPayload(ev.reason, s), note: 'status check (no use consumed)' });
    }
    return sendJSON(res, 200, { ...okPayload(s, null), note: 'status check (no use consumed)' });
  }

  // ---------- POST: real activation / check-in ----------
  if (req.method !== 'POST') {
    return sendJSON(res, 405, { valid: false, reason: 'method_not_allowed', message: 'Use POST (or GET for a status check).' });
  }

  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendJSON(res, 400, { valid: false, reason: 'bad_request', message: e.message });
  }

  const apiKey = (typeof body.apiKey === 'string' ? body.apiKey : '').trim().toUpperCase();
  const deviceIdRaw = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
  if (!apiKey) return sendJSON(res, 400, { valid: false, reason: 'missing_key', message: 'apiKey is required.' });
  if (apiKey.length > 120) return sendJSON(res, 400, { valid: false, reason: 'bad_key', message: 'apiKey is too long.' });
  if (deviceIdRaw.length > 200) {
    return sendJSON(res, 400, { valid: false, reason: 'bad_device', message: 'deviceId is too long (max 200 chars).' });
  }
  const devHash = deviceIdRaw ? deviceHash(deviceIdRaw) : null;
  const deviceMeta = body.deviceMeta && typeof body.deviceMeta === 'object' ? pickMeta(body.deviceMeta) : null;

  const ip = clientIp(req);
  if (!rateOk('ip:' + ip, 300)) {
    return sendJSON(res, 429, { valid: false, reason: 'rate_limited', message: 'Too many requests from this network. Slow down.' });
  }
  if (!rateOk('key:' + apiKey, 200)) {
    return sendJSON(res, 429, { valid: false, reason: 'rate_limited', message: 'Too many requests for this key. Slow down.' });
  }

  let last = null;
  try {
    await storage.saveDB((db) => {
      const rec = db.keys[apiKey];
      const nowIso = new Date().toISOString();

      if (!rec) {
        addLog(db, 'verify_fail', {
          key: apiKey.length > 20 ? apiKey.slice(0, 20) + '…' : apiKey,
          reason: 'invalid_key',
          device: devHash ? devHash.slice(0, 12) : null,
        });
        last = { ok: false, reason: 'invalid_key', summary: null };
        return db;
      }

      const ev = evaluate(rec);
      if (!ev.ok) {
        addLog(db, 'verify_fail', { key: rec.key, reason: ev.reason, device: devHash ? devHash.slice(0, 12) : null });
        last = { ok: false, reason: ev.reason, summary: summarize(rec) };
        return db;
      }

      if (devHash) {
        if (!rec.devices[devHash]) {
          if (rec.maxDevices != null && Object.keys(rec.devices).length >= rec.maxDevices) {
            addLog(db, 'verify_fail', { key: rec.key, reason: 'max_devices', device: devHash.slice(0, 12) });
            last = { ok: false, reason: 'max_devices', summary: summarize(rec) };
            return db;
          }
          rec.devices[devHash] = { firstSeen: nowIso, lastSeen: nowIso, verifies: 1, meta: deviceMeta };
          addLog(db, 'device_activated', { key: rec.key, device: devHash, meta: deviceMeta });
        } else {
          const d = rec.devices[devHash];
          d.lastSeen = nowIso;
          d.verifies = (d.verifies || 0) + 1;
          if (deviceMeta) d.meta = deviceMeta;
        }
      }

      rec.usesCount = (rec.usesCount || 0) + 1;
      rec.lastUsedAt = nowIso;
      addLog(db, 'verify_ok', {
        key: rec.key,
        device: devHash ? devHash.slice(0, 12) : null,
        uses: rec.usesCount,
        devices: Object.keys(rec.devices).length,
      });
      last = { ok: true, summary: summarize(rec) };
      return db;
    });
  } catch (e) {
    return sendJSON(res, e.status || 502, { valid: false, reason: 'server_error', message: e.message });
  }

  if (!last.ok) return sendJSON(res, 200, failPayload(last.reason, last.summary));
  return sendJSON(res, 200, okPayload(last.summary, devHash));
};
