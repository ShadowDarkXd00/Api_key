'use strict';
const { hmacSign, timingSafeEq, randomToken } = require('./crypto');
const { sendJSON } = require('./http');

const COOKIE = 'shadow_session';
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sessionSecret() {
  const s = process.env.SHADOW_SESSION_SECRET || '';
  if (!s) {
    throw Object.assign(new Error('SHADOW_SESSION_SECRET is not configured on the server.'), { status: 500 });
  }
  return s;
}

function adminPassword() {
  return process.env.SHADOW_ADMIN_PASSWORD || '';
}

function issueToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + COOKIE_TTL_MS, n: randomToken(8) })
  ).toString('base64url');
  return `${payload}.${hmacSign(sessionSecret(), payload)}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  let expected;
  try {
    expected = hmacSign(sessionSecret(), payload);
  } catch {
    return false;
  }
  if (!timingSafeEq(expected, sig)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function getCookie(req, name) {
  const raw = req.headers && req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Returns true when the request is authenticated; otherwise sends 401 and returns false. */
function requireAuth(req, res) {
  if (!verifyToken(getCookie(req, COOKIE))) {
    sendJSON(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function setSessionCookie(res, token, maxAgeMs = COOKIE_TTL_MS) {
  const secure = process.env.VERCEL === '1' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = {
  COOKIE,
  COOKIE_TTL_MS,
  adminPassword,
  issueToken,
  verifyToken,
  getCookie,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
};
