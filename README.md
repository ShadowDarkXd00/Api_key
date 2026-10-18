# ◢ SHADOW — License Key Server

Self-hosted license / API-key system for your apps. Runs on **Vercel** (zero-dependency Node serverless functions) and stores its database in **this GitHub repo** (`data/db.json`) — no database account needed.

- **Admin panel** (`SHADOW`) at the project root: create keys, set expiry / max uses / max devices, see every activated device, revoke, reset, audit log.
- **Public API** your apps call to verify a key + register a device.

## Key format

- **Auto keys** (default): `SHADOW-XXXXX-XXXXX-XXXXX` (random, unambiguous alphabet, no `O/0/I/1`)
- **Custom keys**: anything you want, e.g. `SHADOW-MYAPP-LIFETIME` — `A–Z 0–9 - _`, 8–80 chars, case-insensitive.

## Using the API from your app

Base URL: your Vercel project URL.

### Activate / check in

```
POST /api/license/verify
Content-Type: application/json

{
  "apiKey":   "SHADOW-XXXXX-XXXXX-XXXXX",
  "deviceId": "my-pc-01",
  "deviceMeta": { "app": "MyApp", "appVersion": "1.2.0", "platform": "windows" }
}
```

A successful check **consumes 1 use** and **registers the device** (first time only).
`deviceId` must be **stable and unique per machine** — generate a UUID once in your app and store it in the app's settings/storage. It is hashed (SHA-256) before being stored, and is case-insensitive.

**Response (valid):**

```json
{
  "valid": true,
  "key": "SHADOW-XXXXX-XXXXX-XXXXX",
  "expiresAt": null,
  "usesUsed": 3,
  "usesLeft": null,
  "deviceCount": 1,
  "maxDevices": null,
  "deviceRegistered": true,
  "message": "OK"
}
```

**Response (invalid):**

```json
{ "valid": false, "reason": "expired", "message": "This license has expired." }
```

`reason` is one of: `invalid_key` · `revoked` · `expired` · `max_uses` · `max_devices` · `missing_key` · `rate_limited`

### Status check (no side effects)

```
GET /api/license/verify?apiKey=SHADOW-XXXXX-XXXXX-XXXXX
```

### Examples

**JavaScript (browser / Node):**

```js
const res = await fetch(`${BASE}/api/license/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ apiKey, deviceId: myDeviceId() }),
});
const r = await res.json();
if (!r.valid) {
  // show r.message and lock the feature
  console.error(r.reason, r.message);
  return;
}
```

**Python:**

```python
import requests, json

def verify(base: str, api_key: str, device_id: str) -> bool:
    r = requests.post(f"{base}/api/license/verify",
                      json={"apiKey": api_key, "deviceId": device_id}, timeout=15)
    data = r.json()
    if not data.get("valid"):
        print("License error:", data.get("message"))
        return False
    return True
```

**curl:**

```bash
curl -X POST https://YOUR-APP.vercel.app/api/license/verify \
  -H 'Content-Type: application/json' \
  -d '{"apiKey":"SHADOW-XXXXX-XXXXX-XXXXX","deviceId":"my-pc-01"}'
```

## Admin panel (SHADOW)

Open the project URL and unlock with your admin password.

- **Dashboard** — active/total keys, devices activated, total uses, expiring-soon, 24 h activity, quick verify test.
- **Keys** — search, create (auto `SHADOW-…` or fully custom), edit expiry/uses/devices/note, revoke / re-activate, **reset uses**, **clear devices**, delete.
- **Devices** — every activated device across all keys: first/last seen, check count, meta.
- **Activity** — full audit log (verifications ok/fail, new devices, key changes), auto-refresh.

## Environment variables (Vercel project settings)

| Variable | Required | Meaning |
|---|---|---|
| `SHADOW_ADMIN_PASSWORD` | ✅ | Admin panel password. |
| `SHADOW_SESSION_SECRET` | ✅ | Long random string (32+ chars) — signs panel sessions. |
| `GITHUB_REPO` | ✅ | `owner/repo` that holds the DB file (this repo). |
| `GITHUB_REF` | ✅ | Branch that holds `data/db.json` (the branch Vercel reads/writes). |
| `GITHUB_TOKEN` | ✅ for saving | Fine-grained **Personal Access Token** with **Contents: Read and write** on this repo only. Needed to persist keys/devices. |

### Creating the token (1 min)

1. GitHub → **Settings → Developer settings → Fine-grained personal access tokens → Generate new token**
2. Repository access → *Only select this repository*
3. Permissions → **Contents: Read and write** (everything else: no access)
4. Generate, copy it, and set it as `GITHUB_TOKEN` in **Vercel → Project → Settings → Environment Variables**.
5. **Redeploy** the project (Deployments → ⋯ → Redeploy) so the new env is picked up.

> Until `GITHUB_TOKEN` is set, the panel loads but **saving** keys/devices will fail with a clear error.

## How storage works

Vercel functions are stateless, so the DB is a JSON file committed to this repo:

- Reads → `raw.githubusercontent.com` (CDN, fast, cached ~3 s in-process)
- Writes → GitHub Contents API with blob-`sha` compare-and-swap (concurrent writes are retried automatically)
- Every save is a small commit on `GITHUB_REF` (message `chore(db): sync license database [shadow]`) — the whole license history is versioned in Git.

⚠️ **After you merge this branch into `main`**: update `GITHUB_REF` to `main` in Vercel and redeploy, and make sure `data/db.json` is in `main` (it is, if you merge this branch).

Limits to keep in mind: GitHub API = 5 000 requests/h with a token — plenty for personal use. The DB file should stay well under a few MB (logs are capped at 500 entries; devices grow per key).

## Local development

```bash
# local file storage (data/db.json) — no GitHub needed:
SHADOW_ADMIN_PASSWORD=secret SHADOW_SESSION_SECRET=0123456789abcdef0123456789abcdef node scripts/local-server.js

# or full GitHub-backed mode (uses this repo, exactly like production):
GITHUB_REPO=ShadowDarkXd00/Api_key GITHUB_REF=<branch> GITHUB_TOKEN=ghp_xxx \
SHADOW_ADMIN_PASSWORD=secret SHADOW_SESSION_SECRET=... node scripts/local-server.js
```

Then open http://localhost:3000.

## Files

```
api/admin/*          panel endpoints (login, keys, stats, devices, logs)
api/license/verify   public verification endpoint
lib/                 storage (GitHub/file), auth (HMAC sessions), crypto, http helpers
public/              SHADOW admin panel (vanilla JS, no build step)
data/db.json         the database (versioned in this repo)
scripts/local-server.js  local dev server
```
