'use strict';
/** Database operations for the SHADOW license system. */
const { sha256, randomToken, generateLicenseKey } = require('./crypto');

const LOG_CAP = 500;

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Validate + normalize a custom license key. */
function normalizeKey(raw) {
  if (typeof raw !== 'string') return { error: 'License key must be a string.' };
  const key = raw.trim().toUpperCase();
  if (key.length < 8) return { error: 'License key must be at least 8 characters long.' };
  if (key.length > 80) return { error: 'License key must be 80 characters or fewer.' };
  if (!/^[A-Z0-9_-]+$/.test(key)) {
    return { error: 'License keys may only contain A–Z, 0–9, dashes and underscores.' };
  }
  return { key };
}

function parseLimit(v, label, errors) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    errors.push(`${label} must be a positive whole number (leave empty for unlimited).`);
    return undefined;
  }
  if (n > 1_000_000_000) {
    errors.push(`${label} is too large.`);
    return undefined;
  }
  return n;
}

/** Returns { maxUses?, maxDevices? } — keys absent when the body did not set them. */
function parseLimits(body, errors) {
  const out = {};
  if (body.maxUses !== undefined) out.maxUses = parseLimit(body.maxUses, 'Max uses', errors);
  if (body.maxDevices !== undefined) out.maxDevices = parseLimit(body.maxDevices, 'Max devices', errors);
  return out;
}

/** Returns { expiresAt } or {} when the body did not set it. */
function parseExpiry(body, errors, { allowPast = false } = {}) {
  if (body.expiresAt === undefined) return {};
  if (body.expiresAt === '' || body.expiresAt === null) return { expiresAt: null };
  const t = new Date(body.expiresAt).getTime();
  if (Number.isNaN(t)) {
    errors.push('Expiry must be a valid date.');
    return { expiresAt: undefined };
  }
  if (!allowPast && t <= Date.now()) {
    errors.push('Expiry must be in the future.');
    return { expiresAt: undefined };
  }
  return { expiresAt: new Date(t).toISOString() };
}

function addLog(db, type, extra) {
  db.logs.unshift({ ts: new Date().toISOString(), type, ...(extra || {}) });
  if (db.logs.length > LOG_CAP) db.logs.length = LOG_CAP;
}

function makeKeyRecord(key, opts, source) {
  const now = new Date().toISOString();
  return {
    id: 'k_' + randomToken(6),
    key,
    source: source || 'manual', // 'auto' | 'custom'
    status: 'active', // 'active' | 'revoked'
    note: (opts.note || '').slice(0, 200),
    createdAt: now,
    updatedAt: now,
    expiresAt: opts.expiresAt || null,
    maxUses: opts.maxUses == null ? null : opts.maxUses,
    usesCount: 0,
    maxDevices: opts.maxDevices == null ? null : opts.maxDevices,
    devices: {}, // deviceHash → { firstSeen, lastSeen, verifies, meta }
    lastUsedAt: null,
  };
}

function createKey(db, key, opts, source) {
  if (db.keys[key]) return { error: `Key "${key}" already exists.` };
  const rec = makeKeyRecord(key, opts, source);
  db.keys[key] = rec;
  addLog(db, 'key_created', { key: rec.key, source: rec.source });
  return { record: rec };
}

/** stored status + expiry → effective status */
function effectiveStatus(rec) {
  if (rec.status !== 'active') return 'revoked';
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** Check whether the key would pass (does NOT mutate anything). */
function evaluate(rec) {
  if (rec.status !== 'active') return { ok: false, reason: 'revoked' };
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'expired' };
  if (rec.maxUses != null && (rec.usesCount || 0) >= rec.maxUses) return { ok: false, reason: 'max_uses' };
  return { ok: true };
}

function summarize(rec) {
  return {
    id: rec.id,
    key: rec.key,
    source: rec.source,
    status: rec.status,
    effective: effectiveStatus(rec),
    note: rec.note || '',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    expiresAt: rec.expiresAt || null,
    maxUses: rec.maxUses,
    usesCount: rec.usesCount || 0,
    maxDevices: rec.maxDevices,
    deviceCount: Object.keys(rec.devices || {}).length,
    lastUsedAt: rec.lastUsedAt || null,
  };
}

/** Full record including the device list. */
function details(db, key) {
  const rec = db.keys[key];
  if (!rec) return null;
  const s = summarize(rec);
  s.devices = Object.entries(rec.devices || {})
    .map(([hash, d]) => ({
      hash,
      firstSeen: d.firstSeen,
      lastSeen: d.lastSeen,
      verifies: d.verifies || 0,
      meta: d.meta || null,
    }))
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return s;
}

/** Devices are stored hashed (privacy). Hashing is case-insensitive + trimmed. */
function deviceHash(deviceId) {
  return sha256(String(deviceId).trim().toLowerCase());
}

module.exports = {
  LOG_CAP,
  normalizeKey,
  parseLimits,
  parseExpiry,
  addLog,
  createKey,
  effectiveStatus,
  evaluate,
  summarize,
  details,
  deviceHash,
  generateLicenseKey,
  clone,
};
