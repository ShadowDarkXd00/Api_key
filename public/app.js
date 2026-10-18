'use strict';
/* ================= SHADOW admin panel ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

const state = { tab: 'dashboard', keys: [], currentKey: null, createMode: 'auto', autoTimer: null };

const esc = (s) =>
  String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

function fmtDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function relTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  if (isNaN(diff)) return null;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const dd = Math.floor(h / 24);
  if (dd < 30) return dd + 'd ago';
  return fmtDate(iso);
}
const isoToLocal = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localToIso = (v) => (v ? new Date(v).toISOString() : '');
const fmtUses = (k) => `${k.usesCount} / ${k.maxUses == null ? '∞' : k.maxUses}`;
const fmtDev = (k) => `${k.deviceCount} / ${k.maxDevices == null ? '∞' : k.maxDevices}`;

function statusChip(k) {
  const eff = k.effective || k.status;
  const cls = eff === 'active' ? 'ok' : eff === 'expired' ? 'warn' : 'bad';
  return `<span class="chip ${cls}">${esc(eff)}</span>`;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3800);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-json */ }
  if (res.status === 401 && !path.includes('/login')) {
    showLogin();
    throw new Error('Session expired — log in again.');
  }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || 'HTTP ' + res.status);
  return data;
}

function copyText(text) {
  const done = () => toast('Copied to clipboard');
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copy failed — select manually', true); }
  ta.remove();
}

/* ================= session ================= */
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  clearInterval(state.autoTimer);
  setTimeout(() => $('#pw').focus(), 50);
}
function showApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  setTab(state.tab);
}

$('#api-base').textContent = location.origin;
$('#docs-base').textContent = location.origin;

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('#pw').value }) });
    $('#pw').value = '';
    state.tab = 'dashboard';
    showApp();
    toast('Welcome back to SHADOW');
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* ignore */ }
  showLogin();
});

/* ================= tabs ================= */
$$('#tabs button').forEach((b) => {
  b.addEventListener('click', () => setTab(b.dataset.tab));
});
function setTab(t) {
  state.tab = t;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t));
  clearInterval(state.autoTimer);
  if (t === 'dashboard') loadDashboard();
  if (t === 'keys') loadKeys();
  if (t === 'devices') loadDevices();
  if (t === 'activity') {
    loadLogs();
    if ($('#log-autorefresh').checked) state.autoTimer = setInterval(loadLogs, 15000);
  }
}

/* ================= dashboard ================= */
async function loadDashboard() {
  try {
    const [stats, logs] = await Promise.all([api('/api/admin/stats'), api('/api/admin/logs?limit=10')]);
    renderStats(stats);
    renderRecent(logs.logs);
  } catch (e) {
    if (!String(e.message).includes('Session expired')) toast(e.message, true);
  }
}
function renderStats({ stats: s, last24h }) {
  const cards = [
    ['Active keys', s.active],
    ['Total keys', s.total],
    ['Devices activated', s.devices],
    ['Total uses', s.uses],
    ['Expiring ≤ 7 days', s.expiringSoon],
    ['Checks 24 h (ok / fail)', `${last24h.ok} / ${last24h.fail}`],
  ];
  $('#stat-cards').innerHTML = cards
    .map(([label, val]) => `<div class="card"><div class="card-val">${esc(val)}</div><div class="card-label">${esc(label)}</div></div>`)
    .join('');
}
function logDetails(l) {
  switch (l.type) {
    case 'verify_fail':
      return `reason: ${esc(l.reason || '?')}${l.device ? ' · dev ' + esc(l.device) : ''}`;
    case 'verify_ok':
      return `uses ${esc(l.uses)} · devices ${esc(l.devices)}${l.device ? ' · dev ' + esc(l.device) : ''}`;
    case 'device_activated':
      return esc(l.device || '') + (l.meta ? ' ' + esc(JSON.stringify(l.meta)) : '');
    default:
      return esc(l.key || '');
  }
}
function renderRecent(logs) {
  const el = $('#recent-logs');
  if (!logs.length) {
    el.innerHTML = '<p class="muted small">Nothing yet — events will show up here.</p>';
    return;
  }
  el.innerHTML = logs
    .map(
      (l) =>
        `<div class="logline"><span class="t">${esc((l.ts || '').slice(11, 16))}</span><span class="type-chip ${esc(l.type)}">${esc(l.type.replace('_', ' '))}</span><span class="d">${esc(l.key || '')} — ${logDetails(l)}</span></div>`
    )
    .join('');
}
$('#dash-refresh').addEventListener('click', loadDashboard);

