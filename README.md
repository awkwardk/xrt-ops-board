# XRT Ops Board

Mobile-first daily operations board for **Xtreme Electronic Recycling** (The King of Recycling). Team members at three locations (Cole, Dayton, Visalia) post updates, attach photos, and see what to work on, what to avoid, and what's done.

Single-file Node.js app — no external packages, only built-in `http`, `https`, `fs`, `path`.

## Run locally

```bash
node server.js
# open http://localhost:3000
```

Port comes from `process.env.PORT` or defaults to `3000`.

## Test

```bash
node ops-test.js server.js
```

Runs 7 integration checks (ping, posts, team, create/delete, PIN change). All must pass.

## Access

Two PIN levels, entered on first load (stored in `localStorage` as the access level only):

| Level | Default PIN | Capabilities |
|-------|-------------|--------------|
| Staff | `7823` | View feed, post updates with photos |
| Admin | `9241` | + delete, pin, manage team, change PINs |

Admins: Marc, Kendall, Manuel. Admins can change both PINs from the in-app settings panel (gear icon).

## Deployment (Render free tier)

- Web service (Starter tier), build command: _none_, start command: `node server.js`
- Render injects `PORT`.
- **Persistent disk** mounted at `/data` (5GB). Data **survives restarts**.
- Point **UptimeRobot** at `/ping` (every 5 min) to keep the service awake.

### Persistent storage

Data access goes through `loadData()` / `saveData()`. On startup the app creates `/data/ops-data/` (and `/data/ops-data/photos/`) and loads:

- `/data/ops-data/posts.json` — posts (each stores photo **filenames**, not image bytes)
- `/data/ops-data/team.json` — team members (seeded with defaults if missing)
- `/data/ops-data/settings.json` — staff/admin PINs (defaults if missing)
- `/data/ops-data/photos/` — uploaded image files, named `[unix-seconds]-[rand4].[ext]`

`saveData()` (sync JSON writes, wrapped in try/catch) runs after every create / delete / pin / team / settings change. Set `OPS_DATA_DIR` to override the base path (the test harness points it at a temp dir).

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | Single-page app |
| GET | `/ping` | `{ status: "ok" }` keepalive |
| GET | `/api/posts?location=Cole` | Filter by location (`All` for everything); pinned first, then newest |
| POST | `/api/posts` | `multipart/form-data`: author, location, tag, text, photos (≤8, ≤3MB each, saved to disk) |
| GET | `/api/photo/:filename` | Serves a photo file from disk (correct `Content-Type`, 404 if missing) |
| DELETE | `/api/posts/:id` | Admin (header `X-Access-Level: admin`); also deletes the post's photo files |
| POST | `/api/posts/:id/pin` | Admin — toggle pin |
| GET | `/api/team` | Team list |
| POST | `/api/team` | Admin — add member |
| DELETE | `/api/team/:name` | Admin — remove member |
| GET | `/api/settings` | Admin — current PINs |
| POST | `/api/settings/pins` | Admin — change PINs |
| POST | `/api/verify-pin` | Verify a typed PIN, returns access level |

Admin-only actions are enforced **server-side** via the `X-Access-Level: admin` header.
