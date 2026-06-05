/*
 * XRT Ops Board — Xtreme Electronic Recycling
 * Mobile-first team communication board.
 *
 * Single-file Node.js app. No external packages — only built-in
 * http, https, fs, path modules.
 *
 * Deployed to Render free tier (no persistent disk). Data lives in
 * memory and resets on restart. The loadData()/saveData() pattern is
 * in place so migration to a persistent /data disk is trivial later.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * Data layer
 *
 * On the free tier everything is in memory. DATA_DIR points at where
 * JSON files WOULD live on a persistent disk. saveData() is a no-op
 * unless USE_DISK is enabled (set when /data exists / paid tier).
 * ------------------------------------------------------------------ */

const DATA_DIR = path.join('/data', 'ops-data');
const USE_DISK = false; // flip to true once a persistent disk is mounted

const DEFAULT_TEAM = [
  { name: 'Marc', location: 'Cole', role: 'admin' },
  { name: 'Kendall', location: 'Cole', role: 'admin' },
  { name: 'Manuel', location: 'Cole', role: 'admin' },
  { name: 'Reese', location: 'Cole', role: 'staff' },
  { name: 'Nic', location: 'Cole', role: 'staff' },
  { name: 'Gregory', location: 'Visalia', role: 'staff' },
  { name: 'Xavier', location: 'Visalia', role: 'staff' }
];

const DEFAULT_SETTINGS = {
  staffPin: '7823',
  adminPin: '9241'
};

// In-memory stores
let posts = [];
let team = [];
let settings = {};

/* Read a JSON file from disk, returning fallback on any problem. */
function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[OPS] Failed reading ' + file + ':', err.message);
    return fallback;
  }
}

/*
 * loadData — initialize the in-memory stores.
 * On free tier: seed from defaults. On disk tier: read JSON files,
 * falling back to defaults if they don't exist yet.
 */
function loadData() {
  if (USE_DISK) {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
      console.error('[OPS] Could not create data dir:', err.message);
    }
    posts = readJsonFile(path.join(DATA_DIR, 'posts.json'), []);
    team = readJsonFile(path.join(DATA_DIR, 'team.json'), DEFAULT_TEAM.slice());
    settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), Object.assign({}, DEFAULT_SETTINGS));
  } else {
    posts = [];
    team = DEFAULT_TEAM.slice();
    settings = Object.assign({}, DEFAULT_SETTINGS);
  }
}

/*
 * saveData — persist a given store to disk.
 * No-op on free tier. When USE_DISK is true, writes JSON files. Photos
 * are kept inline as base64 data URLs in posts.json for now; a future
 * disk upgrade can split them into files inside this same function.
 */
function saveData(which) {
  if (!USE_DISK) return; // free tier: in-memory only
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!which || which === 'posts') {
      fs.writeFileSync(path.join(DATA_DIR, 'posts.json'), JSON.stringify(posts, null, 2));
    }
    if (!which || which === 'team') {
      fs.writeFileSync(path.join(DATA_DIR, 'team.json'), JSON.stringify(team, null, 2));
    }
    if (!which || which === 'settings') {
      fs.writeFileSync(path.join(DATA_DIR, 'settings.json'), JSON.stringify(settings, null, 2));
    }
  } catch (err) {
    console.error('[OPS] saveData failed:', err.message);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d) {
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

function makeId() {
  return 'p-' + Date.now() + '-' + Math.floor(Math.random() * 100000);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function isAdmin(req) {
  return (req.headers['x-access-level'] || '').toLowerCase() === 'admin';
}

/* Read the full raw request body as a Buffer, with a size cap. */
function readBody(req, maxBytes, cb) {
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', function (chunk) {
    if (aborted) return;
    size += chunk.length;
    if (size > maxBytes) {
      aborted = true;
      cb(new Error('Request body too large'));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (aborted) return;
    cb(null, Buffer.concat(chunks));
  });
  req.on('error', function (err) {
    if (aborted) return;
    aborted = true;
    cb(err);
  });
}

/* ------------------------------------------------------------------ *
 * Manual multipart/form-data parser
 *
 * Returns { fields: {}, photos: [] } where photos are base64 data URL
 * strings. Pure Buffer work — no external packages.
 * ------------------------------------------------------------------ */

const MAX_PHOTO_BYTES = 2 * 1024 * 1024; // 2MB per photo
const MAX_PHOTOS = 3;

function mimeFromFilename(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return 'image/jpeg';
}

function parseMultipart(buffer, contentType) {
  const result = { fields: {}, photos: [] };
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return result;
  const boundary = '--' + (m[1] || m[2]).trim();

  const boundaryBuf = Buffer.from(boundary);
  const parts = [];
  let start = buffer.indexOf(boundaryBuf);
  if (start === -1) return result;
  start += boundaryBuf.length;

  while (true) {
    // After a boundary we expect either "--" (end) or CRLF then a part.
    if (buffer[start] === 0x2d && buffer[start + 1] === 0x2d) break; // closing "--"
    // skip the CRLF after the boundary
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;

    const next = buffer.indexOf(boundaryBuf, start);
    if (next === -1) break;
    // The part content ends with a trailing CRLF before the boundary.
    let end = next;
    if (buffer[end - 2] === 0x0d && buffer[end - 1] === 0x0a) end -= 2;
    parts.push(buffer.slice(start, end));
    start = next + boundaryBuf.length;
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4);

    const dispo = /content-disposition:[^\r\n]*/i.exec(headerStr);
    if (!dispo) continue;
    const nameMatch = /name="([^"]*)"/i.exec(dispo[0]);
    const fileMatch = /filename="([^"]*)"/i.exec(dispo[0]);
    const fieldName = nameMatch ? nameMatch[1] : '';

    if (fileMatch && fileMatch[1]) {
      // File part — only keep images, cap at MAX_PHOTOS and size.
      if (result.photos.length >= MAX_PHOTOS) continue;
      if (content.length === 0) continue;
      if (content.length > MAX_PHOTO_BYTES) continue;
      const ctMatch = /content-type:\s*([^\r\n]+)/i.exec(headerStr);
      let mime = ctMatch ? ctMatch[1].trim() : mimeFromFilename(fileMatch[1]);
      if (mime.indexOf('image/') !== 0) mime = mimeFromFilename(fileMatch[1]);
      const dataUrl = 'data:' + mime + ';base64,' + content.toString('base64');
      result.photos.push(dataUrl);
    } else if (fieldName) {
      result.fields[fieldName] = content.toString('utf8');
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * API handlers
 * ------------------------------------------------------------------ */

function sortPosts(list) {
  return list.slice().sort(function (a, b) {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.timestamp) - new Date(a.timestamp);
  });
}

