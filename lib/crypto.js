'use strict';
const crypto = require('crypto');

// Unambiguous alphabet (no O/0, I/1) — safe to read aloud or type in.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomKeyChars(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(ALPHABET[crypto.randomInt(ALPHABET.length)]);
  return out.join('');
}

/** Generate a license key like SHADOW-K7F2Q-9XWMB-4TRHD */
function generateLicenseKey(prefix = 'SHADOW', groups = 3, groupLen = 5) {
  const p = (prefix || 'SHADOW').toUpperCase();
  const parts = [];
  for (let i = 0; i < groups; i++) parts.push(randomKeyChars(groupLen));
  return `${p}-${parts.join('-')}`;
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function hmacSign(secret, data) {
  return crypto.createHmac('sha256', secret).update(String(data)).digest('base64url');
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { ALPHABET, randomToken, randomKeyChars, generateLicenseKey, sha256, hmacSign, timingSafeEq };
