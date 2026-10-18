'use strict';
const { sendJSON, corsHeaders } = require('../../lib/http');
const { requireAuth } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (!requireAuth(req, res)) return;
  return sendJSON(res, 200, { ok: true });
};