function handleGetPosts(req, res, query) {
  let list = posts;
  const loc = query.location;
  if (loc && loc !== 'All') {
    // Posts tagged "All" appear under every location filter.
    list = posts.filter(function (p) { return p.location === loc || p.location === 'All'; });
  }
  sendJson(res, 200, sortPosts(list));
}

function handleCreatePost(req, res) {
  const ct = req.headers['content-type'] || '';
  // Body cap: 3 photos * 2MB + base64 overhead + fields ≈ generous 12MB.
  readBody(req, 12 * 1024 * 1024, function (err, buf) {
    if (err) return sendJson(res, 413, { success: false, error: err.message });
    try {
      let fields = {};
      let photos = [];
      if (ct.indexOf('multipart/form-data') === 0) {
        const parsed = parseMultipart(buf, ct);
        fields = parsed.fields;
        photos = parsed.photos;
      } else if (ct.indexOf('application/json') === 0) {
        fields = JSON.parse(buf.toString('utf8') || '{}');
      } else {
        // urlencoded fallback
        const params = new URLSearchParams(buf.toString('utf8'));
        params.forEach(function (v, k) { fields[k] = v; });
      }

      const author = (fields.author || '').trim();
      const location = (fields.location || '').trim();
      const tag = (fields.tag || '').trim();
      const text = (fields.text || '').trim();

      if (!author || !location || !tag || !text) {
        return sendJson(res, 400, { success: false, error: 'Missing required fields' });
      }
      const validTags = ['urgent', 'info', 'success', 'warning'];
      if (validTags.indexOf(tag) === -1) {
        return sendJson(res, 400, { success: false, error: 'Invalid category' });
      }

      const now = new Date();
      const post = {
        id: makeId(),
        author: author,
        location: location,
        tag: tag,
        text: text,
        photos: photos,
        pinned: false,
        timestamp: now.toISOString(),
        date: shortDate(now)
      };
      posts.unshift(post);
      saveData('posts');
      sendJson(res, 200, post);
    } catch (e) {
      console.error('[OPS] create post error:', e.message);
      sendJson(res, 500, { success: false, error: 'Could not create post' });
    }
  });
}

function handleDeletePost(req, res, id) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  const idx = posts.findIndex(function (p) { return p.id === id; });
  if (idx === -1) return sendJson(res, 404, { success: false, error: 'Not found' });
  posts.splice(idx, 1);
  saveData('posts');
  sendJson(res, 200, { success: true });
}

function handlePinPost(req, res, id) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  const post = posts.find(function (p) { return p.id === id; });
  if (!post) return sendJson(res, 404, { success: false, error: 'Not found' });
  post.pinned = !post.pinned;
  saveData('posts');
  sendJson(res, 200, { success: true, pinned: post.pinned });
}

function handleGetTeam(req, res) {
  sendJson(res, 200, team);
}

function handleAddTeam(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 64 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const name = (body.name || '').trim();
      const location = (body.location || '').trim();
      const role = (body.role || 'staff').trim();
      if (!name || !location) {
        return sendJson(res, 400, { success: false, error: 'Name and location required' });
      }
      if (role !== 'staff' && role !== 'admin') {
        return sendJson(res, 400, { success: false, error: 'Invalid role' });
      }
      if (team.some(function (t) { return t.name.toLowerCase() === name.toLowerCase(); })) {
        return sendJson(res, 400, { success: false, error: 'Member already exists' });
      }
      const member = { name: name, location: location, role: role };
      team.push(member);
      saveData('team');
      sendJson(res, 200, member);
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not add member' });
    }
  });
}

function handleDeleteTeam(req, res, name) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  const target = decodeURIComponent(name);
  const idx = team.findIndex(function (t) { return t.name === target; });
  if (idx === -1) return sendJson(res, 404, { success: false, error: 'Not found' });
  team.splice(idx, 1);
  saveData('team');
  sendJson(res, 200, { success: true });
}

function handleGetSettings(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  sendJson(res, 200, { staffPin: settings.staffPin, adminPin: settings.adminPin });
}

function handleChangePins(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 64 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const current = (body.currentAdminPin || '').trim();
      const newStaff = (body.newStaffPin || '').trim();
      const newAdmin = (body.newAdminPin || '').trim();
      if (current !== settings.adminPin) {
        return sendJson(res, 200, { success: false, error: 'Current admin PIN is incorrect' });
      }
      if (!/^\d{4}$/.test(newStaff) || !/^\d{4}$/.test(newAdmin)) {
        return sendJson(res, 200, { success: false, error: 'PINs must be 4 digits' });
      }
      settings.staffPin = newStaff;
      settings.adminPin = newAdmin;
      saveData('settings');
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not update PINs' });
    }
  });
}

/*
 * Public PIN check — lets the client verify a typed PIN against the
 * server without ever exposing the stored PINs to staff-level users.
 * Returns the granted access level on success.
 */
function handleVerifyPin(req, res) {
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const pin = (body.pin || '').trim();
      const want = (body.level || '').trim();
      if (want === 'admin' && pin === settings.adminPin) {
        return sendJson(res, 200, { success: true, level: 'admin' });
      }
      if (want === 'staff' && pin === settings.staffPin) {
        return sendJson(res, 200, { success: true, level: 'staff' });
      }
      sendJson(res, 200, { success: false, error: 'Incorrect PIN' });
    } catch (e) {
      sendJson(res, 400, { success: false, error: 'Bad request' });
    }
  });
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

const server = http.createServer(function (req, res) {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    const pathname = parsed.pathname;
    const method = req.method;
    const query = {};
    parsed.searchParams.forEach(function (v, k) { query[k] = v; });

    // Static / health routes
    if (method === 'GET' && pathname === '/') {
      const html = renderHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    // Health check. Tolerate HEAD (UptimeRobot's default probe method)
    // and an optional trailing slash so external pings never 404.
    if ((method === 'GET' || method === 'HEAD') &&
        (pathname === '/ping' || pathname === '/ping/')) {
      if (method === 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end();
      }
      return sendJson(res, 200, { status: 'ok' });
    }

    // API routes
    if (pathname === '/api/posts') {
      if (method === 'GET') return handleGetPosts(req, res, query);
      if (method === 'POST') return handleCreatePost(req, res);
    }
    let m;
    if ((m = /^\/api\/posts\/([^/]+)\/pin$/.exec(pathname)) && method === 'POST') {
      return handlePinPost(req, res, m[1]);
    }
    if ((m = /^\/api\/posts\/([^/]+)$/.exec(pathname)) && method === 'DELETE') {
      return handleDeletePost(req, res, m[1]);
    }
    if (pathname === '/api/team') {
      if (method === 'GET') return handleGetTeam(req, res);
      if (method === 'POST') return handleAddTeam(req, res);
    }
    if ((m = /^\/api\/team\/([^/]+)$/.exec(pathname)) && method === 'DELETE') {
      return handleDeleteTeam(req, res, m[1]);
    }
    if (pathname === '/api/settings' && method === 'GET') {
      return handleGetSettings(req, res);
    }
    if (pathname === '/api/settings/pins' && method === 'POST') {
      return handleChangePins(req, res);
    }
    if (pathname === '/api/verify-pin' && method === 'POST') {
      return handleVerifyPin(req, res);
    }

    sendJson(res, 404, { success: false, error: 'Not found' });
  } catch (err) {
    console.error('[OPS] request error:', err.message);
    try { sendJson(res, 500, { success: false, error: 'Server error' }); } catch (e) {}
  }
});

