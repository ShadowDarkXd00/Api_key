'use strict';
/**
 * Local development server for SHADOW.
 * Serves the admin panel (public/) and the API (api/) exactly like Vercel would.
 *
 *   node scripts/local-server.js
 *
 * Env:
 *   PORT               (default 3000)
 *   SHADOW_ADMIN_PASSWORD   admin panel password
 *   SHADOW_SESSION_SECRET   random string for session cookies
 *   GITHUB_REPO / GITHUB_REF / GITHUB_TOKEN  → GitHub-backed storage
 *   (unset GITHUB_REPO  → local file storage in data/db.json)
 *   SHADOW_LOCAL_DB    (optional) alternate local DB file path
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function safeJoin(base, target) {
  const p = path.normalize(path.join(base, target));
  return p.startsWith(base) ? p : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      pathname = url.pathname;
    }

    // ---- API ----
    if (pathname.startsWith('/api/')) {
      const base = safeJoin(path.join(ROOT, 'api'), pathname.slice(5));
      let handlerFile = null;
      for (const candidate of [base, base + '.js']) {
        if (candidate && candidate.endsWith('.js') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          handlerFile = candidate;
          break;
        }
      }
      if (handlerFile) {
        const handler = require(handlerFile);
        return await handler(req, res);
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Not found' }));
    }

    // ---- static ----
    const rel = pathname === '/' ? '/index.html' : pathname;
    const file = safeJoin(path.join(ROOT, 'public'), rel);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    return res.end(fs.readFileSync(file));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ◢ SHADOW license server (local dev)`);
  console.log(`  Panel:  http://localhost:${PORT}/`);
  console.log(`  API:    http://localhost:${PORT}/api/license/verify\n`);
});
