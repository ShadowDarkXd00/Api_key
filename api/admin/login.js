'use strict';
const { readJSON, sendJSON, clientIp, corsHeaders } = require('../../lib/http');
const { timingSafeEq } = require('../../lib/crypto');
const { adminPassword, issueToken, setSessionCookie } = require('../../lib/auth');

const attempts = new Map(); // ip → [timestamps]
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function registerAttempt(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
  return list.length >= MAX_ATTEMPTS;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });

  let body;
  try {
    body = await readJSON(req);
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }

  const pw = adminPassword();
  if (!pw) {
    return sendJSON(res, 500, {
      error:
        'Admin password is not configured on the server. Set the SHADOW_ADMIN_PASSWORD environment variable in the Vercel project settings.',
    });
  }

  const ok = typeof body.password === 'string' && body.password.length > 0 && timingSafeEq(pw, body.password);
  if (!ok) {
    const blocked = registerAttempt(clientIp(req));
    if (blocked) return sendJSON(res, 429, { error: 'Too many failed attempts. Please wait 15 minutes.' });
    return sendJSON(res, 401, { error: 'Wrong password.' });
  }

  attempts.delete(clientIp(req));
  setSessionCookie(res, issueToken());
  return sendJSON(res, 200, { ok: true });
};