$('#test-btn').addEventListener('click', async () => {
  const out = $('#test-out');
  out.classList.remove('hidden');
  out.textContent = '…';
  try {
    const r = await fetch('/api/license/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: $('#test-key').value.trim(), deviceId: $('#test-device').value.trim() }),
    });
    out.textContent = JSON.stringify(await r.json(), null, 2);
  } catch (e) {
    out.textContent = 'Error: ' + e.message;
  }
});

/* ================= keys ================= */
async function loadKeys() {
  try {
    const { keys } = await api('/api/admin/keys');
    state.keys = keys;
    renderKeys();
  } catch (e) {
    if (!String(e.message).includes('Session expired')) toast(e.message, true);
  }
}
function renderKeys() {
  const q = ($('#key-search').value || '').trim().toUpperCase();
  const rows = state.keys.filter((k) => !q || k.key.includes(q));
  $('#keys-tbody').innerHTML = rows
    .map(
      (k) => `
    <tr data-key="${esc(k.key)}">
      <td><span class="keycell"><code title="${esc(k.key)}">${esc(k.key)}</code><button class="copy" title="Copy key">⧉</button></span></td>
      <td>${statusChip(k)}${k.note ? `<div class="muted small" title="${esc(k.note)}">${esc(k.note.slice(0, 28))}${k.note.length > 28 ? '…' : ''}</div>` : ''}</td>
      <td>${k.expiresAt ? esc(fmtDate(k.expiresAt)) : '<span class="muted">never</span>'}</td>
      <td>${esc(fmtUses(k))}</td>
      <td>${esc(fmtDev(k))}</td>
      <td>${k.lastUsedAt ? esc(relTime(k.lastUsedAt)) : '<span class="muted">—</span>'}</td>
      <td class="actions">
        <button class="btn ghost sm" title="Manage">⚙</button>
        <button class="btn ghost sm" title="${k.status === 'active' ? 'Revoke' : 'Re-activate'}">${k.status === 'active' ? '⊘' : '✓'}</button>
        <button class="btn ghost sm" title="Delete">🗑</button>
      </td>
    </tr>`
    )
    .join('');
  $('#keys-empty').classList.toggle('hidden', rows.length > 0);
}
$('#key-search').addEventListener('input', renderKeys);

$('#keys-tbody').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const key = tr.dataset.key;
  if (e.target.closest('.copy')) { e.stopPropagation(); return copyText(key); }
  if (e.target.closest('.del')) {
    e.stopPropagation();
    if (!confirm(`Delete ${key} permanently?\nAll device activations and history for this key will be lost.`)) return;
    try {
      await api(`/api/admin/keys?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      toast('Key deleted');
      loadKeys();
    } catch (err) { toast(err.message, true); }
    return;
  }
  if (e.target.closest('.btn')) {
    const btn = e.target.closest('.btn');
    const title = btn.title;
    if (title === 'Revoke' || title === 'Re-activate') {
      e.stopPropagation();
      const next = title === 'Revoke' ? 'revoked' : 'active';
      if (!confirm(next === 'revoked' ? `Revoke ${key}?\nApps will be locked out immediately.` : `Re-activate ${key}?`)) return;
      try {
        await api(`/api/admin/keys?key=${encodeURIComponent(key)}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
        toast(next === 'revoked' ? 'Key revoked' : 'Key re-activated');
        loadKeys();
      } catch (err) { toast(err.message, true); }
    }
    return; // manage handled by row click below
  }
  openManage(key);
});