/* ------------------------------------------------------------------ *
 * Frontend — single-page app, all HTML/CSS/JS inline.
 * CSS_STR / BODY_STR / JS_STR are defined further below; renderHtml()
 * assembles them per request.
 * ------------------------------------------------------------------ */

function renderHtml() {
  return '<!DOCTYPE html>\n' +
    '<html lang="en">\n' +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">\n' +
    '<meta name="theme-color" content="#3a7d1e">\n' +
    '<title>XRT Ops Board</title>\n' +
    '<link rel="icon" href="https://thekingofrecycling.com/wp-content/uploads/2022/10/cropped-favicon.png">\n' +
    '<style>\n' + CSS_STR + '\n</style>\n' +
    '</head>\n<body>\n' + BODY_STR + '\n<script>\n' + JS_STR + '\n</script>\n' +
    '</body>\n</html>';
}

/* ===== CSS ===== */
const CSS_STR = `
:root{
  --green:#3a7d1e; --green-light:#e8f5e0; --green-btn:#4a9424;
  --bg:#f7f7f7; --card:#ffffff; --border:#dde8d5;
  --urgent:#c0392b; --urgent-l:#fdf0ef;
  --info:#1a6fa8; --info-l:#e8f4fd;
  --success:#2e7d32; --success-l:#e8f5e0;
  --warning:#e65100; --warning-l:#fff3e0;
  --text:#1a1a1a; --text2:#666666;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{margin:0;padding:0;}
body{
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  background:var(--bg); color:var(--text); font-size:15px; line-height:1.4;
}
#app{max-width:480px; margin:0 auto; min-height:100vh; background:var(--bg);
  position:relative; padding-bottom:90px;}
.hidden{display:none !important;}
button{font-family:inherit; cursor:pointer;}

/* Header */
header{position:sticky; top:0; z-index:20; background:#fff;
  border-bottom:1px solid var(--border); padding:8px 12px;}
.hdr-row{display:flex; align-items:center; justify-content:space-between; gap:8px;}
.hdr-side{width:44px; display:flex; align-items:center;}
.hdr-side.right{justify-content:flex-end;}
.hdr-center{flex:1; text-align:center; overflow:hidden;}
.logo-img{max-height:44px; max-width:100%; object-fit:contain; display:inline-block;}
.logo-fallback{font-weight:700; color:var(--green); font-size:15px;}
.subtitle{font-size:11px; text-transform:uppercase; letter-spacing:2px;
  color:var(--green); font-weight:600; margin-top:2px;}
.icon-btn{width:44px; height:44px; border:none; background:none; font-size:20px;
  display:flex; align-items:center; justify-content:center; color:var(--green);
  border-radius:8px;}
.icon-btn:active{background:var(--green-light);}
.lock-label{font-size:9px; display:block; text-align:center; color:var(--text2);
  line-height:1; margin-top:-2px;}
.lock-wrap{display:flex; flex-direction:column; align-items:center;}

/* Tabs */
.tabs{display:flex; gap:8px; overflow-x:auto; padding:10px 12px; background:#fff;
  border-bottom:1px solid var(--border); -webkit-overflow-scrolling:touch;}
.tabs::-webkit-scrollbar{display:none;}
.tab{flex:0 0 auto; min-height:36px; padding:7px 18px; border-radius:20px;
  border:1.5px solid var(--green); background:#fff; color:var(--green);
  font-weight:600; font-size:14px; white-space:nowrap;}
.tab.active{background:var(--green); color:#fff;}

/* Stats */
.stats{display:flex; gap:8px; padding:12px;}
.stat{flex:1; background:var(--green-light); border:1px solid var(--border);
  border-radius:12px; padding:10px 6px; text-align:center;}
.stat .num{font-size:20px; font-weight:700; color:var(--green); line-height:1.1;}
.stat .lbl{font-size:11px; color:var(--text2); margin-top:3px;}

/* Feed */
.feed{padding:0 12px;}
.empty{text-align:center; color:var(--text2); padding:48px 16px; font-size:14px;}
.card{background:var(--card); border:0.5px solid var(--border); border-radius:12px;
  padding:12px 14px; margin-bottom:8px; position:relative;}
.card.pinned{border-color:var(--green); background:#fcfdfb;}
.card-top{display:flex; align-items:center; gap:8px; margin-bottom:6px;}
.badge{font-size:11px; font-weight:700; padding:3px 10px; border-radius:12px;
  text-transform:uppercase; letter-spacing:.4px;}
.badge.urgent{background:var(--urgent-l); color:var(--urgent);}
.badge.info{background:var(--info-l); color:var(--info);}
.badge.success{background:var(--success-l); color:var(--success);}
.badge.warning{background:var(--warning-l); color:var(--warning);}
.pin-toggle{margin-left:auto; border:none; background:none; font-size:16px;
  color:#bbb; padding:4px; min-width:32px; min-height:32px;}
.pin-toggle.on{color:var(--green);}
.pin-flag{margin-left:auto; font-size:13px; color:var(--green); font-weight:600;}
.meta{font-size:12px; color:var(--text2); margin-bottom:6px;}
.meta .author{font-weight:600; color:var(--text);}
.card-text{font-size:14px; line-height:1.5; white-space:pre-wrap; word-break:break-word;}
.photos{display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;}
.photos img{width:80px; height:80px; object-fit:cover; border-radius:8px;
  border:1px solid var(--border);}
.card-actions{display:flex; justify-content:flex-end; margin-top:8px;}
.del-btn{border:none; background:var(--urgent-l); color:var(--urgent);
  border-radius:8px; min-height:36px; padding:6px 14px; font-size:14px; font-weight:600;}
.confirm-row{display:flex; gap:8px; justify-content:flex-end; margin-top:8px;
  align-items:center;}
.confirm-row span{font-size:13px; color:var(--urgent); margin-right:auto;}
.confirm-row .yes{background:var(--urgent); color:#fff; border:none; border-radius:8px;
  min-height:36px; padding:6px 14px; font-weight:600;}
.confirm-row .no{background:#eee; color:var(--text); border:none; border-radius:8px;
  min-height:36px; padding:6px 14px; font-weight:600;}

/* FAB */
.fab{position:fixed; bottom:20px; right:20px; width:56px; height:56px;
  border-radius:50%; background:var(--green); color:#fff; border:none;
  font-size:30px; line-height:1; box-shadow:0 3px 10px rgba(0,0,0,.2); z-index:30;}
@media(min-width:520px){.fab{right:calc(50% - 220px);}}
.fab:active{background:var(--green-btn);}

/* Modal shells */
.overlay{position:fixed; inset:0; background:rgba(0,0,0,.4); z-index:40;
  display:flex; align-items:flex-end; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .2s ease;}
.overlay.show{opacity:1; pointer-events:auto;}
.sheet{width:100%; max-width:480px; background:#fff; border-radius:16px 16px 0 0;
  padding:18px 16px calc(18px + env(safe-area-inset-bottom)); max-height:92vh;
  overflow-y:auto; transform:translateY(100%); transition:transform .2s ease;}
.overlay.show .sheet{transform:translateY(0);}
.sheet h2{margin:0 0 14px; font-size:18px; color:var(--green);}
.field{margin-bottom:14px;}
.field label{display:block; font-size:13px; font-weight:600; margin-bottom:5px;}
.field select,.field input,.field textarea{
  width:100%; padding:11px 12px; border:1.5px solid var(--border); border-radius:10px;
  font-size:15px; font-family:inherit; background:#fff; color:var(--text);}
.field textarea{resize:vertical; min-height:96px;}
.field .err{color:var(--urgent); font-size:12px; margin-top:4px; display:none;}
.field.invalid .err{display:block;}
.field.invalid select,.field.invalid input,.field.invalid textarea{border-color:var(--urgent);}
.btn-primary{width:100%; background:var(--green); color:#fff; border:none;
  border-radius:10px; min-height:48px; font-size:16px; font-weight:700; margin-top:4px;}
.btn-primary:active{background:var(--green-btn);}
.btn-text{width:100%; background:none; border:none; color:var(--text2);
  min-height:44px; font-size:15px; margin-top:6px;}
.photo-btns{display:flex; gap:8px;}
.photo-btn{flex:1; min-height:44px; border:1.5px solid var(--green); background:#fff;
  color:var(--green); border-radius:10px; font-size:14px; font-weight:600;}
.photo-btn:active{background:var(--green-light);}
.photo-msg{font-size:12px; color:var(--warning); margin-top:6px; display:none;}
.photo-msg.show{display:block;}
.preview-row{display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;}
.preview{position:relative; width:72px; height:72px;}
.preview img{width:72px; height:72px; object-fit:cover; border-radius:8px;
  border:1px solid var(--border);}
.preview .rm{position:absolute; top:-6px; right:-6px; width:22px; height:22px;
  border-radius:50%; background:var(--urgent); color:#fff; border:none; font-size:13px;
  line-height:1; display:flex; align-items:center; justify-content:center;}

/* Settings */
.section{border-top:1px solid var(--border); padding-top:14px; margin-top:14px;}
.section:first-of-type{border-top:none; margin-top:0; padding-top:0;}
.section h3{font-size:15px; margin:0 0 12px; color:var(--text);}
.msg{font-size:13px; margin-top:8px; padding:8px 10px; border-radius:8px; display:none;}
.msg.ok{display:block; background:var(--success-l); color:var(--success);}
.msg.bad{display:block; background:var(--urgent-l); color:var(--urgent);}
.member{display:flex; align-items:center; gap:8px; padding:8px 0;
  border-bottom:1px solid var(--border);}
.member .m-name{font-weight:600; font-size:14px;}
.member .m-loc{font-size:12px; color:var(--text2);}
.role-badge{font-size:10px; font-weight:700; padding:2px 8px; border-radius:10px;
  text-transform:uppercase;}
.role-badge.admin{background:var(--info-l); color:var(--info);}
.role-badge.staff{background:var(--green-light); color:var(--green);}
.member .m-del{margin-left:auto; background:var(--urgent-l); color:var(--urgent);
  border:none; border-radius:8px; min-width:36px; min-height:36px; font-size:15px;}
.add-form{display:flex; flex-direction:column; gap:8px; margin-top:12px;}
.add-form .row{display:flex; gap:8px;}
.add-form .row > *{flex:1;}

/* PIN modal */
.pin-overlay{position:fixed; inset:0; background:var(--bg); z-index:60;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  padding:24px; text-align:center;}
.pin-logo{max-height:50px; margin-bottom:8px;}
.pin-sub{font-size:11px; text-transform:uppercase; letter-spacing:2px;
  color:var(--green); font-weight:600; margin-bottom:28px;}
.level-btns{display:flex; flex-direction:column; gap:14px; width:100%; max-width:300px;}
.level-btn{min-height:64px; border-radius:14px; border:2px solid var(--green);
  background:#fff; color:var(--green); font-size:18px; font-weight:700;}
.level-btn.admin{background:var(--green); color:#fff;}
.pinpad-wrap{width:100%; max-width:300px; display:flex; flex-direction:column;
  align-items:center;}
.pinpad-title{font-size:17px; font-weight:700; margin-bottom:4px;}
.pinpad-hint{font-size:13px; color:var(--text2); margin-bottom:20px;}
.dots{display:flex; gap:16px; margin-bottom:10px;}
.dot{width:16px; height:16px; border-radius:50%; border:2px solid var(--green);
  background:#fff;}
.dot.filled{background:var(--green);}
.dots.shake{animation:shake .4s;}
@keyframes shake{0%,100%{transform:translateX(0);}
  20%,60%{transform:translateX(-9px);} 40%,80%{transform:translateX(9px);}}
.pin-error{color:var(--urgent); font-size:14px; min-height:20px; margin-bottom:14px;}
.keypad{display:grid; grid-template-columns:repeat(3,1fr); gap:12px; width:100%;}
.key{min-height:60px; border-radius:12px; border:1px solid var(--border);
  background:#fff; font-size:22px; font-weight:600; color:var(--text);}
.key:active{background:var(--green-light);}
.key.confirm{background:var(--green); color:#fff; border:none;}
.key.wide{font-size:18px;}
.pin-back{margin-top:18px; background:none; border:none; color:var(--text2);
  font-size:14px; min-height:44px;}

/* Lightbox */
.lightbox{position:fixed; inset:0; background:rgba(0,0,0,.95); z-index:80;
  display:flex; align-items:center; justify-content:center;
  opacity:0; pointer-events:none; transition:opacity .2s;}
.lightbox.show{opacity:1; pointer-events:auto;}
.lightbox img{max-width:94%; max-height:88%; object-fit:contain; border-radius:6px;}
.lb-close{position:absolute; top:16px; right:16px; width:44px; height:44px;
  border-radius:50%; background:rgba(255,255,255,.15); color:#fff; border:none;
  font-size:24px;}
`;

