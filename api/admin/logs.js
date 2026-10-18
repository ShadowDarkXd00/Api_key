'use strict';
const { sendJSON, parseQuery, corsHeaders } = require('../../lib/http');
const { requireAuth } = require('../../lib/auth');
const storage = require('../../lib/storage');

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    return res.end();
  }
  if (!requireAuth(req, res)) return;

  try {
    const db = await storage.loadDB();
    const q = parseQuery(req);
    let logs = db.logs.slice(0, 500);
    if (q.type) logs = logs.filter((l) => l.type === q.type);
    const limit = Math.min(500, Math.max(1, parseInt(q.limit, 10) || 100));
    logs = logs.slice(0, limit);
    return sendJSON(res, 200, { logs });
  } catch (e) {
    return sendJSON(res, e.status || 500, { error: e.message || 'Server error' });
  }
};
