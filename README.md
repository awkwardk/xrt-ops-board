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

- Web service, build command: _none_, start command: `node server.js`
- Render injects `PORT`.
- **Data is in-memory** and resets on restart / spin-down — intentional for the testing phase.
- Point **UptimeRobot** at `/ping` (every 5 min) to keep the free service awake.

### Upgrading to persistent storage

Data access goes through `loadData()` / `saveData()`. On the free tier `saveData()` is a no-op. When a persistent disk is mounted at `/data`, set `USE_DISK = true` near the top of `server.js` — JSON is then read from and written to `/data/ops-data/`.

## API

| Method | Path | Notes |
|--------|------|-------|
| GET | `/` | Single-page app |
| GET | `/ping` | `{ status: "ok" }` keepalive |
| GET | `/api/posts?location=Cole` | Filter by location (`All` for everything); pinned first, then newest |
| POST | `/api/posts` | `multipart/form-data`: author, location, tag, text, photos (≤3, ≤2MB each) |
| DELETE | `/api/posts/:id` | Admin (header `X-Access-Level: admin`) |
| POST | `/api/posts/:id/pin` | Admin — toggle pin |
| GET | `/api/team` | Team list |
| POST | `/api/team` | Admin — add member |
| DELETE | `/api/team/:name` | Admin — remove member |
| GET | `/api/settings` | Admin — current PINs |
| POST | `/api/settings/pins` | Admin — change PINs |
| POST | `/api/verify-pin` | Verify a typed PIN, returns access level |

Admin-only actions are enforced **server-side** via the `X-Access-Level: admin` header.