/* ===== BODY ===== */
const BODY_STR = `
<div id="app">
  <header>
    <div class="hdr-row">
      <div class="hdr-side left">
        <button class="icon-btn hidden" id="gearBtn" title="Settings">&#9881;</button>
      </div>
      <div class="hdr-center">
        <img class="logo-img" id="logoImg"
          src="https://thekingofrecycling.com/wp-content/uploads/2022/10/Xtreme-Electronic-Recycling-Logo-Long-02.png"
          alt="Xtreme Electronic Recycling"
          onerror="this.style.display='none';document.getElementById('logoFallback').style.display='block';">
        <div class="logo-fallback" id="logoFallback" style="display:none;">Xtreme Electronic Recycling</div>
        <div class="subtitle">Ops Board</div>
      </div>
      <div class="hdr-side right">
        <button class="icon-btn lock-wrap" id="lockBtn" title="Switch access">
          <span>&#128274;</span><span class="lock-label" id="lockLabel">Staff</span>
        </button>
      </div>
    </div>
  </header>

  <div class="tabs" id="tabs"></div>
  <div class="stats" id="stats"></div>
  <div class="feed" id="feed"></div>

  <button class="fab" id="fab" title="Add update">+</button>
</div>

<!-- Add update modal -->
<div class="overlay" id="addOverlay">
  <div class="sheet">
    <h2>New Update</h2>
    <div class="field" id="f-author">
      <label>Your name</label>
      <select id="in-author"></select>
      <div class="err">Please select your name</div>
    </div>
    <div class="field" id="f-location">
      <label>Location</label>
      <select id="in-location">
        <option value="Cole">Cole</option>
        <option value="Dayton">Dayton</option>
        <option value="Visalia">Visalia</option>
        <option value="All">All Locations</option>
      </select>
      <div class="err">Please choose a location</div>
    </div>
    <div class="field" id="f-tag">
      <label>Category</label>
      <select id="in-tag">
        <option value="urgent">Urgent</option>
        <option value="info">Task / Info</option>
        <option value="success">Completed</option>
        <option value="warning">Heads Up</option>
      </select>
      <div class="err">Please choose a category</div>
    </div>
    <div class="field" id="f-text">
      <label>Update</label>
      <textarea id="in-text" rows="4" placeholder="What needs to be communicated? e.g. Don't process shelf B3 — items on hold. / Finished 12 items on A2."></textarea>
      <div class="err">Update text is required</div>
    </div>
    <div class="field">
      <label>Photos (up to 3)</label>
      <div class="photo-btns">
        <button type="button" class="photo-btn" id="takePhotoBtn">&#128247; Take Photo</button>
        <button type="button" class="photo-btn" id="chooseFileBtn">&#128193; Choose File</button>
      </div>
      <input type="file" id="in-camera" accept="image/*" capture="environment" class="hidden">
      <input type="file" id="in-photos" accept="image/*" multiple class="hidden">
      <div class="preview-row" id="previewRow"></div>
      <div class="photo-msg" id="photoMsg"></div>
    </div>
    <button class="btn-primary" id="postBtn">Post Update</button>
    <button class="btn-text" id="addCancel">Cancel</button>
  </div>
</div>

<!-- Settings modal -->
<div class="overlay" id="settingsOverlay">
  <div class="sheet">
    <h2>Settings</h2>
    <div class="section">
      <h3>Change PINs</h3>
      <div class="field"><label>Current admin PIN</label>
        <input type="password" inputmode="numeric" id="curPin" maxlength="4"></div>
      <div class="field"><label>New staff PIN</label>
        <input type="password" inputmode="numeric" id="newStaff" maxlength="4"></div>
      <div class="field"><label>New admin PIN</label>
        <input type="password" inputmode="numeric" id="newAdmin" maxlength="4"></div>
      <button class="btn-primary" id="savePins">Save PINs</button>
      <div class="msg" id="pinMsg"></div>
    </div>
    <div class="section">
      <h3>Manage Team</h3>
      <div id="memberList"></div>
      <div class="add-form">
        <input type="text" id="addName" placeholder="Name">
        <div class="row">
          <select id="addLoc">
            <option value="Cole">Cole</option>
            <option value="Dayton">Dayton</option>
            <option value="Visalia">Visalia</option>
          </select>
          <select id="addRole">
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button class="btn-primary" id="addMemberBtn">Add Member</button>
        <div class="msg" id="teamMsg"></div>
      </div>
    </div>
    <button class="btn-text" id="settingsClose">Close</button>
  </div>
</div>

<!-- PIN modal -->
<div class="pin-overlay hidden" id="pinOverlay">
  <img class="pin-logo"
    src="https://thekingofrecycling.com/wp-content/uploads/2022/10/Xtreme-Electronic-Recycling-Logo-Long-02.png"
    alt="XRT" onerror="this.style.display='none';">
  <div class="pin-sub">Ops Board</div>
  <div class="level-btns" id="levelBtns">
    <button class="level-btn" data-level="staff">Staff Access</button>
    <button class="level-btn admin" data-level="admin">Admin Access</button>
  </div>
  <div class="pinpad-wrap hidden" id="pinpad">
    <div class="pinpad-title" id="pinpadTitle">Enter PIN</div>
    <div class="pinpad-hint" id="pinpadHint">4-digit code</div>
    <div class="dots" id="dots"></div>
    <div class="pin-error" id="pinError"></div>
    <div class="keypad" id="keypad"></div>
    <button class="pin-back" id="pinBack">&larr; Back</button>
  </div>
</div>

<!-- Lightbox -->
<div class="lightbox" id="lightbox">
  <button class="lb-close" id="lbClose">&times;</button>
  <img id="lbImg" src="" alt="">
</div>
`;

