'use strict';
/**
 * Storage layer for the SHADOW license database.
 *
 * Production (Vercel): the DB is a JSON file living in this GitHub repo
 *   (data/db.json on the branch in GITHUB_REF).
 *   - reads  → raw.githubusercontent.com (CDN, no rate limit, no token needed for public repos)
 *   - writes → GitHub Contents API with sha compare-and-swap (needs GITHUB_TOKEN)
 *
 * Local dev: plain file on disk (data/db.json, or SHADOW_LOCAL_DB override).
 */
const fs = require('fs');
const path = require('path');

const REPO = (process.env.GITHUB_REPO || '').trim();
const REF = (process.env.GITHUB_REF || 'main').trim();
const TOKEN = (process.env.GITHUB_TOKEN || '').trim();
const DB_FILE = 'data/db.json';
const EMPTY_DB = { version: 1, keys: {}, logs: [] };

const IS_GITHUB = /^[\w.-]+\/[\w.-]+$/.test(REPO);
const LOCAL_FILE = process.env.SHADOW_LOCAL_DB || path.join(__dirname, '..', 'data', 'db.json');
const READ_TTL_MS = 3000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_WRITE_ATTEMPTS = 5;

let cache = { db: null, at: 0 };

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

function sanitize(db) {
  if (!db || typeof db !== 'object') db = clone(EMPTY_DB);
  if (!db.keys || typeof db.keys !== 'object') db.keys = {};
  if (!Array.isArray(db.logs)) db.logs = [];
  db.version = 1;
  return db;
}

function tokenUsable() {
  return TOKEN.length > 0 && !/^PASTE_/i.test(TOKEN);
}

function ghHeaders(withToken) {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'shadow-license-server' };
  if (withToken && tokenUsable()) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Read the raw file from GitHub (CDN). Returns null when it does not exist yet. */
async function ghFetchRaw() {
  const url = `https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(REF)}/${DB_FILE}`;
  const r = await fetchWithTimeout(url, { headers: { Accept: 'text/plain' } });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw Object.assign(new Error(`GitHub read failed (HTTP ${r.status}). Check GITHUB_REPO and GITHUB_REF.`), { status: 502 });
  }
  const text = await r.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('data/db.json on GitHub is not valid JSON.'), { status: 502 });
  }
}

/** Fetch current blob sha + content in one call (for conflict-safe writes). */
async function ghFetchMeta() {
  const url = `https://api.github.com/repos/${REPO}/contents/${DB_FILE}?ref=${encodeURIComponent(REF)}`;
  const r = await fetchWithTimeout(url, { headers: ghHeaders(false) });
  if (r.status === 404) return null;
  if (!r.ok) {
    throw Object.assign(
      new Error(`GitHub metadata fetch failed (HTTP ${r.status}). Check GITHUB_REPO/GITHUB_REF; for private repos set GITHUB_TOKEN.`),
      { status: 502 }
    );
  }
  const j = await r.json();
  let content = null;
  if (j.content) {
    try {
      content = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
    } catch {
      content = null;
    }
  }
  return { sha: j.sha || null, content };
}

/** Write the file. Returns { conflict: true } when the base sha is stale. */
async function ghWrite(content, baseSha) {
  const url = `https://api.github.com/repos/${REPO}/contents/${DB_FILE}`;
  const body = {
    message: 'chore(db): sync license database [shadow]',
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: REF,
  };
  if (baseSha) body.sha = baseSha;
  const r = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: ghHeaders(true),
    body: JSON.stringify(body),
  });
  if (r.status === 409) return { conflict: true };
  if (!r.ok) {
    let detail = '';
    try {
      const j = await r.json();
      if (j && j.message) detail = ` — ${j.message}`;
    } catch {
      /* ignore */
    }
    throw Object.assign(
      new Error(
        `GitHub write failed (HTTP ${r.status})${detail}. Writing the database needs a GITHUB_TOKEN with Contents: Read and write access to ${REPO}.`
      ),
      { status: 502 }
    );
  }
  return { conflict: false };
}

function localRead() {
  try {
    const t = fs.readFileSync(LOCAL_FILE, 'utf8');
    return t.trim() ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function localWrite(content) {
  fs.mkdirSync(path.dirname(LOCAL_FILE), { recursive: true });
  fs.writeFileSync(LOCAL_FILE, content);
}

/**
 * Load the database (short in-process cache so a burst of requests does not
 * hammer GitHub).
 */
async function loadDB(force = false) {
  if (!force && cache.db && Date.now() - cache.at < READ_TTL_MS) return clone(cache.db);
  const raw = IS_GITHUB ? await ghFetchRaw() : localRead();
  const db = sanitize(raw || clone(EMPTY_DB));
  cache = { db: clone(db), at: Date.now() };
  return db;
}

/**
 * Atomically read-modify-write the database.
 * mutator(startingDB) → nextDB (return falsy to skip the write, e.g. no changes).
 */
async function saveDB(mutator) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const base = IS_GITHUB ? await ghFetchMeta() : null;
    const fromBase = IS_GITHUB ? (base ? base.content : null) : localRead();
    const start = sanitize(fromBase || clone(EMPTY_DB));
    const next = mutator(start);
    if (!next) return start;
    const content = JSON.stringify(next, null, 2);
    if (IS_GITHUB) {
      const { conflict } = await ghWrite(content, base && base.sha);
      if (conflict) continue; // someone wrote concurrently — retry with fresh data
    } else {
      localWrite(content);
    }
    cache = { db: clone(next), at: Date.now() };
    return next;
  }
  throw Object.assign(new Error('Database write conflict — another request was writing at the same time. Please retry.'), { status: 503 });
}

module.exports = { loadDB, saveDB, IS_GITHUB, DB_FILE, REPO, REF, tokenUsable };