/* ================= create key modal ================= */
function openCreate() {
  $('#create-form-view').classList.remove('hidden');
  $('#create-success').classList.add('hidden');
  $('#create-foot').classList.remove('hidden');
  $('#create-error').textContent = '';
  $('#c-custom').value = '';
  $('#c-note').value = '';
  $('#c-expiry').value = '';
  setCheckPair('c-expiry-never', 'c-expiry', true);
  setCheckPair('c-maxuses-inf', 'c-maxuses', true);
  setCheckPair('c-maxdevices-inf', 'c-maxdevices', true);
  setCreateMode('auto');
  $('#modal-create').classList.remove('hidden');
  regenPreview();
}
function setCheckPair(neverId, inputId, neverOn) {
  $('#' + neverId).checked = neverOn;
  $('#' + inputId).disabled = neverOn;
  if (neverOn) $('#' + inputId).value = '';
}
function setCreateMode(mode) {
  state.createMode = mode;
  $('#mode-auto').classList.toggle('active', mode === 'auto');
  $('#mode-custom').classList.toggle('active', mode === 'custom');
  $('#auto-fields').classList.toggle('hidden', mode !== 'auto');
  $('#custom-fields').classList.toggle('hidden', mode !== 'custom');
}
$('#mode-auto').addEventListener('click', () => setCreateMode('auto'));
$('#mode-custom').addEventListener('click', () => setCreateMode('custom'));
$('#c-prefix').addEventListener('input', regenPreview);
$('#c-regen').addEventListener('click', regenPreview);
function regenPreview() {
  const prefix = ($('#c-prefix').value.trim().toUpperCase() || 'SHADOW').slice(0, 20);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const g = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  $('#c-preview').textContent = `${prefix}-${g()}-${g()}-${g()}`;
}
$('#create-btn').addEventListener('click', openCreate);

['c-expiry-never', 'c-maxuses-inf', 'c-maxdevices-inf'].forEach((id) => {
  $('#' + id).addEventListener('change', (e) => {
    const never = e.target.checked;
    if (id === 'c-expiry-never') setCheckPair('c-expiry-never', 'c-expiry', never);
    if (id === 'c-maxuses-inf') setCheckPair('c-maxuses-inf', 'c-maxuses', never);
    if (id === 'c-maxdevices-inf') setCheckPair('c-maxdevices-inf', 'c-maxdevices', never);
  });
});

$('#create-submit').addEventListener('click', async () => {
  $('#create-error').textContent = '';
  const payload = {
    mode: state.createMode,
    prefix: $('#c-prefix').value,
    key: $('#c-custom').value,
    note: $('#c-note').value,
    expiresAt: $('#c-expiry-never').checked ? '' : localToIso($('#c-expiry').value),
    maxUses: $('#c-maxuses-inf').checked ? '' : $('#c-maxuses').value,
    maxDevices: $('#c-maxdevices-inf').checked ? '' : $('#c-maxdevices').value,
  };
  try {
    const r = await api('/api/admin/keys', { method: 'POST', body: JSON.stringify(payload) });
    $('#created-key').textContent = r.key.key;
    $('#create-form-view').classList.add('hidden');
    $('#create-foot').classList.add('hidden');
    $('#create-success').classList.remove('hidden');
    state.lastCreated = r.key.key;
    toast('Key created');
    if (state.tab === 'keys') loadKeys();
  } catch (e) {
    $('#create-error').textContent = e.message;
  }
});
$('#copy-created').addEventListener('click', () => copyText(state.lastCreated || $('#created-key').textContent));
$('#test-created').addEventListener('click', () => {
  $('#test-key').value = state.lastCreated || $('#created-key').textContent;
  $('#test-device').value = $('#test-device').value || 'test-device-01';
  setTab('dashboard');
  setTimeout(() => $('#test-btn').click(), 250);
});