/* ===== Client JS =====
 * Written without backticks / template literals so it can live inside
 * this server-side template literal safely. Plain string concatenation. */
const JS_STR = `
(function(){
  "use strict";
  var LOCATIONS = ["Cole","Dayton","Visalia","All"];
  var TAG_LABEL = {urgent:"Urgent", info:"Task / Info", success:"Completed", warning:"Heads Up"};
  var state = {
    level: localStorage.getItem("opsAccess") || null,
    location: "Cole",
    team: [],
    posts: [],
    photos: [],        // selected File objects for new post
    pendingDelete: null,
    pinLevel: null,
    pinDigits: ""
  };

  function $(id){ return document.getElementById(id); }
  function esc(s){
    return String(s).replace(/[&<>"']/g, function(c){
      return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c];
    });
  }
  function headers(json){
    var h = {};
    if (json) h["Content-Type"] = "application/json";
    if (state.level === "admin") h["X-Access-Level"] = "admin";
    return h;
  }
  function isAdmin(){ return state.level === "admin"; }

  function timeAgo(iso){
    var then = new Date(iso).getTime();
    var now = Date.now();
    var diff = Math.floor((now - then)/1000);
    if (diff < 45) return "just now";
    if (diff < 3600) return Math.floor(diff/60) + " min ago";
    if (diff < 7200) return "1 hour ago";
    if (diff < 86400) return Math.floor(diff/3600) + " hours ago";
    var d = new Date(iso), n = new Date();
    var oneDay = 86400000;
    var startThen = new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
    var startNow = new Date(n.getFullYear(),n.getMonth(),n.getDate()).getTime();
    if (startNow - startThen === oneDay) return "yesterday";
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[d.getMonth()] + " " + d.getDate();
  }
  function isToday(iso){
    var d = new Date(iso), n = new Date();
    return d.getFullYear()===n.getFullYear() && d.getMonth()===n.getMonth() && d.getDate()===n.getDate();
  }

  /* ---------- Header / access ---------- */
  function applyAccess(){
    $("lockLabel").textContent = isAdmin() ? "Admin" : "Staff";
    if (isAdmin()) $("gearBtn").classList.remove("hidden");
    else $("gearBtn").classList.add("hidden");
  }

  /* ---------- Tabs ---------- */
  function renderTabs(){
    var html = "";
    for (var i=0;i<LOCATIONS.length;i++){
      var loc = LOCATIONS[i];
      var cls = "tab" + (loc===state.location ? " active" : "");
      html += '<button class="'+cls+'" data-loc="'+loc+'">'+loc+'</button>';
    }
    $("tabs").innerHTML = html;
    var btns = $("tabs").querySelectorAll(".tab");
    for (var j=0;j<btns.length;j++){
      btns[j].addEventListener("click", function(){
        state.location = this.getAttribute("data-loc");
        renderTabs(); renderStats(); renderFeed();
      });
    }
  }

  /* ---------- Stats ---------- */
  function renderStats(){
    var loc = state.location;
    var todays = state.posts.filter(function(p){
      return (loc==="All" || p.location===loc || p.location==="All") && isToday(p.timestamp);
    });
    var urgent = todays.filter(function(p){ return p.tag==="urgent"; }).length;
    var done = todays.filter(function(p){ return p.tag==="success"; }).length;
    $("stats").innerHTML =
      stat(todays.length, "Today's updates") +
      stat(urgent, "Urgent") +
      stat(done, "Completed");
  }
  function stat(num, label){
    return '<div class="stat"><div class="num">'+num+'</div><div class="lbl">'+label+'</div></div>';
  }

  /* ---------- Feed ---------- */
  function renderFeed(){
    var loc = state.location;
    var list = state.posts.filter(function(p){ return loc==="All" || p.location===loc || p.location==="All"; });
    if (!list.length){
      $("feed").innerHTML = '<div class="empty">No updates for '+esc(loc)+' yet.<br>Tap + to post one.</div>';
      return;
    }
    var html = "";
    for (var i=0;i<list.length;i++) html += cardHtml(list[i]);
    $("feed").innerHTML = html;
    wireFeed();
  }

  function cardHtml(p){
    var pinClass = p.pinned ? " pinned" : "";
    var badge = '<span class="badge '+esc(p.tag)+'">'+esc(TAG_LABEL[p.tag]||p.tag)+'</span>';
    var pinControl;
    if (isAdmin()){
      pinControl = '<button class="pin-toggle'+(p.pinned?" on":"")+'" data-pin="'+p.id+'" title="Pin">&#128204;</button>';
    } else {
      pinControl = p.pinned ? '<span class="pin-flag">&#128204; Pinned</span>' : '';
    }
    var meta = '<div class="meta"><span class="author">'+esc(p.author)+'</span> &middot; '+
      esc(p.location)+' &middot; '+esc(timeAgo(p.timestamp))+'</div>';
    var photos = "";
    if (p.photos && p.photos.length){
      photos = '<div class="photos">';
      for (var k=0;k<p.photos.length;k++){
        photos += '<img src="'+p.photos[k]+'" data-full="'+p.photos[k]+'" alt="photo">';
      }
      photos += '</div>';
    }
    var actions = "";
    if (isAdmin()){
      actions = '<div class="card-actions" data-actions="'+p.id+'">'+
        '<button class="del-btn" data-del="'+p.id+'">&#128465; Delete</button></div>';
    }
    return '<div class="card'+pinClass+'" data-card="'+p.id+'">'+
      '<div class="card-top">'+badge+pinControl+'</div>'+
      meta+
      '<div class="card-text">'+esc(p.text)+'</div>'+
      photos+actions+'</div>';
  }

  function wireFeed(){
    var feed = $("feed");
    var imgs = feed.querySelectorAll(".photos img");
    for (var i=0;i<imgs.length;i++){
      imgs[i].addEventListener("click", function(){ openLightbox(this.getAttribute("data-full")); });
    }
    var pins = feed.querySelectorAll("[data-pin]");
    for (var j=0;j<pins.length;j++){
      pins[j].addEventListener("click", function(){ togglePin(this.getAttribute("data-pin")); });
    }
    var dels = feed.querySelectorAll("[data-del]");
    for (var d=0;d<dels.length;d++){
      dels[d].addEventListener("click", function(){ askDelete(this.getAttribute("data-del")); });
    }
  }

  function askDelete(id){
    var wrap = document.querySelector('[data-actions="'+id+'"]');
    if (!wrap) return;
    wrap.className = "confirm-row";
    wrap.innerHTML = '<span>Delete this post?</span>'+
      '<button class="no">Cancel</button><button class="yes">Delete</button>';
    wrap.querySelector(".no").addEventListener("click", function(){ renderFeed(); });
    wrap.querySelector(".yes").addEventListener("click", function(){ doDelete(id); });
  }

  function doDelete(id){
    fetch("/api/posts/"+encodeURIComponent(id), { method:"DELETE", headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(res){ if (res.success){ loadPosts(); } })
      .catch(function(){});
  }

  function togglePin(id){
    fetch("/api/posts/"+encodeURIComponent(id)+"/pin", { method:"POST", headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(){ loadPosts(); })
      .catch(function(){});
  }

  /* ---------- Data loads ---------- */
  function loadPosts(){
    fetch("/api/posts?location=All")
      .then(function(r){ return r.json(); })
      .then(function(list){
        state.posts = Array.isArray(list) ? list : [];
        renderStats(); renderFeed();
      })
      .catch(function(){});
  }
  function loadTeam(){
    return fetch("/api/team")
      .then(function(r){ return r.json(); })
      .then(function(list){
        state.team = Array.isArray(list) ? list : [];
        fillAuthorSelect();
      })
      .catch(function(){});
  }
  function fillAuthorSelect(){
    var sel = $("in-author");
    var html = '<option value="">Select your name</option>';
    for (var i=0;i<state.team.length;i++){
      html += '<option value="'+esc(state.team[i].name)+'">'+esc(state.team[i].name)+'</option>';
    }
    sel.innerHTML = html;
  }

  /* ---------- Add update modal ---------- */
  function openAdd(){
    clearErrors();
    hidePhotoMsg();
    $("addOverlay").classList.add("show");
  }
  function closeAdd(){
    $("addOverlay").classList.remove("show");
  }
  function clearErrors(){
    var fs = document.querySelectorAll("#addOverlay .field");
    for (var i=0;i<fs.length;i++) fs[i].classList.remove("invalid");
  }

  function renderPreviews(){
    var row = $("previewRow");
    row.innerHTML = "";
    state.photos.forEach(function(file, idx){
      var reader = new FileReader();
      reader.onload = function(e){
        var div = document.createElement("div");
        div.className = "preview";
        div.innerHTML = '<img src="'+e.target.result+'"><button class="rm" data-rm="'+idx+'">&times;</button>';
        div.querySelector(".rm").addEventListener("click", function(){
          state.photos.splice(idx,1); hidePhotoMsg(); renderPreviews();
        });
        row.appendChild(div);
      };
      reader.readAsDataURL(file);
    });
  }

  // Compress an image File to <=800px on the longest side, JPEG q0.75.
  // Falls back to the original file if anything goes wrong.
  function compressPhoto(file, cb){
    try {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){
        var max = 800;
        var w = img.width, h = img.height;
        if (w >= h && w > max){ h = Math.round(h * max / w); w = max; }
        else if (h > w && h > max){ w = Math.round(w * max / h); h = max; }
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        if (canvas.toBlob){
          canvas.toBlob(function(blob){ cb(blob || file); }, "image/jpeg", 0.75);
        } else {
          cb(file);
        }
      };
      img.onerror = function(){ URL.revokeObjectURL(url); cb(file); };
      img.src = url;
    } catch (err){ cb(file); }
  }

  function showPhotoMsg(text){
    var el = $("photoMsg"); el.textContent = text; el.classList.add("show");
  }
  function hidePhotoMsg(){
    var el = $("photoMsg"); el.textContent = ""; el.classList.remove("show");
  }

  function onPhotoSelect(e){
    var files = Array.prototype.slice.call(e.target.files).filter(function(f){
      return f.type.indexOf("image/") === 0;
    });
    e.target.value = "";
    var capacity = Math.max(0, 3 - state.photos.length);
    if (files.length > capacity){
      var dropped = files.length - capacity;
      showPhotoMsg("Max 3 photos \\u2014 " + dropped + " not added.");
    } else {
      hidePhotoMsg();
    }
    files.forEach(function(file){
      compressPhoto(file, function(blob){
        if (state.photos.length >= 3) return; // 3 total across both inputs
        state.photos.push(blob);
        renderPreviews();
      });
    });
  }

  function submitPost(){
    clearErrors();
    var author = $("in-author").value;
    var location = $("in-location").value;
    var tag = $("in-tag").value;
    var text = $("in-text").value.trim();
    var ok = true;
    if (!author){ $("f-author").classList.add("invalid"); ok=false; }
    if (!location){ $("f-location").classList.add("invalid"); ok=false; }
    if (!tag){ $("f-tag").classList.add("invalid"); ok=false; }
    if (!text){ $("f-text").classList.add("invalid"); ok=false; }
    if (!ok) return;

    var fd = new FormData();
    fd.append("author", author);
    fd.append("location", location);
    fd.append("tag", tag);
    fd.append("text", text);
    for (var i=0;i<state.photos.length;i++) fd.append("photos", state.photos[i], "photo"+(i+1)+".jpg");

    var btn = $("postBtn");
    btn.disabled = true; btn.textContent = "Posting...";
    fetch("/api/posts", { method:"POST", headers: headers(false), body: fd })
      .then(function(r){ return r.json(); })
      .then(function(res){
        btn.disabled = false; btn.textContent = "Post Update";
        if (res && res.id){
          state.photos = [];
          renderPreviews();
          $("in-text").value = "";
          closeAdd();
          if (state.location !== "All" && state.location !== location){
            state.location = location; renderTabs();
          }
          loadPosts();
          window.scrollTo({top:0, behavior:"smooth"});
        } else {
          alert((res && res.error) ? res.error : "Could not post update");
        }
      })
      .catch(function(){
        btn.disabled = false; btn.textContent = "Post Update";
        alert("Network error posting update");
      });
  }

  /* ---------- Settings ---------- */
  function openSettings(){
    $("pinMsg").className = "msg";
    $("teamMsg").className = "msg";
    $("curPin").value = ""; $("newStaff").value = ""; $("newAdmin").value = "";
    renderMembers();
    $("settingsOverlay").classList.add("show");
  }
  function closeSettings(){ $("settingsOverlay").classList.remove("show"); }

  function renderMembers(){
    var html = "";
    for (var i=0;i<state.team.length;i++){
      var m = state.team[i];
      html += '<div class="member">'+
        '<div><div class="m-name">'+esc(m.name)+'</div><div class="m-loc">'+esc(m.location)+'</div></div>'+
        '<span class="role-badge '+esc(m.role)+'">'+esc(m.role)+'</span>'+
        '<button class="m-del" data-member="'+esc(m.name)+'">&#128465;</button></div>';
    }
    $("memberList").innerHTML = html;
    var dels = $("memberList").querySelectorAll("[data-member]");
    for (var j=0;j<dels.length;j++){
      dels[j].addEventListener("click", function(){ removeMember(this.getAttribute("data-member")); });
    }
  }

  function removeMember(name){
    fetch("/api/team/"+encodeURIComponent(name), { method:"DELETE", headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.success){ loadTeam().then(renderMembers); }
        else { showMsg("teamMsg", res.error||"Could not remove", false); }
      })
      .catch(function(){});
  }

  function addMember(){
    var name = $("addName").value.trim();
    var loc = $("addLoc").value;
    var role = $("addRole").value;
    if (!name){ showMsg("teamMsg", "Name is required", false); return; }
    fetch("/api/team", { method:"POST", headers: headers(true),
      body: JSON.stringify({ name:name, location:loc, role:role }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.name){
          $("addName").value = "";
          showMsg("teamMsg", "Added "+res.name, true);
          loadTeam().then(renderMembers);
        } else {
          showMsg("teamMsg", (res&&res.error)||"Could not add member", false);
        }
      })
      .catch(function(){ showMsg("teamMsg","Network error", false); });
  }

  function savePins(){
    var cur = $("curPin").value.trim();
    var ns = $("newStaff").value.trim();
    var na = $("newAdmin").value.trim();
    fetch("/api/settings/pins", { method:"POST", headers: headers(true),
      body: JSON.stringify({ currentAdminPin:cur, newStaffPin:ns, newAdminPin:na }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.success){
          showMsg("pinMsg", "PINs updated successfully", true);
          $("curPin").value=""; $("newStaff").value=""; $("newAdmin").value="";
        } else {
          showMsg("pinMsg", res.error||"Could not update PINs", false);
        }
      })
      .catch(function(){ showMsg("pinMsg","Network error", false); });
  }

  function showMsg(id, text, ok){
    var el = $(id);
    el.textContent = text;
    el.className = "msg " + (ok ? "ok" : "bad");
  }

  /* ---------- Lightbox ---------- */
  function openLightbox(src){
    $("lbImg").src = src;
    $("lightbox").classList.add("show");
  }
  function closeLightbox(){
    $("lightbox").classList.remove("show");
    $("lbImg").src = "";
  }

  /* ---------- PIN modal ---------- */
  function showPin(){
    state.pinLevel = null; state.pinDigits = "";
    $("levelBtns").classList.remove("hidden");
    $("pinpad").classList.add("hidden");
    $("pinError").textContent = "";
    $("pinOverlay").classList.remove("hidden");
  }
  function hidePin(){ $("pinOverlay").classList.add("hidden"); }

  function startPad(level){
    state.pinLevel = level;
    state.pinDigits = "";
    $("levelBtns").classList.add("hidden");
    $("pinpad").classList.remove("hidden");
    $("pinpadTitle").textContent = (level==="admin"?"Admin":"Staff") + " Access";
    $("pinError").textContent = "";
    renderDots();
  }
  function renderDots(){
    var html = "";
    for (var i=0;i<4;i++){
      html += '<div class="dot'+(i<state.pinDigits.length?" filled":"")+'"></div>';
    }
    $("dots").innerHTML = html;
  }
  function buildKeypad(){
    var keys = ["1","2","3","4","5","6","7","8","9","back","0","ok"];
    var html = "";
    for (var i=0;i<keys.length;i++){
      var k = keys[i];
      if (k==="back") html += '<button class="key wide" data-key="back">&#9003;</button>';
      else if (k==="ok") html += '<button class="key confirm" data-key="ok">&#10003;</button>';
      else html += '<button class="key" data-key="'+k+'">'+k+'</button>';
    }
    $("keypad").innerHTML = html;
    var btns = $("keypad").querySelectorAll(".key");
    for (var j=0;j<btns.length;j++){
      btns[j].addEventListener("click", function(){ pinKey(this.getAttribute("data-key")); });
    }
  }
  function pinKey(k){
    if (k==="back"){ state.pinDigits = state.pinDigits.slice(0,-1); renderDots(); return; }
    if (k==="ok"){ submitPin(); return; }
    if (state.pinDigits.length < 4){ state.pinDigits += k; renderDots(); }
    if (state.pinDigits.length === 4){ submitPin(); }
  }
  function submitPin(){
    if (state.pinDigits.length !== 4) return;
    var pin = state.pinDigits;
    var level = state.pinLevel;
    fetch("/api/verify-pin", { method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ pin:pin, level:level }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res.success){
          state.level = res.level;
          localStorage.setItem("opsAccess", res.level);
          hidePin();
          applyAccess();
          renderTabs(); loadTeam(); loadPosts();
        } else {
          state.pinDigits = "";
          renderDots();
          $("dots").classList.add("shake");
          $("pinError").textContent = "Incorrect PIN";
          setTimeout(function(){
            $("dots").classList.remove("shake");
            $("pinError").textContent = "";
          }, 1500);
        }
      })
      .catch(function(){ $("pinError").textContent = "Network error"; });
  }

  /* ---------- Wire up ---------- */
  function init(){
    buildKeypad();
    renderTabs();

    $("fab").addEventListener("click", openAdd);
    $("addCancel").addEventListener("click", closeAdd);
    $("addOverlay").addEventListener("click", function(e){ if (e.target===this) closeAdd(); });
    $("postBtn").addEventListener("click", submitPost);
    $("in-photos").addEventListener("change", onPhotoSelect);
    $("in-camera").addEventListener("change", onPhotoSelect);
    $("takePhotoBtn").addEventListener("click", function(){ $("in-camera").click(); });
    $("chooseFileBtn").addEventListener("click", function(){ $("in-photos").click(); });

    $("lockBtn").addEventListener("click", showPin);
    $("gearBtn").addEventListener("click", openSettings);
    $("settingsClose").addEventListener("click", closeSettings);
    $("settingsOverlay").addEventListener("click", function(e){ if (e.target===this) closeSettings(); });
    $("savePins").addEventListener("click", savePins);
    $("addMemberBtn").addEventListener("click", addMember);

    $("lbClose").addEventListener("click", closeLightbox);
    $("lightbox").addEventListener("click", function(e){ if (e.target===this) closeLightbox(); });

    var levelButtons = $("levelBtns").querySelectorAll(".level-btn");
    for (var i=0;i<levelButtons.length;i++){
      levelButtons[i].addEventListener("click", function(){ startPad(this.getAttribute("data-level")); });
    }
    $("pinBack").addEventListener("click", function(){
      $("levelBtns").classList.remove("hidden");
      $("pinpad").classList.add("hidden");
    });

    if (state.level){
      applyAccess();
      loadTeam(); loadPosts();
    } else {
      showPin();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

loadData();
console.log('[OPS] Server starting...');
console.log('[OPS] Team initialized: ' + team.length + ' members');
console.log('[OPS] Posts initialized: ' + posts.length);
server.listen(PORT, function () {
  console.log('[OPS] Running on port ' + PORT);
  console.log('[OPS] Ready — visit /ping to verify');
});

module.exports = server;
