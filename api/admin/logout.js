'use strict';
const { sendJSON, corsHeaders } = require('../../lib/http');
const { clearSessionCookie } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (req.method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });
  clearSessionCookie(res);
  return sendJSON(res, 200, { ok: true });
};