/* ================= manage key modal ================= */
async function openManage(key) {
  try {
    const { key: d } = await api(`/api/admin/keys?key=${encodeURIComponent(key)}`);
    state.currentKey = d;
    $('#m-key').textContent = d.key;
    $('#m-chips').innerHTML =
      statusChip(d) +
      `<span class="chip info">${esc(d.source)} key</span>` +
      `<span class="chip info">created ${esc(fmtDate(d.createdAt))}</span>`;
    const hasExp = !!d.expiresAt;
    setCheckPair('m-expiry-never', 'm-expiry', !hasExp);
    if (hasExp) $('#m-expiry').value = isoToLocal(d.expiresAt);
    setCheckPair('m-maxuses-inf', 'm-maxuses', d.maxUses == null);
    if (d.maxUses != null) $('#m-maxuses').value = d.maxUses;
    setCheckPair('m-maxdevices-inf', 'm-maxdevices', d.maxDevices == null);
    if (d.maxDevices != null) $('#m-maxdevices').value = d.maxDevices;
    $('#m-note').value = d.note || '';
    $('#m-error').textContent = '';
    $('#m-toggle-status').textContent = d.status === 'active' ? '⊘ Revoke key' : '✓ Re-activate key';
    renderManageDevices(d.devices);
    $('#modal-manage').classList.remove('hidden');
  } catch (e) {
    toast(e.message, true);
  }
}
function renderManageDevices(devices) {
  $('#m-device-count').textContent = devices.length ? `(${devices.length})` : '';
  $('#m-devices-empty').classList.toggle('hidden', devices.length > 0);
  $('#m-devices').innerHTML = devices
    .map(
      (d) => `
    <tr>
      <td><code>${esc(d.hash.slice(0, 16))}…</code></td>
      <td>${esc(fmtDate(d.firstSeen))}</td>
      <td>${esc(fmtDate(d.lastSeen))} <span class="muted small">(${esc(relTime(d.lastSeen))})</span></td>
      <td>${esc(d.verifies)}</td>
      <td class="meta-cell" title="${esc(JSON.stringify(d.meta || {}))}">${d.meta ? esc(JSON.stringify(d.meta)) : '<span class="muted">—</span>'}</td>
    </tr>`
    )
    .join('');
}
['m-expiry-never', 'm-maxuses-inf', 'm-maxdevices-inf'].forEach((id) => {
  $('#' + id).addEventListener('change', (e) => {
    const never = e.target.checked;
    if (id === 'm-expiry-never') setCheckPair('m-expiry-never', 'm-expiry', never);
    if (id === 'm-maxuses-inf') setCheckPair('m-maxuses-inf', 'm-maxuses', never);
    if (id === 'm-maxdevices-inf') setCheckPair('m-maxdevices-inf', 'm-maxdevices', never);
  });
});
function managePayload() {
  return {
    expiresAt: $('#m-expiry-never').checked ? '' : localToIso($('#m-expiry').value),
    maxUses: $('#m-maxuses-inf').checked ? '' : $('#m-maxuses').value,
    maxDevices: $('#m-maxdevices-inf').checked ? '' : $('#m-maxdevices').value,
    note: $('#m-note').value,
  };
}
async function patchCurrent(extra) {
  const p = { ...managePayload(), ...extra };
  await api(`/api/admin/keys?key=${encodeURIComponent(state.currentKey.key)}`, { method: 'PATCH', body: JSON.stringify(p) });
}
$('#m-save').addEventListener('click', async () => {
  $('#m-error').textContent = '';
  try {
    await patchCurrent({});
    toast('Changes saved');
    openManage(state.currentKey.key);
    loadKeys();
  } catch (e) {
    $('#m-error').textContent = e.message;
  }
});
$('#m-toggle-status').addEventListener('click', async () => {
  const next = state.currentKey.status === 'active' ? 'revoked' : 'active';
  if (!confirm(next === 'revoked' ? 'Revoke this key? Apps will be locked out immediately.' : 'Re-activate this key?')) return;
  try {
    await api(`/api/admin/keys?key=${encodeURIComponent(state.currentKey.key)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: next }),
    });
    toast(next === 'revoked' ? 'Key revoked' : 'Key re-activated');
    openManage(state.currentKey.key);
    loadKeys();
  } catch (e) { toast(e.message, true); }
});
$('#m-reset-uses').addEventListener('click', async () => {
  if (!confirm('Reset the used-count of this key back to 0?')) return;
  try {
    await patchCurrent({ resetUses: true });
    toast('Uses reset');
    openManage(state.currentKey.key);
    loadKeys();
  } catch (e) { toast(e.message, true); }
});
$('#m-clear-devices').addEventListener('click', async () => {
  if (!confirm('Remove ALL activated devices for this key?\nThey will be able to re-activate (if the device limit allows).')) return;
  try {
    await patchCurrent({ clearDevices: true });
    toast('Devices cleared');
    openManage(state.currentKey.key);
    loadKeys();
  } catch (e) { toast(e.message, true); }
});
$('#m-delete').addEventListener('click', async () => {
  if (!confirm(`Delete ${state.currentKey.key} permanently? This cannot be undone.`)) return;
  try {
    await api(`/api/admin/keys?key=${encodeURIComponent(state.currentKey.key)}`, { method: 'DELETE' });
    toast('Key deleted');
    $('#modal-manage').classList.add('hidden');
    loadKeys();
  } catch (e) { toast(e.message, true); }
});

/* ================= devices tab ================= */
async function loadDevices() {
  try {
    const { total, devices } = await api('/api/admin/devices');
    $('#devices-tbody').innerHTML = devices
      .map(
        (d) => `
      <tr>
        <td><code>${esc(d.device.slice(0, 16))}…</code></td>
        <td><code>${esc(d.key)}</code></td>
        <td>${esc(fmtDate(d.firstSeen))}</td>
        <td>${esc(fmtDate(d.lastSeen))} <span class="muted small">(${esc(relTime(d.lastSeen))})</span></td>
        <td>${esc(d.verifies)}</td>
        <td class="meta-cell" title="${esc(JSON.stringify(d.meta || {}))}">${d.meta ? esc(JSON.stringify(d.meta)) : '<span class="muted">—</span>'}</td>
      </tr>`
      )
      .join('');
    $('#devices-empty').classList.toggle('hidden', total > 0);
  } catch (e) {
    if (!String(e.message).includes('Session expired')) toast(e.message, true);
  }
}

/* ================= activity tab ================= */
async function loadLogs() {
  try {
    const type = $('#log-filter').value;
    const { logs } = await api('/api/admin/logs?limit=200' + (type ? `&type=${encodeURIComponent(type)}` : ''));
    $('#logs-tbody').innerHTML = logs
      .map(
        (l) => `
      <tr>
        <td style="white-space:nowrap">${esc(fmtDate(l.ts))}</td>
        <td><span class="type-chip ${esc(l.type)}">${esc(l.type.replace('_', ' '))}</span></td>
        <td><code>${esc(l.key || '')}</code></td>
        <td class="muted small">${logDetails(l)}</td>
      </tr>`
      )
      .join('');
    $('#logs-empty').classList.toggle('hidden', logs.length > 0);
  } catch (e) {
    if (!String(e.message).includes('Session expired')) toast(e.message, true);
  }
}
$('#logs-refresh').addEventListener('click', loadLogs);
$('#log-filter').addEventListener('change', loadLogs);
$('#log-autorefresh').addEventListener('change', () => {
  clearInterval(state.autoTimer);
  if ($('#log-autorefresh').checked && state.tab === 'activity') state.autoTimer = setInterval(loadLogs, 15000);
});

/* ================= modals: open/close wiring ================= */
$('#docs-btn').addEventListener('click', () => $('#modal-docs').classList.remove('hidden'));
$$('.modal-wrap').forEach((wrap) => {
  wrap.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', () => wrap.classList.add('hidden'));
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal-wrap').forEach((w) => w.classList.add('hidden'));
});

/* ================= init ================= */
(async function init() {
  try {
    await api('/api/admin/session');
    showApp();
  } catch {
    showLogin();
  }
})();
