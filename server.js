/*
 * XRT Ops Board — Xtreme Electronic Recycling
 * Mobile-first team communication board.
 *
 * Single-file Node.js app. No external packages — only built-in
 * http, https, fs, path modules.
 *
 * Deployed to Render Starter tier with a 5GB persistent disk mounted
 * at /data. Posts, team, settings, and photos are stored on disk and
 * survive restarts. The loadData()/saveData() pattern that was built
 * in from the start now reads/writes JSON files under /data/ops-data/.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * Data layer — persistent disk storage
 *
 * DATA_DIR is the persistent disk location (Render mounts the disk at
 * /data). All data is read from / written to JSON files here, and
 * uploaded photos are stored as files under PHOTOS_DIR. OPS_DATA_DIR
 * can override the base path (used by the test harness so it never
 * touches the real disk).
 * ------------------------------------------------------------------ */

const DATA_DIR = process.env.OPS_DATA_DIR || path.join('/data', 'ops-data');
const PHOTOS_DIR = path.join(DATA_DIR, 'photos');

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

/*
 * Supplies tracker data. items = supply types; flags = per-location
 * low-stock flags moving through flagged -> confirmed -> ordered.
 * Default items match the spec: Pallet Wrap, Gaylord Boxes, Pallets.
 */
const DEFAULT_SUPPLIES = {
  items: [
    { id: '1', name: 'Pallet Wrap', category: 'Shipping' },
    { id: '2', name: 'Gaylord Boxes', category: 'Shipping' },
    { id: '3', name: 'Pallets', category: 'Shipping' }
  ],
  flags: []
};

/*
 * Pickup-needed flags. Same on-disk/lifecycle pattern as supplies
 * flags (flagged by any staff PIN, resolved by admin), but there is
 * no persisted "items" catalog to flag against — each flag records
 * its own location + pallet type directly, chosen from a hardcoded
 * list (PALLET_TYPES), matching the supplies category convention.
 */
const DEFAULT_PICKUPS = { flags: [] };
const PALLET_TYPES = ['TV Pallet', 'Mixed Pallet', 'Other'];

/*
 * XOS (Xtreme Operating System) documents. Each: title, volume,
 * sortOrder, optional sopId, content body, last-updated date. Volume is
 * one of V1/V2/V3/HR (UN = temporarily unassigned). Two placeholders are
 * pre-loaded on first run (when no sops.json exists yet).
 */
const SOP_VOLUMES = ['V1', 'V2', 'V3', 'HR']; // selectable volumes (UN = unassigned fallback)

const DEFAULT_SOPS = [
  {
    id: 'sop-1',
    sopId: 'SOP-001',
    title: 'Electronics Intake Procedure',
    volume: 'V2',
    sortOrder: 1,
    category: 'Intake',
    body: 'Purpose: Ensure all incoming electronics are properly received, logged, and staged for processing.\n\nStep 1: Greet the customer and confirm they have a valid pickup or drop-off appointment.\n\nStep 2: Count and record the number of items being dropped off. Note any oversized or hazardous items (CRT monitors, batteries, large printers).\n\nStep 3: Issue the customer a receipt with item count and date. Have them sign if required by location.\n\nStep 4: Stage items in the designated intake area — do not mix with already-processed inventory.\n\nStep 5: Tag the lot with date received and customer reference number if applicable.\n\nStep 6: Notify the processing team that a new intake is staged and ready.\n\nNotes:\n- Never accept items that are leaking, smoking, or show signs of chemical damage\n- Batteries must be placed in the designated battery bin immediately\n- If unsure about an item, ask a supervisor before accepting',
    updated: '2026-06-12'
  },
  {
    id: 'sop-2',
    sopId: 'SOP-002',
    title: 'Hard Drive Data Destruction',
    volume: 'V2',
    sortOrder: 2,
    category: 'Data Destruction',
    body: 'Purpose: Ensure all data-bearing devices are destroyed completely and documented correctly. This SOP has zero tolerance for errors.\n\nStep 1: Identify all data-bearing devices in the lot — hard drives, SSDs, phones, tablets, laptops.\n\nStep 2: Log each device by make, model, and serial number before destruction.\n\nStep 3: Process each device through the approved destruction method for its type:\n- Hard drives: physical shredding or degaussing\n- SSDs and flash storage: physical shredding only (degaussing does not work)\n- Phones and tablets: physical shredding\n\nStep 4: Document destruction completion — note date, time, method, and staff member who performed it.\n\nStep 5: Generate certificate of destruction for the customer if requested.\n\nStep 6: Place destroyed material in the certified destruction bin — do not mix with general e-scrap.\n\nNotes:\n- Never skip logging a device — documentation is legally required\n- If a device cannot be processed immediately, store it in the locked staging area\n- Questions about a specific device type go to the supervisor before proceeding',
    updated: '2026-06-12'
  }
];

// In-memory stores
let posts = [];
let team = [];
let settings = {};
let supplies = { items: [], flags: [] };
let pickups = { flags: [] };
let sops = [];

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
 * loadData — read the on-disk stores into memory at startup.
 * Creates the data + photos directories if missing, then loads each
 * JSON file, falling back to defaults when a file is missing or
 * corrupt. A baseline is written back so the files always exist.
 */
function loadData() {
  // 1 & 2: ensure /data/ops-data/ and /data/ops-data/photos/ exist.
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  } catch (err) {
    console.error('[OPS] Could not create data dirs:', err.message);
  }

  // 3, 4, 5: load posts / team / settings with safe fallbacks.
  posts = readJsonFile(path.join(DATA_DIR, 'posts.json'), []);
  team = readJsonFile(path.join(DATA_DIR, 'team.json'), DEFAULT_TEAM.slice());
  settings = readJsonFile(path.join(DATA_DIR, 'settings.json'), Object.assign({}, DEFAULT_SETTINGS));
  supplies = readJsonFile(path.join(DATA_DIR, 'supplies.json'), null);
  pickups = readJsonFile(path.join(DATA_DIR, 'pickups.json'), null);
  sops = readJsonFile(path.join(DATA_DIR, 'sops.json'), null);

  if (!Array.isArray(posts)) posts = [];
  if (!Array.isArray(team)) team = DEFAULT_TEAM.slice();
  if (!settings || typeof settings !== 'object') settings = Object.assign({}, DEFAULT_SETTINGS);
  if (!settings.staffPin) settings.staffPin = DEFAULT_SETTINGS.staffPin;
  if (!settings.adminPin) settings.adminPin = DEFAULT_SETTINGS.adminPin;
  if (!supplies || typeof supplies !== 'object' ||
      !Array.isArray(supplies.items) || !Array.isArray(supplies.flags)) {
    supplies = JSON.parse(JSON.stringify(DEFAULT_SUPPLIES));
  }
  if (!pickups || typeof pickups !== 'object' || !Array.isArray(pickups.flags)) {
    pickups = JSON.parse(JSON.stringify(DEFAULT_PICKUPS));
  }
  // Missing/corrupt sops.json -> pre-load the two placeholders. An
  // empty array is a valid state (admin removed all) and is kept.
  if (!Array.isArray(sops)) sops = JSON.parse(JSON.stringify(DEFAULT_SOPS));
  // Normalize every XOS entry to the new schema. Legacy entries without a
  // volume become 'UN' (Unassigned) with sortOrder 0 until they are mapped.
  sops = sops.map(function (s) {
    if (!s || typeof s !== 'object') return s;
    if (typeof s.volume !== 'string' || ['V1', 'V2', 'V3', 'HR', 'UN'].indexOf(s.volume) === -1) {
      s.volume = 'UN';
    }
    if (typeof s.sortOrder !== 'number' || isNaN(s.sortOrder)) {
      var n = parseInt(s.sortOrder, 10);
      s.sortOrder = isNaN(n) ? 0 : n;
    }
    return s;
  });

  // Persist a baseline so the JSON files exist on first run.
  saveData();
}

/*
 * saveData — persist the stores to disk as JSON files. Posts store
 * only photo filenames (the image bytes live as files under
 * PHOTOS_DIR). Uses fs.writeFileSync and is wrapped in try/catch so a
 * write failure logs but never crashes the server. Called after every
 * create / delete / pin / team / settings change.
 */
function saveData(which) {
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
    if (!which || which === 'supplies') {
      fs.writeFileSync(path.join(DATA_DIR, 'supplies.json'), JSON.stringify(supplies, null, 2));
    }
    if (!which || which === 'pickups') {
      fs.writeFileSync(path.join(DATA_DIR, 'pickups.json'), JSON.stringify(pickups, null, 2));
    }
    if (!which || which === 'sops') {
      fs.writeFileSync(path.join(DATA_DIR, 'sops.json'), JSON.stringify(sops, null, 2));
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
 * Returns { fields: {}, photos: [] } where photos are FILENAMES of
 * images saved to PHOTOS_DIR on disk. Pure Buffer work — no external
 * packages.
 * ------------------------------------------------------------------ */

const MAX_PHOTO_BYTES = 3 * 1024 * 1024; // 3MB per photo (before compression)
const MAX_PHOTOS = 8;

function mimeFromFilename(name) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  return 'image/jpeg';
}

/* Pick a file extension from a mime type (falling back to the name). */
function extFromMime(mime, fallbackName) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'image/jpeg') return 'jpg';
  const ext = (String(fallbackName).split('.').pop() || '').toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  if (['png', 'gif', 'webp', 'heic', 'jpg'].indexOf(ext) !== -1) return ext;
  return 'jpg';
}

/*
 * Write image bytes to PHOTOS_DIR and return the bare filename.
 * Filename format: [unix-seconds]-[random4digits].[ext]
 * e.g. 1780669800-4821.jpg  — retried if it would collide.
 */
function savePhotoFile(buffer, mime, originalName) {
  const ext = extFromMime(mime, originalName);
  let filename;
  let attempts = 0;
  do {
    const ts = Math.floor(Date.now() / 1000);
    const rand = Math.floor(1000 + Math.random() * 9000);
    filename = ts + '-' + rand + '.' + ext;
    attempts++;
  } while (fs.existsSync(path.join(PHOTOS_DIR, filename)) && attempts < 20);
  if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTOS_DIR, filename), buffer);
  return filename;
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
      // Save the image bytes to disk; store only the filename.
      try {
        const saved = savePhotoFile(content, mime, fileMatch[1]);
        result.photos.push(saved);
      } catch (e) {
        console.error('[OPS] Failed to save photo:', e.message);
      }
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
  const loc = query.location;
  const admin = isAdmin(req);

  // Management feed is admin-only. Staff (or anyone without the admin
  // header) get an empty array — management posts are never exposed.
  if (loc === 'Management') {
    if (!admin) return sendJson(res, 200, []);
    return sendJson(res, 200, sortPosts(
      posts.filter(function (p) { return p.location === 'Management'; })
    ));
  }

  let list = posts;
  if (loc && loc !== 'All') {
    // Posts tagged "All" appear under every location filter.
    list = posts.filter(function (p) { return p.location === loc || p.location === 'All'; });
  }
  // Never include Management posts in any non-Management query (this
  // also keeps them out of the location=All feed that staff load).
  list = list.filter(function (p) { return p.location !== 'Management'; });
  sendJson(res, 200, sortPosts(list));
}

/*
 * Serve a photo file from PHOTOS_DIR. Content-Type is derived from the
 * file extension. Returns 404 if the file does not exist. The filename
 * is reduced to its basename to prevent path traversal.
 */
function handleGetPhoto(req, res, filename) {
  try {
    const safe = path.basename(decodeURIComponent(filename));
    const file = path.join(PHOTOS_DIR, safe);
    if (!safe || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return sendJson(res, 404, { success: false, error: 'Photo not found' });
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': mimeFromFilename(safe),
      'Content-Length': data.length,
      'Cache-Control': 'public, max-age=31536000, immutable'
    });
    res.end(data);
  } catch (err) {
    console.error('[OPS] photo serve error:', err.message);
    sendJson(res, 404, { success: false, error: 'Photo not found' });
  }
}

function handleCreatePost(req, res) {
  const ct = req.headers['content-type'] || '';
  // Body cap: 8 photos * 3MB + multipart overhead + fields ≈ generous 32MB.
  readBody(req, 32 * 1024 * 1024, function (err, buf) {
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
      // Posting to the Management feed is admin-only.
      if (location === 'Management' && !isAdmin(req)) {
        return sendJson(res, 403, { success: false, error: 'Unauthorized' });
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
  const removed = posts[idx];
  // Delete associated photo files from disk.
  if (removed && Array.isArray(removed.photos)) {
    removed.photos.forEach(function (fn) {
      try {
        const safe = path.basename(String(fn));
        const file = path.join(PHOTOS_DIR, safe);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (e) {
        console.error('[OPS] Failed to delete photo ' + fn + ':', e.message);
      }
    });
    removed.photos = [];
  }
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
 * Supplies tracker handlers
 *
 * Stored on disk in supplies.json via the same loadData/saveData
 * pattern. Reads are open (staff need to see + flag); admin-only
 * mutations (status changes, add/remove items) require the
 * X-Access-Level: admin header, exactly like other admin actions.
 * ------------------------------------------------------------------ */

function handleGetSupplies(req, res) {
  sendJson(res, 200, { items: supplies.items, flags: supplies.flags });
}

/* Staff (or anyone) toggles a low-stock flag for an item at a location. */
function handleFlagSupply(req, res) {
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const itemId = String(body.itemId || '');
      const location = String(body.location || '').trim();
      if (!itemId || !location) {
        return sendJson(res, 400, { success: false, error: 'Missing itemId or location' });
      }
      if (!supplies.items.some(function (i) { return i.id === itemId; })) {
        return sendJson(res, 404, { success: false, error: 'Item not found' });
      }
      const idx = supplies.flags.findIndex(function (f) {
        return f.itemId === itemId && f.location === location;
      });
      if (idx >= 0 && supplies.flags[idx].status === 'flagged') {
        supplies.flags.splice(idx, 1); // un-flag
      } else if (idx < 0) {
        supplies.flags.push({ itemId: itemId, location: location, status: 'flagged', ts: new Date().toISOString() });
      } // confirmed/ordered flags are left for admins to manage
      saveData('supplies');
      sendJson(res, 200, { success: true, flags: supplies.flags });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not update flag' });
    }
  });
}

/* Admin moves a flag through confirmed -> ordered, or clears it. */
function handleSupplyStatus(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const itemId = String(body.itemId || '');
      const location = String(body.location || '').trim();
      const status = String(body.status || '').trim();
      const idx = supplies.flags.findIndex(function (f) {
        return f.itemId === itemId && f.location === location;
      });
      if (idx < 0) return sendJson(res, 404, { success: false, error: 'Flag not found' });
      if (status === 'clear') {
        supplies.flags.splice(idx, 1);
      } else if (status === 'confirmed' || status === 'ordered') {
        supplies.flags[idx].status = status;
      } else {
        return sendJson(res, 400, { success: false, error: 'Invalid status' });
      }
      saveData('supplies');
      sendJson(res, 200, { success: true, flags: supplies.flags });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not update status' });
    }
  });
}

/* Admin adds a new supply item. */
function handleAddSupplyItem(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const name = String(body.name || '').trim();
      const category = String(body.category || 'Other').trim() || 'Other';
      if (!name) return sendJson(res, 400, { success: false, error: 'Item name required' });
      if (supplies.items.some(function (i) { return i.name.toLowerCase() === name.toLowerCase(); })) {
        return sendJson(res, 400, { success: false, error: 'That item already exists' });
      }
      const item = {
        id: 's-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        name: name,
        category: category
      };
      supplies.items.push(item);
      saveData('supplies');
      sendJson(res, 200, { success: true, item: item, items: supplies.items });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not add item' });
    }
  });
}

/* Admin removes a supply item and any flags referencing it. */
function handleDeleteSupplyItem(req, res, id) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  const target = decodeURIComponent(id);
  const before = supplies.items.length;
  supplies.items = supplies.items.filter(function (i) { return i.id !== target; });
  if (supplies.items.length === before) return sendJson(res, 404, { success: false, error: 'Not found' });
  supplies.flags = supplies.flags.filter(function (f) { return f.itemId !== target; });
  saveData('supplies');
  sendJson(res, 200, { success: true });
}

/* ------------------------------------------------------------------ *
 * Pickup-needed handlers
 *
 * Same pattern as supplies flags: stored on disk in pickups.json via
 * loadData/saveData, staff (or anyone) can raise a flag with no admin
 * check, admin-only to resolve. There is no persisted catalog to pick
 * an itemId from — each flag records location + palletType directly,
 * palletType chosen from the hardcoded PALLET_TYPES list, mirroring
 * the supplies "category" convention exactly.
 * ------------------------------------------------------------------ */

function handleGetPickups(req, res) {
  sendJson(res, 200, { flags: pickups.flags });
}

/* Staff (or anyone) raises a pickup-needed flag for a location. */
function handleFlagPickup(req, res) {
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const location = String(body.location || '').trim();
      const palletTypeRaw = String(body.palletType || '').trim();
      const palletType = PALLET_TYPES.indexOf(palletTypeRaw) !== -1 ? palletTypeRaw : 'Other';
      const note = String(body.note || '').trim().slice(0, 500);
      if (!location) {
        return sendJson(res, 400, { success: false, error: 'Missing location' });
      }
      const flag = {
        id: 'pk-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        location: location,
        palletType: palletType,
        note: note,
        status: 'flagged',
        ts: new Date().toISOString()
      };
      pickups.flags.push(flag);
      saveData('pickups');
      sendJson(res, 200, { success: true, flags: pickups.flags });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not create flag' });
    }
  });
}

/* Admin resolves (clears) a pickup-needed flag once handled. */
function handlePickupStatus(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 16 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const id = String(body.id || '');
      const status = String(body.status || '').trim();
      const idx = pickups.flags.findIndex(function (f) { return f.id === id; });
      if (idx < 0) return sendJson(res, 404, { success: false, error: 'Flag not found' });
      if (status === 'resolved') {
        pickups.flags.splice(idx, 1);
      } else {
        return sendJson(res, 400, { success: false, error: 'Invalid status' });
      }
      saveData('pickups');
      sendJson(res, 200, { success: true, flags: pickups.flags });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not update status' });
    }
  });
}

/* ------------------------------------------------------------------ *
 * SOP (Standard Operating Procedure) handlers
 *
 * Stored on disk in sops.json. Reading is open (staff search/read
 * without a PIN); create/update/delete require X-Access-Level: admin,
 * gated by the existing admin PIN like every other admin action.
 * ------------------------------------------------------------------ */

function handleGetSops(req, res) {
  sendJson(res, 200, sops);
}

function handleCreateSop(req, res) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 256 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const title = String(body.title || '').trim();
      const volRaw = String(body.volume || '').trim();
      const volume = SOP_VOLUMES.indexOf(volRaw) !== -1 ? volRaw : 'UN';
      let sortOrder = parseInt(body.sortOrder, 10);
      if (isNaN(sortOrder)) sortOrder = 0;
      const sopId = String(body.sopId || '').trim();
      const content = String(body.body || '').trim();
      if (!title) return sendJson(res, 400, { success: false, error: 'Title required' });
      if (!content) return sendJson(res, 400, { success: false, error: 'Content required' });
      const sop = {
        id: 'sop-' + Date.now() + '-' + Math.floor(Math.random() * 10000),
        sopId: sopId,
        title: title,
        volume: volume,
        sortOrder: sortOrder,
        body: content,
        updated: new Date().toISOString().slice(0, 10)
      };
      sops.push(sop);
      saveData('sops');
      sendJson(res, 200, { success: true, sop: sop });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not create SOP' });
    }
  });
}

function handleUpdateSop(req, res, id) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  readBody(req, 256 * 1024, function (err, buf) {
    if (err) return sendJson(res, 400, { success: false, error: err.message });
    try {
      const target = decodeURIComponent(id);
      const sop = sops.find(function (s) { return s.id === target; });
      if (!sop) return sendJson(res, 404, { success: false, error: 'Not found' });
      const body = JSON.parse(buf.toString('utf8') || '{}');
      const title = String(body.title || '').trim();
      const content = String(body.body || '').trim();
      if (!title) return sendJson(res, 400, { success: false, error: 'Title required' });
      if (!content) return sendJson(res, 400, { success: false, error: 'Content required' });
      sop.title = title;
      sop.sopId = String(body.sopId || '').trim();
      sop.body = content;
      if (body.volume !== undefined) {
        var v = String(body.volume || '').trim();
        if (SOP_VOLUMES.indexOf(v) !== -1 || v === 'UN') sop.volume = v;
      }
      if (body.sortOrder !== undefined) {
        var so = parseInt(body.sortOrder, 10);
        if (!isNaN(so)) sop.sortOrder = so;
      }
      sop.updated = new Date().toISOString().slice(0, 10);
      saveData('sops');
      sendJson(res, 200, { success: true, sop: sop });
    } catch (e) {
      sendJson(res, 500, { success: false, error: 'Could not update SOP' });
    }
  });
}

function handleDeleteSop(req, res, id) {
  if (!isAdmin(req)) return sendJson(res, 403, { success: false, error: 'Admin only' });
  const target = decodeURIComponent(id);
  const before = sops.length;
  sops = sops.filter(function (s) { return s.id !== target; });
  if (sops.length === before) return sendJson(res, 404, { success: false, error: 'Not found' });
  saveData('sops');
  sendJson(res, 200, { success: true });
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
    if ((m = /^\/api\/photo\/([^/]+)$/.exec(pathname)) && (method === 'GET' || method === 'HEAD')) {
      return handleGetPhoto(req, res, m[1]);
    }
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

    // Supplies tracker
    if (pathname === '/api/supplies' && method === 'GET') {
      return handleGetSupplies(req, res);
    }
    if (pathname === '/api/supplies/flag' && method === 'POST') {
      return handleFlagSupply(req, res);
    }
    if (pathname === '/api/supplies/flag/status' && method === 'POST') {
      return handleSupplyStatus(req, res);
    }
    if (pathname === '/api/supplies/items' && method === 'POST') {
      return handleAddSupplyItem(req, res);
    }
    if ((m = /^\/api\/supplies\/items\/([^/]+)$/.exec(pathname)) && method === 'DELETE') {
      return handleDeleteSupplyItem(req, res, m[1]);
    }

    // Pickup-needed flags
    if (pathname === '/api/pickups' && method === 'GET') {
      return handleGetPickups(req, res);
    }
    if (pathname === '/api/pickups/flag' && method === 'POST') {
      return handleFlagPickup(req, res);
    }
    if (pathname === '/api/pickups/flag/status' && method === 'POST') {
      return handlePickupStatus(req, res);
    }

    // SOPs
    if (pathname === '/api/sops' && method === 'GET') {
      return handleGetSops(req, res);
    }
    if (pathname === '/api/sops' && method === 'POST') {
      return handleCreateSop(req, res);
    }
    if ((m = /^\/api\/sops\/([^/]+)$/.exec(pathname)) && method === 'PUT') {
      return handleUpdateSop(req, res, m[1]);
    }
    if ((m = /^\/api\/sops\/([^/]+)$/.exec(pathname)) && method === 'DELETE') {
      return handleDeleteSop(req, res, m[1]);
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
.tab-badge{display:inline-flex; align-items:center; justify-content:center; margin-left:6px;
  min-width:18px; height:18px; padding:0 5px; border-radius:9px; background:var(--urgent);
  color:#fff; font-size:11px; font-weight:700; vertical-align:middle;}
.tab.active .tab-badge{background:#fff; color:var(--urgent);}

/* Admin supplies alert banner */
.sup-alert{display:flex; align-items:center; gap:10px; margin:10px 12px 0; padding:10px 12px;
  background:var(--urgent-l); border:1px solid var(--urgent); border-radius:10px;}
.sup-alert .sa-text{flex:1; font-size:13px; font-weight:600; color:var(--urgent); line-height:1.35;}
.sup-alert .sa-review{background:var(--urgent); color:#fff; border:none; border-radius:8px;
  min-height:34px; padding:6px 14px; font-size:12px; font-weight:700; white-space:nowrap;}
.sup-alert .sa-x{background:none; border:none; color:var(--urgent); font-size:22px; line-height:1;
  min-width:30px; min-height:30px; padding:0;}

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

/* Supplies tab */
#supplies{padding:0 12px;}
.sup-card{background:var(--card); border:0.5px solid var(--border); border-radius:12px;
  padding:14px; margin-bottom:10px;}
.sup-card-title{font-size:11px; font-weight:700; color:var(--text2); text-transform:uppercase;
  letter-spacing:1px; margin-bottom:10px;}
.sup-loc-bar{display:flex; gap:8px; flex-wrap:wrap;}
.sup-subtabs{display:flex; gap:8px; margin-bottom:10px; overflow-x:auto; padding-bottom:2px;}
.sup-subtabs::-webkit-scrollbar{display:none;}
.sup-pill{flex:0 0 auto; min-height:36px; padding:7px 16px; border-radius:18px;
  border:1.5px solid var(--green); background:#fff; color:var(--green); font-weight:600;
  font-size:13px; white-space:nowrap;}
.sup-pill.active{background:var(--green); color:#fff;}
.sup-list{display:flex; flex-direction:column; gap:8px;}
.sup-row{background:#fff; border:1px solid var(--border); border-radius:10px;
  padding:12px 14px; display:flex; align-items:center; gap:10px;}
.sup-row.flagged{border-color:var(--urgent); background:var(--urgent-l);}
.sup-row.confirmed{border-color:var(--warning); background:var(--warning-l);}
.sup-row.ordered{border-color:var(--success); background:var(--success-l);}
.sup-name{font-size:14px; font-weight:600; color:var(--text);}
.sup-cat{font-size:12px; color:var(--text2); margin-top:2px;}
.sup-status{font-size:10px; font-weight:700; padding:3px 9px; border-radius:10px;
  white-space:nowrap; text-transform:uppercase; letter-spacing:.3px;}
.sup-status.ok{background:var(--green-light); color:var(--green);}
.sup-status.flagged{background:var(--urgent-l); color:var(--urgent);}
.sup-status.confirmed{background:var(--warning-l); color:var(--warning);}
.sup-status.ordered{background:var(--success-l); color:var(--success);}
.sup-flag-btn{border:1.5px solid var(--green); background:#fff; color:var(--green);
  border-radius:8px; min-height:38px; padding:7px 14px; font-size:13px; font-weight:600;
  white-space:nowrap;}
.sup-flag-btn:active{background:var(--green-light);}
.sup-flag-btn.unflag{border-color:var(--urgent); color:var(--urgent);}
.sup-summary{display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:10px;}
@media(max-width:440px){.sup-summary{grid-template-columns:1fr 1fr;}}
.sup-stat{background:var(--green-light); border:1px solid var(--border); border-radius:12px;
  padding:10px 6px; text-align:center;}
.sup-stat .n{font-size:20px; font-weight:700; line-height:1.1; color:var(--green);}
.sup-stat .l{font-size:10px; color:var(--text2); margin-top:3px;}
.sup-stat.low .n{color:var(--urgent);}
.sup-stat.confirmed .n{color:var(--warning);}
.sup-stat.ordered .n{color:var(--success);}
.sup-arow{background:#fff; border:1px solid var(--border); border-radius:10px;
  padding:12px 14px; margin-bottom:8px;}
.sup-arow-top{display:flex; align-items:center; gap:10px;}
.sup-actions{display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;}
.sup-act{border:1.5px solid var(--border); background:#fff; color:var(--text2);
  border-radius:8px; min-height:36px; padding:6px 12px; font-size:12px; font-weight:600;}
.sup-act.confirm{border-color:var(--warning); color:var(--warning);}
.sup-act.order{border-color:var(--success); color:var(--success);}
.sup-act.clear{border-color:var(--text2); color:var(--text2);}
.sup-act.del{border-color:var(--urgent); color:var(--urgent);}
.sup-loc-tag{font-size:12px; color:var(--text2); margin-top:3px;}
.sup-add{display:flex; flex-direction:column; gap:8px; margin-top:12px;
  border-top:1px solid var(--border); padding-top:12px;}
.sup-add input,.sup-add select{width:100%; padding:10px 12px; border:1.5px solid var(--border);
  border-radius:10px; font-size:15px; font-family:inherit; background:#fff; color:var(--text);}
.sup-empty{text-align:center; color:var(--text2); padding:28px 16px; font-size:14px;}
.sup-toast{position:fixed; bottom:84px; left:50%; transform:translateX(-50%);
  background:var(--green); color:#fff; font-size:13px; font-weight:600; padding:9px 20px;
  border-radius:20px; opacity:0; transition:opacity .2s; pointer-events:none; z-index:100;}
.sup-toast.show{opacity:1;}

/* SOPs tab */
#sops{padding:0 12px;}
.sop-toggle{display:flex; gap:8px; margin-bottom:10px;}
.sop-search-wrap{position:relative; margin-bottom:10px;}
.sop-search{width:100%; padding:12px 14px 12px 38px; border:1.5px solid var(--border);
  border-radius:10px; font-size:15px; font-family:inherit; background:#fff; color:var(--text);}
.sop-search:focus{outline:none; border-color:var(--green);}
.sop-search-icon{position:absolute; left:12px; top:50%; transform:translateY(-50%);
  color:var(--text2); pointer-events:none;}
.sop-cat-bar{display:flex; gap:6px; flex-wrap:wrap; margin-bottom:12px;}
.sop-cat-btn{background:#fff; border:1.5px solid var(--green); color:var(--green);
  border-radius:16px; padding:6px 12px; font-size:12px; font-weight:600; white-space:nowrap;
  min-height:32px;}
.sop-cat-btn.active{background:var(--green); color:#fff;}
.sop-list{display:flex; flex-direction:column; gap:8px;}
.sop-card{background:#fff; border:1px solid var(--border); border-radius:12px;
  padding:12px 14px; cursor:pointer;}
.sop-card:active{border-color:var(--green);}
.sop-card-head{display:flex; align-items:flex-start; gap:10px;}
.sop-card-title{flex:1; font-size:14px; font-weight:600; color:var(--text); line-height:1.3;}
.sop-chev{color:var(--text2); flex-shrink:0; margin-top:2px;}
.sop-card-meta{display:flex; align-items:center; gap:8px; margin-top:6px;}
.sop-badge{font-size:10px; font-weight:700; padding:3px 9px; border-radius:10px;
  background:var(--green-light); color:var(--green); text-transform:uppercase; letter-spacing:.3px;}
.sop-idtag{font-size:11px; color:var(--text2);}
.sop-preview{font-size:13px; color:var(--text2); margin-top:6px; line-height:1.5;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;}
.sop-highlight{background:var(--green-light); color:var(--green); border-radius:2px; padding:0 2px;}
.sop-vol-header{font-size:12px; font-weight:700; color:var(--green); text-transform:uppercase;
  letter-spacing:.6px; margin:14px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--border);}
.sop-vol-header:first-child{margin-top:2px;}
.sop-empty{text-align:center; color:var(--text2); padding:28px 16px; font-size:14px;}
.sop-back{background:none; border:none; color:var(--green); font-size:14px; font-weight:600;
  cursor:pointer; padding:6px 0; margin-bottom:8px; display:flex; align-items:center; gap:6px;
  min-height:40px;}
.sop-detail-title{font-size:20px; font-weight:700; margin-bottom:6px; line-height:1.3; color:var(--text);}
.sop-detail-meta{display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap;}
.sop-detail-body{font-size:14px; color:var(--text); line-height:1.8; white-space:pre-wrap;
  word-break:break-word;}
.sop-updated{font-size:11px; color:var(--text2);}
.sop-arow{background:#fff; border:1px solid var(--border); border-radius:10px;
  padding:12px 14px; display:flex; align-items:center; gap:10px; margin-bottom:8px;}
.sop-arow-name{flex:1; font-size:14px; font-weight:600;}
.sop-arow-cat{font-size:12px; color:var(--text2); margin-top:2px;}
.sop-act{border:1.5px solid var(--border); background:#fff; color:var(--text2);
  border-radius:8px; min-height:36px; padding:6px 12px; font-size:12px; font-weight:600;}
.sop-act.edit{border-color:var(--green); color:var(--green);}
.sop-act.del{border-color:var(--urgent); color:var(--urgent);}
.sop-field{margin-bottom:12px;}
.sop-field label{display:block; font-size:13px; font-weight:600; margin-bottom:5px;}
.sop-field input,.sop-field select,.sop-field textarea{width:100%; padding:10px 12px;
  border:1.5px solid var(--border); border-radius:10px; font-size:15px; font-family:inherit;
  background:#fff; color:var(--text);}
.sop-field textarea{min-height:200px; resize:vertical; line-height:1.6;}
.sop-form-actions{display:flex; gap:8px; margin-top:8px;}
.sop-save{flex:1; background:var(--green); color:#fff; border:none; border-radius:10px;
  min-height:46px; font-size:15px; font-weight:700;}
.sop-cancel{flex:1; background:#fff; color:var(--text2); border:1.5px solid var(--border);
  border-radius:10px; min-height:46px; font-size:15px; font-weight:600;}

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
  <div id="supAlert" class="sup-alert hidden"></div>
  <div id="pickupAlert" class="sup-alert hidden"></div>
  <div class="stats" id="stats"></div>
  <div class="feed" id="feed"></div>
  <div id="supplies" class="hidden"></div>
  <div id="sops" class="hidden"></div>
  <div id="pickup" class="hidden"></div>

  <button class="fab" id="fab" title="Add update">+</button>
</div>
<div class="sup-toast" id="supToast"></div>

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
      <label>Photos (up to 8)</label>
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
    mgmtPosts: [],     // admin-only Management feed (kept separate)
    photos: [],        // selected File objects for new post
    pendingDelete: null,
    pinLevel: null,
    pinDigits: "",
    supLocation: "Cole",          // staff supplies location selector
    supData: { items: [], flags: [] },
    supTab: "flagged",            // admin supplies sub-tab
    supAlertCount: 0,             // admin notification: open flags needing ordering
    supAlertDismissedAt: 0,       // banner dismissed while count <= this
    pickupLocation: "Cole",       // staff pickup-needed location selector
    pickupPalletType: "TV Pallet",// staff pickup-needed pallet type selector
    pickupNote: "",
    pickupData: { flags: [] },
    pickupAlertCount: 0,          // admin notification: open pickup-needed flags
    pickupAlertDismissedAt: 0,    // banner dismissed while count <= this
    sops: [],                     // XOS entries
    sopQuery: "",                 // XOS search text
    sopVolume: "V1",              // active Volume tab in browse
    sopDetailId: null,            // open XOS detail
    sopAdminMode: false,          // admin manage vs browse
    sopAdminTab: "list",          // admin XOS sub-tab: list | add
    sopEditId: ""                 // XOS entry being edited
  };
  var SUP_LOCS = ["Cole","Dayton","Visalia"];
  var PALLET_TYPES = ["TV Pallet","Mixed Pallet","Other"];
  // XOS Volumes. UN (Unassigned) only appears while entries await mapping.
  var XOS_VOLUMES = [
    { key:"V1", label:"Volume 1", full:"Volume 1 \\u2014 Culture & Employee Handbook" },
    { key:"V2", label:"Volume 2", full:"Volume 2 \\u2014 Warehouse Operations" },
    { key:"V3", label:"Volume 3", full:"Volume 3 \\u2014 Driver & Logistics" },
    { key:"HR", label:"HR", full:"HR" },
    { key:"UN", label:"Unassigned", full:"Unassigned" }
  ];
  function volLabel(key){
    for (var i=0;i<XOS_VOLUMES.length;i++){ if (XOS_VOLUMES[i].key===key) return XOS_VOLUMES[i].label; }
    return key || "Unassigned";
  }
  function volFull(key){
    for (var i=0;i<XOS_VOLUMES.length;i++){ if (XOS_VOLUMES[i].key===key) return XOS_VOLUMES[i].full; }
    return key || "Unassigned";
  }
  function xosSort(list){
    return list.slice().sort(function(a,b){
      var d = (a.sortOrder||0) - (b.sortOrder||0);
      return d !== 0 ? d : String(a.title||"").localeCompare(String(b.title||""));
    });
  }

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
    ensureMgmtOption();
  }

  // Add/remove the "Management" choice in the Location dropdown so it
  // exists only for admins (staff never see it as an option).
  function ensureMgmtOption(){
    var sel = $("in-location");
    if (!sel) return;
    var existing = sel.querySelector('option[value="Management"]');
    if (isAdmin()){
      if (!existing){
        var opt = document.createElement("option");
        opt.value = "Management"; opt.textContent = "Management";
        sel.appendChild(opt);
      }
    } else if (existing){
      existing.parentNode.removeChild(existing);
    }
  }

  /* ---------- Tabs ---------- */
  function renderTabs(){
    // Management is admin-only; Supplies and SOPs are for everyone.
    var locs = LOCATIONS.slice();
    if (isAdmin()) locs.push("Management");
    locs.push("Supplies");
    locs.push("Pickup");
    locs.push("XOS");
    var html = "";
    for (var i=0;i<locs.length;i++){
      var loc = locs[i];
      var cls = "tab" + (loc===state.location ? " active" : "");
      var label = loc;
      // Admin notification: unread count of supplies needing ordering.
      if (loc === "Supplies" && isAdmin() && state.supAlertCount > 0){
        label += '<span class="tab-badge">' + state.supAlertCount + '</span>';
      }
      // Admin notification: unread count of open pickup-needed flags.
      if (loc === "Pickup" && isAdmin() && state.pickupAlertCount > 0){
        label += '<span class="tab-badge">' + state.pickupAlertCount + '</span>';
      }
      html += '<button class="'+cls+'" data-loc="'+loc+'">'+label+'</button>';
    }
    $("tabs").innerHTML = html;
    var btns = $("tabs").querySelectorAll(".tab");
    for (var j=0;j<btns.length;j++){
      btns[j].addEventListener("click", function(){
        state.location = this.getAttribute("data-loc");
        renderTabs();
        if (state.location === "Supplies"){
          showSuppliesView();
        } else if (state.location === "Pickup"){
          showPickupView();
        } else if (state.location === "XOS"){
          showSopsView();
        } else {
          showFeedView();
          renderStats(); renderFeed();
        }
      });
    }
  }

  // Toggle between the normal posts view and the special tab views.
  function showSuppliesView(){
    $("stats").classList.add("hidden");
    $("feed").classList.add("hidden");
    $("fab").classList.add("hidden");
    $("sops").classList.add("hidden");
    $("pickup").classList.add("hidden");
    $("supplies").classList.remove("hidden");
    renderSupAlert();
    renderPickupAlert();
    loadSupplies();
  }
  function showPickupView(){
    $("stats").classList.add("hidden");
    $("feed").classList.add("hidden");
    $("fab").classList.add("hidden");
    $("sops").classList.add("hidden");
    $("supplies").classList.add("hidden");
    $("pickup").classList.remove("hidden");
    renderSupAlert();
    renderPickupAlert();
    loadPickups();
  }
  function showSopsView(){
    $("stats").classList.add("hidden");
    $("feed").classList.add("hidden");
    $("fab").classList.add("hidden");
    $("supplies").classList.add("hidden");
    $("pickup").classList.add("hidden");
    $("sops").classList.remove("hidden");
    renderSupAlert();
    renderPickupAlert();
    state.sopDetailId = null;
    loadSops();
  }
  function showFeedView(){
    $("supplies").classList.add("hidden");
    $("pickup").classList.add("hidden");
    $("sops").classList.add("hidden");
    $("stats").classList.remove("hidden");
    $("feed").classList.remove("hidden");
    $("fab").classList.remove("hidden");
    renderSupAlert();
    renderPickupAlert();
  }

  /* ---------- Admin supplies notification ---------- */
  // "Needs ordering" = flags staff raised (flagged) or admin approved
  // but not yet ordered (confirmed).
  function countOpenFlags(flags){
    if (!Array.isArray(flags)) return 0;
    return flags.filter(function(f){
      return f.status === "flagged" || f.status === "confirmed";
    }).length;
  }
  // Refresh the tab badge + banner from a known flags array.
  function setSupAlert(flags){
    state.supAlertCount = isAdmin() ? countOpenFlags(flags) : 0;
    // Track the dismiss floor so the banner re-appears when the count
    // climbs above where it was last dismissed.
    if (state.supAlertDismissedAt > state.supAlertCount){
      state.supAlertDismissedAt = state.supAlertCount;
    }
    renderTabs();
    renderSupAlert();
  }
  // Poll the server for the current open-flag count (admins only).
  function loadSupAlerts(){
    if (!isAdmin()){ state.supAlertCount = 0; renderTabs(); renderSupAlert(); return; }
    fetch("/api/supplies")
      .then(function(r){ return r.json(); })
      .then(function(d){ setSupAlert(d && d.flags ? d.flags : []); })
      .catch(function(){});
  }
  // The banner only shows to admins, on the posts view, until dismissed.
  function renderSupAlert(){
    var el = $("supAlert");
    if (!el) return;
    var onFeed = state.location !== "Supplies" && state.location !== "XOS";
    var show = isAdmin() && state.supAlertCount > 0 && onFeed &&
               state.supAlertDismissedAt < state.supAlertCount;
    if (!show){ el.classList.add("hidden"); el.innerHTML = ""; return; }
    var n = state.supAlertCount;
    el.innerHTML =
      '<span class="sa-text">&#128276; ' + n + ' supply item' + (n === 1 ? "" : "s") +
        ' need ordering</span>' +
      '<button class="sa-review">Review</button>' +
      '<button class="sa-x" title="Dismiss">&times;</button>';
    el.classList.remove("hidden");
    el.querySelector(".sa-review").addEventListener("click", function(){
      state.location = "Supplies";
      renderTabs();
      showSuppliesView();
    });
    el.querySelector(".sa-x").addEventListener("click", function(){
      state.supAlertDismissedAt = state.supAlertCount;
      el.classList.add("hidden");
    });
  }

  /* ---------- Admin pickup-needed notification ---------- */
  // Same mechanism as the supplies alert above: any open ("flagged")
  // pickup-needed entry counts toward the badge/banner until an admin
  // resolves it.
  function countOpenPickups(flags){
    if (!Array.isArray(flags)) return 0;
    return flags.filter(function(f){ return f.status === "flagged"; }).length;
  }
  function setPickupAlert(flags){
    state.pickupAlertCount = isAdmin() ? countOpenPickups(flags) : 0;
    if (state.pickupAlertDismissedAt > state.pickupAlertCount){
      state.pickupAlertDismissedAt = state.pickupAlertCount;
    }
    renderTabs();
    renderPickupAlert();
  }
  // Polled by the same interval as loadSupAlerts (see setInterval below).
  function loadPickupAlerts(){
    if (!isAdmin()){ state.pickupAlertCount = 0; renderTabs(); renderPickupAlert(); return; }
    fetch("/api/pickups")
      .then(function(r){ return r.json(); })
      .then(function(d){ setPickupAlert(d && d.flags ? d.flags : []); })
      .catch(function(){});
  }
  function renderPickupAlert(){
    var el = $("pickupAlert");
    if (!el) return;
    var onFeed = state.location !== "Supplies" && state.location !== "Pickup" && state.location !== "XOS";
    var show = isAdmin() && state.pickupAlertCount > 0 && onFeed &&
               state.pickupAlertDismissedAt < state.pickupAlertCount;
    if (!show){ el.classList.add("hidden"); el.innerHTML = ""; return; }
    var n = state.pickupAlertCount;
    el.innerHTML =
      '<span class="sa-text">&#128230; ' + n + ' pickup' + (n === 1 ? "" : "s") +
        ' needed</span>' +
      '<button class="sa-review">Review</button>' +
      '<button class="sa-x" title="Dismiss">&times;</button>';
    el.classList.remove("hidden");
    el.querySelector(".sa-review").addEventListener("click", function(){
      state.location = "Pickup";
      renderTabs();
      showPickupView();
    });
    el.querySelector(".sa-x").addEventListener("click", function(){
      state.pickupAlertDismissedAt = state.pickupAlertCount;
      el.classList.add("hidden");
    });
  }

  /* ---------- Stats ---------- */
  function renderStats(){
    var loc = state.location;
    var todays;
    if (loc === "Management"){
      todays = state.mgmtPosts.filter(function(p){ return isToday(p.timestamp); });
    } else {
      todays = state.posts.filter(function(p){
        return (loc==="All" || p.location===loc || p.location==="All") && isToday(p.timestamp);
      });
    }
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
    var list;
    if (loc === "Management"){
      list = state.mgmtPosts.filter(function(p){ return p.location === "Management"; });
    } else {
      list = state.posts.filter(function(p){ return loc==="All" || p.location===loc || p.location==="All"; });
    }
    if (!list.length){
      if (loc === "Management"){
        $("feed").innerHTML = '<div class="empty">No management notes yet. Tap + to add one.</div>';
      } else {
        $("feed").innerHTML = '<div class="empty">No updates for '+esc(loc)+' yet.<br>Tap + to post one.</div>';
      }
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
        var purl = "/api/photo/" + encodeURIComponent(p.photos[k]);
        photos += '<img src="'+purl+'" data-full="'+purl+'" alt="photo">';
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
        return loadMgmtPosts();
      })
      .then(function(){ renderStats(); renderFeed(); })
      .catch(function(){});
  }
  // Management posts are admin-only and kept separate from state.posts
  // so they never appear in any location tab.
  function loadMgmtPosts(){
    if (!isAdmin()){ state.mgmtPosts = []; return Promise.resolve(); }
    return fetch("/api/posts?location=Management", { headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(list){ state.mgmtPosts = Array.isArray(list) ? list : []; })
      .catch(function(){ state.mgmtPosts = []; });
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
    // Pre-select Management in the Location dropdown when that tab is active.
    if (state.location === "Management" && isAdmin()){
      ensureMgmtOption();
      $("in-location").value = "Management";
    }
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

  // Compress an image File to <=1200px on the longest side, JPEG q0.85.
  // Falls back to the original file if anything goes wrong.
  function compressPhoto(file, cb){
    try {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function(){
        var max = 1200;
        var w = img.width, h = img.height;
        if (w >= h && w > max){ h = Math.round(h * max / w); w = max; }
        else if (h > w && h > max){ w = Math.round(w * max / h); h = max; }
        var canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        if (canvas.toBlob){
          canvas.toBlob(function(blob){ cb(blob || file); }, "image/jpeg", 0.85);
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
    var capacity = Math.max(0, 8 - state.photos.length);
    if (files.length > capacity){
      var dropped = files.length - capacity;
      showPhotoMsg("Max 8 photos \\u2014 " + dropped + " not added.");
    } else {
      hidePhotoMsg();
    }
    files.forEach(function(file){
      compressPhoto(file, function(blob){
        if (state.photos.length >= 8) return; // 8 total across both inputs
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

  /* ---------- Supplies ---------- */
  function loadSupplies(){
    fetch("/api/supplies")
      .then(function(r){ return r.json(); })
      .then(function(data){
        state.supData = (data && Array.isArray(data.items) && Array.isArray(data.flags))
          ? data : { items: [], flags: [] };
        setSupAlert(state.supData.flags);
        renderSupplies();
      })
      .catch(function(){ renderSupplies(); });
  }
  function supFindFlag(itemId, location){
    return state.supData.flags.filter(function(f){
      return f.itemId===itemId && f.location===location;
    })[0];
  }
  function supToast(msg){
    var t = $("supToast");
    t.textContent = msg; t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 1800);
  }
  function renderSupplies(){
    if (isAdmin()) renderSuppliesAdmin();
    else renderSuppliesStaff();
  }

  /* Staff: pick a location and flag items as running low. */
  function renderSuppliesStaff(){
    var d = state.supData;
    var locBar = "";
    for (var i=0;i<SUP_LOCS.length;i++){
      var loc = SUP_LOCS[i];
      locBar += '<button class="sup-pill'+(loc===state.supLocation?" active":"")+'" data-suploc="'+esc(loc)+'">'+esc(loc)+'</button>';
    }
    var rows = "";
    if (!d.items.length){
      rows = '<div class="sup-empty">No supplies configured yet. Ask an admin to add items.</div>';
    } else {
      for (var k=0;k<d.items.length;k++) rows += supStaffRow(d.items[k]);
    }
    $("supplies").innerHTML =
      '<div class="sup-card"><div class="sup-card-title">Your location</div>'+
        '<div class="sup-loc-bar">'+locBar+'</div></div>'+
      '<div class="sup-card"><div class="sup-card-title">Supplies — tap to flag as running low</div>'+
        '<div class="sup-list">'+rows+'</div></div>';
    var pills = $("supplies").querySelectorAll("[data-suploc]");
    for (var p=0;p<pills.length;p++){
      pills[p].addEventListener("click", function(){
        state.supLocation = this.getAttribute("data-suploc");
        renderSuppliesStaff();
      });
    }
    var fbs = $("supplies").querySelectorAll("[data-supflag]");
    for (var f=0;f<fbs.length;f++){
      fbs[f].addEventListener("click", function(){ supToggleFlag(this.getAttribute("data-supflag")); });
    }
  }
  function supStaffRow(item){
    var flag = supFindFlag(item.id, state.supLocation);
    var sc = "ok", st = "OK", ft = "Mark as low", unflag = false;
    if (flag){
      if (flag.status === "flagged"){ sc="flagged"; st="Running low"; ft="Undo flag"; unflag=true; }
      else if (flag.status === "confirmed"){ sc="confirmed"; st="Confirmed — pending order"; ft=""; }
      else if (flag.status === "ordered"){ sc="ordered"; st="Order placed"; ft=""; }
    }
    var btn = ft ? '<button class="sup-flag-btn'+(unflag?" unflag":"")+'" data-supflag="'+item.id+'">'+ft+'</button>' : '';
    return '<div class="sup-row '+sc+'">'+
      '<div style="flex:1"><div class="sup-name">'+esc(item.name)+'</div>'+
      '<div class="sup-cat">'+esc(item.category)+'</div></div>'+
      '<span class="sup-status '+sc+'">'+esc(st)+'</span>'+btn+'</div>';
  }
  function supToggleFlag(itemId){
    fetch("/api/supplies/flag", { method:"POST", headers: headers(true),
      body: JSON.stringify({ itemId:itemId, location: state.supLocation }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.flags){ state.supData.flags = res.flags; renderSupplies(); supToast("Updated"); }
        else { supToast((res&&res.error)||"Could not update"); }
      })
      .catch(function(){ supToast("Network error"); });
  }

  /* Admin: management view with summary + sub-tabs. */
  function renderSuppliesAdmin(){
    var d = state.supData;
    var low = d.flags.filter(function(f){ return f.status==="flagged"; }).length;
    var confirmed = d.flags.filter(function(f){ return f.status==="confirmed"; }).length;
    var ordered = d.flags.filter(function(f){ return f.status==="ordered"; }).length;
    var summary = '<div class="sup-summary">'+
      supStat("total", d.items.length, "Total items")+
      supStat("low", low, "Flagged low")+
      supStat("confirmed", confirmed, "Confirmed")+
      supStat("ordered", ordered, "Ordered")+'</div>';
    var subtabs = '<div class="sup-subtabs">'+
      supSubtab("flagged","Needs Attention")+
      supSubtab("all","All Items")+
      supSubtab("order","Order List")+'</div>';
    var body = "";
    if (state.supTab === "all") body = supAllView(d);
    else if (state.supTab === "order") body = supOrderView(d);
    else body = supFlaggedView(d);
    $("supplies").innerHTML = summary + subtabs + body;
    supWireAdmin();
  }
  function supStat(cls, n, label){
    return '<div class="sup-stat '+cls+'"><div class="n">'+n+'</div><div class="l">'+esc(label)+'</div></div>';
  }
  function supSubtab(key, label){
    return '<button class="sup-pill'+(state.supTab===key?" active":"")+'" data-supsubtab="'+key+'">'+esc(label)+'</button>';
  }
  function supActBtn(cls, flag, status, label){
    return '<button class="sup-act '+cls+'" data-supitem="'+esc(flag.itemId)+'" data-suploc2="'+esc(flag.location)+'" data-supstatus="'+status+'">'+esc(label)+'</button>';
  }
  function supFlaggedView(d){
    var active = d.flags.filter(function(f){ return f.status==="flagged" || f.status==="confirmed"; });
    var rows = "";
    if (!active.length){
      rows = '<div class="sup-empty">No items flagged right now.</div>';
    } else {
      for (var i=0;i<active.length;i++){
        var flag = active[i];
        var item = d.items.filter(function(it){ return it.id===flag.itemId; })[0];
        if (!item) continue;
        var btns;
        if (flag.status === "flagged"){
          btns = supActBtn("confirm", flag, "confirmed", "Confirm")+
                 supActBtn("order", flag, "ordered", "Mark ordered")+
                 supActBtn("clear", flag, "clear", "Clear");
        } else {
          btns = supActBtn("order", flag, "ordered", "Mark ordered")+
                 supActBtn("clear", flag, "clear", "Clear");
        }
        rows += '<div class="sup-arow"><div class="sup-arow-top">'+
          '<div style="flex:1"><div class="sup-name">'+esc(item.name)+'</div>'+
          '<div class="sup-loc-tag">'+esc(flag.location)+' &middot; '+esc(timeAgo(flag.ts))+'</div></div>'+
          '<div class="sup-actions">'+btns+'</div></div></div>';
      }
    }
    return '<div class="sup-card"><div class="sup-card-title">Flagged by staff — review and act</div>'+rows+'</div>';
  }
  function supAllView(d){
    var rows = "";
    if (!d.items.length){
      rows = '<div class="sup-empty">No items yet.</div>';
    } else {
      for (var i=0;i<d.items.length;i++){
        var item = d.items[i];
        rows += '<div class="sup-arow"><div class="sup-arow-top">'+
          '<div style="flex:1"><div class="sup-name">'+esc(item.name)+'</div>'+
          '<div class="sup-loc-tag">'+esc(item.category)+'</div></div>'+
          '<div class="sup-actions"><button class="sup-act del" data-supdel="'+esc(item.id)+'">Remove</button></div>'+
          '</div></div>';
      }
    }
    var addForm = '<div class="sup-add"><div class="sup-card-title" style="margin-bottom:0">Add new item</div>'+
      '<input type="text" id="sup-new-name" placeholder="Item name (e.g. Pallet wrap)">'+
      '<select id="sup-new-cat">'+
        '<option value="Shipping">Shipping</option>'+
        '<option value="Equipment">Equipment</option>'+
        '<option value="Office">Office</option>'+
        '<option value="Cleaning">Cleaning</option>'+
        '<option value="Other">Other</option>'+
      '</select>'+
      '<button class="btn-primary" id="sup-add-btn">Add item</button></div>';
    return '<div class="sup-card"><div class="sup-card-title">All supply items</div>'+rows+addForm+'</div>';
  }
  function supOrderView(d){
    var list = d.flags.filter(function(f){ return f.status==="confirmed" || f.status==="ordered"; });
    var rows = "";
    if (!list.length){
      rows = '<div class="sup-empty">No confirmed orders yet. Confirm flagged items to build the list.</div>';
    } else {
      for (var i=0;i<list.length;i++){
        var flag = list[i];
        var item = d.items.filter(function(it){ return it.id===flag.itemId; })[0];
        if (!item) continue;
        var isOrdered = flag.status === "ordered";
        var label = isOrdered ? "Ordered" : "Confirmed — needs ordering";
        var cls = isOrdered ? "ordered" : "confirmed";
        var act = isOrdered ? supActBtn("clear", flag, "clear", "Done")
                            : supActBtn("order", flag, "ordered", "Mark ordered");
        rows += '<div class="sup-row '+cls+'">'+
          '<div style="flex:1"><div class="sup-name">'+esc(item.name)+'</div>'+
          '<div class="sup-loc-tag">'+esc(flag.location)+' &middot; '+esc(label)+'</div></div>'+
          '<span class="sup-status '+cls+'">'+esc(timeAgo(flag.ts))+'</span>'+act+'</div>';
      }
    }
    return '<div class="sup-card"><div class="sup-card-title">Order list — confirmed low stock</div>'+rows+'</div>';
  }
  function supWireAdmin(){
    var sc = $("supplies");
    var subtabs = sc.querySelectorAll("[data-supsubtab]");
    for (var i=0;i<subtabs.length;i++){
      subtabs[i].addEventListener("click", function(){
        state.supTab = this.getAttribute("data-supsubtab"); renderSuppliesAdmin();
      });
    }
    var acts = sc.querySelectorAll("[data-supstatus]");
    for (var a=0;a<acts.length;a++){
      acts[a].addEventListener("click", function(){
        supSetStatus(this.getAttribute("data-supitem"), this.getAttribute("data-suploc2"), this.getAttribute("data-supstatus"));
      });
    }
    var dels = sc.querySelectorAll("[data-supdel]");
    for (var dd=0;dd<dels.length;dd++){
      dels[dd].addEventListener("click", function(){ supDeleteItem(this.getAttribute("data-supdel")); });
    }
    var addBtn = sc.querySelector("#sup-add-btn");
    if (addBtn) addBtn.addEventListener("click", supAddItem);
  }
  function supSetStatus(itemId, location, status){
    fetch("/api/supplies/flag/status", { method:"POST", headers: headers(true),
      body: JSON.stringify({ itemId:itemId, location:location, status:status }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){
          state.supData.flags = res.flags;
          setSupAlert(res.flags);
          renderSuppliesAdmin();
          supToast(status==="clear" ? "Cleared" : (status==="confirmed" ? "Confirmed" : "Marked as ordered"));
        } else { supToast((res&&res.error)||"Could not update"); }
      })
      .catch(function(){ supToast("Network error"); });
  }
  function supAddItem(){
    var name = ($("sup-new-name").value || "").trim();
    var cat = $("sup-new-cat").value;
    if (!name){ supToast("Enter an item name"); return; }
    fetch("/api/supplies/items", { method:"POST", headers: headers(true),
      body: JSON.stringify({ name:name, category:cat }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){ state.supData.items = res.items; renderSuppliesAdmin(); supToast("Item added"); }
        else { supToast((res&&res.error)||"Could not add item"); }
      })
      .catch(function(){ supToast("Network error"); });
  }
  function supDeleteItem(id){
    if (!confirm("Remove this item from the list?")) return;
    fetch("/api/supplies/items/"+encodeURIComponent(id), { method:"DELETE", headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){ loadSupplies(); supToast("Item removed"); }
        else { supToast((res&&res.error)||"Could not remove"); }
      })
      .catch(function(){ supToast("Network error"); });
  }

  /* ---------- Pickup needed ---------- */
  function loadPickups(){
    fetch("/api/pickups")
      .then(function(r){ return r.json(); })
      .then(function(data){
        state.pickupData = (data && Array.isArray(data.flags)) ? data : { flags: [] };
        setPickupAlert(state.pickupData.flags);
        renderPickups();
      })
      .catch(function(){ renderPickups(); });
  }
  function pickupToast(msg){
    var t = $("supToast");
    t.textContent = msg; t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 1800);
  }
  function renderPickups(){
    if (isAdmin()) renderPickupsAdmin();
    else renderPickupsStaff();
  }

  /* Staff: pick a location + pallet type and report a pickup needed. */
  function renderPickupsStaff(){
    var locBar = "";
    for (var i=0;i<SUP_LOCS.length;i++){
      var loc = SUP_LOCS[i];
      locBar += '<button class="sup-pill'+(loc===state.pickupLocation?" active":"")+'" data-pickuploc="'+esc(loc)+'">'+esc(loc)+'</button>';
    }
    var typeOpts = "";
    for (var t=0;t<PALLET_TYPES.length;t++){
      var pt = PALLET_TYPES[t];
      typeOpts += '<option value="'+esc(pt)+'"'+(pt===state.pickupPalletType?" selected":"")+'>'+esc(pt)+'</option>';
    }
    var mine = state.pickupData.flags.filter(function(f){ return f.location===state.pickupLocation && f.status==="flagged"; });
    var mineRows = "";
    if (mine.length){
      for (var k=0;k<mine.length;k++){
        var f = mine[k];
        mineRows += '<div class="sup-row flagged"><div style="flex:1"><div class="sup-name">'+esc(f.palletType)+'</div>'+
          '<div class="sup-cat">'+esc(timeAgo(f.ts))+(f.note?' &middot; '+esc(f.note):'')+'</div></div>'+
          '<span class="sup-status flagged">Pending</span></div>';
      }
    } else {
      mineRows = '<div class="sup-empty">No open pickup requests for this location.</div>';
    }
    $("pickup").innerHTML =
      '<div class="sup-card"><div class="sup-card-title">Location</div>'+
        '<div class="sup-loc-bar">'+locBar+'</div></div>'+
      '<div class="sup-card"><div class="sup-card-title">Report a pickup needed</div>'+
        '<select id="pickup-new-type">'+typeOpts+'</select>'+
        '<input type="text" id="pickup-new-note" placeholder="Note (optional)">'+
        '<button class="btn-primary" id="pickup-add-btn">Report pickup needed</button></div>'+
      '<div class="sup-card"><div class="sup-card-title">Open requests — '+esc(state.pickupLocation)+'</div>'+
        '<div class="sup-list">'+mineRows+'</div></div>';
    var pills = $("pickup").querySelectorAll("[data-pickuploc]");
    for (var p=0;p<pills.length;p++){
      pills[p].addEventListener("click", function(){
        state.pickupLocation = this.getAttribute("data-pickuploc");
        renderPickupsStaff();
      });
    }
    var addBtn = $("pickup-add-btn");
    if (addBtn) addBtn.addEventListener("click", pickupAdd);
  }
  function pickupAdd(){
    var type = $("pickup-new-type").value;
    var note = ($("pickup-new-note").value || "").trim();
    fetch("/api/pickups/flag", { method:"POST", headers: headers(true),
      body: JSON.stringify({ location: state.pickupLocation, palletType: type, note: note }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){
          state.pickupData.flags = res.flags;
          state.pickupPalletType = type;
          renderPickups();
          pickupToast("Reported");
        } else { pickupToast((res&&res.error)||"Could not report"); }
      })
      .catch(function(){ pickupToast("Network error"); });
  }

  /* Admin: review open pickup requests and resolve once handled. */
  function renderPickupsAdmin(){
    var open = state.pickupData.flags.filter(function(f){ return f.status==="flagged"; });
    var summary = '<div class="sup-summary">'+supStat("low", open.length, "Pickups needed")+'</div>';
    var rows = "";
    if (!open.length){
      rows = '<div class="sup-empty">No pickups needed right now.</div>';
    } else {
      for (var i=0;i<open.length;i++){
        var f = open[i];
        rows += '<div class="sup-arow"><div class="sup-arow-top">'+
          '<div style="flex:1"><div class="sup-name">'+esc(f.palletType)+'</div>'+
          '<div class="sup-loc-tag">'+esc(f.location)+' &middot; '+esc(timeAgo(f.ts))+(f.note?' &middot; '+esc(f.note):'')+'</div></div>'+
          '<div class="sup-actions"><button class="sup-act clear" data-pickupresolve="'+esc(f.id)+'">Resolve</button></div>'+
          '</div></div>';
      }
    }
    $("pickup").innerHTML = summary + '<div class="sup-card"><div class="sup-card-title">Pickups flagged by staff</div>'+rows+'</div>';
    var acts = $("pickup").querySelectorAll("[data-pickupresolve]");
    for (var a=0;a<acts.length;a++){
      acts[a].addEventListener("click", function(){ pickupResolve(this.getAttribute("data-pickupresolve")); });
    }
  }
  function pickupResolve(id){
    fetch("/api/pickups/flag/status", { method:"POST", headers: headers(true),
      body: JSON.stringify({ id:id, status:"resolved" }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){
          state.pickupData.flags = res.flags;
          setPickupAlert(res.flags);
          renderPickupsAdmin();
          pickupToast("Resolved");
        } else { pickupToast((res&&res.error)||"Could not resolve"); }
      })
      .catch(function(){ pickupToast("Network error"); });
  }

  /* ---------- SOPs ---------- */
  function loadSops(){
    fetch("/api/sops")
      .then(function(r){ return r.json(); })
      .then(function(list){
        state.sops = Array.isArray(list) ? list : [];
        renderSops();
      })
      .catch(function(){ renderSops(); });
  }
  function sopHighlight(text, q){
    var safe = esc(text);
    if (!q) return safe;
    var pat = q.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");
    try {
      var re = new RegExp("("+pat+")", "gi");
      return safe.replace(re, '<span class="sop-highlight">$1</span>');
    } catch (e){ return safe; }
  }
  function renderSops(){
    if (state.sopDetailId){ renderSopDetail(); return; }
    if (isAdmin() && state.sopAdminMode){ renderSopAdmin(); return; }
    renderSopBrowse();
  }

  function volHasEntries(key){
    return state.sops.some(function(s){ return (s.volume||"UN")===key; });
  }

  /* Browse view — open to all: search, Volume tabs, read. */
  function renderSopBrowse(){
    var toggle = "";
    if (isAdmin()){
      toggle = '<div class="sop-toggle">'+
        '<button class="sup-pill active" data-sopmode="browse">Browse XOS</button>'+
        '<button class="sup-pill" data-sopmode="manage">Manage XOS</button></div>';
    }
    // Volume tabs: V1-HR always; Unassigned only while entries await mapping.
    var tabKeys = ["V1","V2","V3","HR"];
    if (volHasEntries("UN")) tabKeys.push("UN");
    // Don't land on an empty Volume if another has content.
    if (!volHasEntries(state.sopVolume)){
      for (var t=0;t<tabKeys.length;t++){ if (volHasEntries(tabKeys[t])){ state.sopVolume = tabKeys[t]; break; } }
    }
    var tabs = "";
    for (var i=0;i<tabKeys.length;i++){
      var k = tabKeys[i];
      tabs += '<button class="sop-cat-btn'+(k===state.sopVolume?" active":"")+'" data-sopvol="'+k+'">'+esc(volLabel(k))+'</button>';
    }
    $("sops").innerHTML = toggle +
      '<div class="sop-search-wrap">'+
        '<svg class="sop-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>'+
        '<input type="text" class="sop-search" id="sopSearch" placeholder="Search XOS by keyword...">'+
      '</div>'+
      '<div class="sop-cat-bar" id="sopVolBar">'+tabs+'</div>'+
      '<div class="sop-list" id="sopList"></div>'+
      '<div class="sop-empty" id="sopEmpty" style="display:none">No XOS entries found.</div>';
    var input = $("sopSearch");
    input.value = state.sopQuery;
    input.addEventListener("input", function(){ state.sopQuery = this.value; renderSopList(); });
    var modes = $("sops").querySelectorAll("[data-sopmode]");
    for (var mi=0;mi<modes.length;mi++){
      modes[mi].addEventListener("click", function(){
        state.sopAdminMode = (this.getAttribute("data-sopmode") === "manage");
        renderSops();
      });
    }
    var volBtns = $("sops").querySelectorAll("[data-sopvol]");
    for (var v=0;v<volBtns.length;v++){
      volBtns[v].addEventListener("click", function(){
        state.sopVolume = this.getAttribute("data-sopvol");
        var all = $("sops").querySelectorAll(".sop-cat-btn");
        for (var z=0;z<all.length;z++) all[z].classList.remove("active");
        this.classList.add("active");
        renderSopList();
      });
    }
    renderSopList();
  }

  function sopCardHtml(s, q){
    var b = s.body || "";
    var preview = b.substring(0,120) + (b.length > 120 ? "..." : "");
    return '<div class="sop-card" data-sopopen="'+esc(s.id)+'">'+
      '<div class="sop-card-head">'+
        '<div class="sop-card-title">'+sopHighlight(s.title, q)+'</div>'+
        '<svg class="sop-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>'+
      '</div>'+
      '<div class="sop-card-meta"><span class="sop-badge">'+esc(volLabel(s.volume||"UN"))+'</span>'+
        (s.sopId ? '<span class="sop-idtag">'+esc(s.sopId)+'</span>' : '')+'</div>'+
      '<div class="sop-preview">'+sopHighlight(preview, q)+'</div></div>';
  }

  /* Only re-renders the result list (keeps search input focus).
   * With a query: search all Volumes, grouped under Volume headers.
   * Without: the active Volume tab's entries in sort_order sequence. */
  function renderSopList(){
    var list = $("sopList"), empty = $("sopEmpty");
    if (!list) return;
    var q = (state.sopQuery || "").trim().toLowerCase();
    var order = ["V1","V2","V3","HR","UN"];
    var html = "";
    if (q){
      var any = false;
      for (var g=0; g<order.length; g++){
        var vk = order[g];
        var matches = xosSort(state.sops.filter(function(s){
          if ((s.volume||"UN") !== vk) return false;
          return (s.title && s.title.toLowerCase().indexOf(q) !== -1) ||
                 (s.body && s.body.toLowerCase().indexOf(q) !== -1) ||
                 (s.sopId && s.sopId.toLowerCase().indexOf(q) !== -1);
        }));
        if (!matches.length) continue;
        any = true;
        html += '<div class="sop-vol-header">'+esc(volFull(vk))+'</div>';
        for (var m=0;m<matches.length;m++) html += sopCardHtml(matches[m], q);
      }
      if (!any){
        list.innerHTML = "";
        if (empty){ empty.textContent = "No XOS entries match your search."; empty.style.display = "block"; }
        return;
      }
    } else {
      var items = xosSort(state.sops.filter(function(s){ return (s.volume||"UN") === state.sopVolume; }));
      if (!items.length){
        list.innerHTML = "";
        if (empty){ empty.textContent = "No entries in this Volume yet."; empty.style.display = "block"; }
        return;
      }
      for (var i=0;i<items.length;i++) html += sopCardHtml(items[i], "");
    }
    if (empty) empty.style.display = "none";
    list.innerHTML = html;
    var cards = list.querySelectorAll("[data-sopopen]");
    for (var c=0;c<cards.length;c++){
      cards[c].addEventListener("click", function(){ openSopDetail(this.getAttribute("data-sopopen")); });
    }
  }

  function openSopDetail(id){ state.sopDetailId = id; renderSops(); window.scrollTo({top:0, behavior:"smooth"}); }
  function closeSopDetail(){ state.sopDetailId = null; renderSops(); }

  function renderSopDetail(){
    var s = state.sops.filter(function(x){ return x.id === state.sopDetailId; })[0];
    if (!s){ state.sopDetailId = null; renderSops(); return; }
    $("sops").innerHTML =
      '<button class="sop-back" id="sopBack">'+
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Back to XOS</button>'+
      '<div class="sup-card">'+
        '<div class="sop-detail-title">'+esc(s.title)+'</div>'+
        '<div class="sop-detail-meta">'+
          '<span class="sop-badge">'+esc(volLabel(s.volume||"UN"))+'</span>'+
          (s.sopId ? '<span class="sop-idtag">'+esc(s.sopId)+'</span>' : '')+
          (s.updated ? '<span class="sop-updated">Updated '+esc(s.updated)+'</span>' : '')+
        '</div>'+
        '<div class="sop-detail-body">'+esc(s.body)+'</div>'+
      '</div>';
    $("sopBack").addEventListener("click", closeSopDetail);
  }

  /* Admin manage view (admins only — gated by the existing admin PIN). */
  function renderSopAdmin(){
    var toggle = '<div class="sop-toggle">'+
      '<button class="sup-pill" data-sopmode="browse">Browse XOS</button>'+
      '<button class="sup-pill active" data-sopmode="manage">Manage XOS</button></div>';
    var subtabs = '<div class="sup-subtabs">'+
      '<button class="sup-pill'+(state.sopAdminTab==="list"?" active":"")+'" data-sopadmin="list">All XOS</button>'+
      '<button class="sup-pill'+(state.sopAdminTab==="add"?" active":"")+'" data-sopadmin="add">'+(state.sopEditId?"Edit Entry":"Add New Entry")+'</button></div>';
    var body = (state.sopAdminTab === "add") ? sopFormHtml() : sopAdminListHtml();
    $("sops").innerHTML = toggle + subtabs + body;
    sopWireAdmin();
  }
  function sopAdminListHtml(){
    if (!state.sops.length){
      return '<div class="sup-card"><div class="sup-card-title">All XOS entries — edit or remove</div>'+
        '<div class="sup-empty">No XOS entries yet. Use Add New Entry to create the first one.</div></div>';
    }
    var order = ["V1","V2","V3","HR","UN"];
    var rows = "";
    for (var g=0; g<order.length; g++){
      var vk = order[g];
      var items = xosSort(state.sops.filter(function(s){ return (s.volume||"UN")===vk; }));
      if (!items.length) continue;
      rows += '<div class="sop-vol-header">'+esc(volFull(vk))+'</div>';
      for (var i=0;i<items.length;i++){
        var s = items[i];
        rows += '<div class="sop-arow">'+
          '<div style="flex:1"><div class="sop-arow-name">'+esc(s.title)+'</div>'+
          '<div class="sop-arow-cat">#'+(s.sortOrder||0)+' &middot; '+esc(volLabel(vk))+(s.sopId?" &middot; "+esc(s.sopId):"")+'</div></div>'+
          '<div class="sup-actions">'+
            '<button class="sop-act edit" data-sopedit="'+esc(s.id)+'">Edit</button>'+
            '<button class="sop-act del" data-sopdel="'+esc(s.id)+'">Remove</button>'+
          '</div></div>';
      }
    }
    return '<div class="sup-card"><div class="sup-card-title">All XOS entries — edit or remove</div>'+rows+'</div>';
  }
  function sopFormHtml(){
    var editing = state.sopEditId ? state.sops.filter(function(s){ return s.id===state.sopEditId; })[0] : null;
    var t = editing ? editing.title : "";
    var vol = editing ? (editing.volume||"UN") : "V1";
    var so = editing ? (editing.sortOrder||0) : "";
    var sid = editing ? (editing.sopId||"") : "";
    var bd = editing ? editing.body : "";
    var opts = "";
    for (var i=0;i<XOS_VOLUMES.length;i++){
      var vv = XOS_VOLUMES[i];
      // Only surface the Unassigned option when the entry is already unassigned.
      if (vv.key === "UN" && vol !== "UN") continue;
      opts += '<option value="'+vv.key+'"'+(vv.key===vol?" selected":"")+'>'+esc(vv.full)+'</option>';
    }
    return '<div class="sup-card">'+
      '<div class="sup-card-title">'+(editing?"Edit Entry":"Add new entry")+'</div>'+
      '<div class="sop-field"><label>Title</label>'+
        '<input type="text" id="sopfTitle" placeholder="e.g. Company Standards" value="'+esc(t)+'"></div>'+
      '<div class="sop-field"><label>Volume</label><select id="sopfVol">'+opts+'</select></div>'+
      '<div class="sop-field"><label>Sort Order (chapter number within the Volume)</label>'+
        '<input type="number" id="sopfOrder" min="0" step="1" placeholder="1" value="'+esc(String(so))+'"></div>'+
      '<div class="sop-field"><label>Document ID (optional — e.g. HR-008)</label>'+
        '<input type="text" id="sopfId" placeholder="HR-008" value="'+esc(sid)+'"></div>'+
      '<div class="sop-field"><label>Content</label>'+
        '<textarea id="sopfBody" placeholder="Write the full entry content...">'+esc(bd)+'</textarea></div>'+
      '<div class="sop-form-actions">'+
        '<button class="sop-save" id="sopSave">Save Entry</button>'+
        '<button class="sop-cancel" id="sopCancel">Cancel</button>'+
      '</div></div>';
  }
  function sopWireAdmin(){
    var sc = $("sops");
    var modes = sc.querySelectorAll("[data-sopmode]");
    for (var i=0;i<modes.length;i++){
      modes[i].addEventListener("click", function(){
        state.sopAdminMode = (this.getAttribute("data-sopmode") === "manage");
        if (!state.sopAdminMode){ state.sopEditId = ""; state.sopAdminTab = "list"; }
        renderSops();
      });
    }
    var subs = sc.querySelectorAll("[data-sopadmin]");
    for (var a=0;a<subs.length;a++){
      subs[a].addEventListener("click", function(){
        state.sopAdminTab = this.getAttribute("data-sopadmin");
        if (state.sopAdminTab === "list"){ state.sopEditId = ""; }
        renderSopAdmin();
      });
    }
    var edits = sc.querySelectorAll("[data-sopedit]");
    for (var e=0;e<edits.length;e++){
      edits[e].addEventListener("click", function(){
        state.sopEditId = this.getAttribute("data-sopedit");
        state.sopAdminTab = "add";
        renderSopAdmin();
      });
    }
    var dels = sc.querySelectorAll("[data-sopdel]");
    for (var d=0;d<dels.length;d++){
      dels[d].addEventListener("click", function(){ sopDelete(this.getAttribute("data-sopdel")); });
    }
    var save = sc.querySelector("#sopSave");
    if (save) save.addEventListener("click", sopSave);
    var cancel = sc.querySelector("#sopCancel");
    if (cancel) cancel.addEventListener("click", function(){
      state.sopEditId = ""; state.sopAdminTab = "list"; renderSopAdmin();
    });
  }
  function sopSave(){
    var title = ($("sopfTitle").value || "").trim();
    var vol = $("sopfVol").value;
    var so = parseInt($("sopfOrder").value, 10); if (isNaN(so)) so = 0;
    var sid = ($("sopfId").value || "").trim();
    var bd = ($("sopfBody").value || "").trim();
    if (!title){ supToast("Please enter a title"); return; }
    if (!bd){ supToast("Please enter the content"); return; }
    var editing = !!state.sopEditId;
    var url = editing ? "/api/sops/"+encodeURIComponent(state.sopEditId) : "/api/sops";
    fetch(url, { method: editing ? "PUT" : "POST", headers: headers(true),
      body: JSON.stringify({ title:title, volume:vol, sortOrder:so, sopId:sid, body:bd }) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){
          supToast(editing ? "Entry updated" : "Entry added");
          state.sopEditId = ""; state.sopAdminTab = "list";
          loadSops();
        } else { supToast((res&&res.error)||"Could not save entry"); }
      })
      .catch(function(){ supToast("Network error"); });
  }
  function sopDelete(id){
    if (!confirm("Remove this entry? This cannot be undone.")) return;
    fetch("/api/sops/"+encodeURIComponent(id), { method:"DELETE", headers: headers(false) })
      .then(function(r){ return r.json(); })
      .then(function(res){
        if (res && res.success){ supToast("Entry removed"); loadSops(); }
        else { supToast((res&&res.error)||"Could not remove"); }
      })
      .catch(function(){ supToast("Network error"); });
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
          renderTabs();
          if (state.location === "Supplies"){ showSuppliesView(); }
          else if (state.location === "Pickup"){ showPickupView(); }
          else if (state.location === "XOS"){ showSopsView(); }
          else { showFeedView(); }
          loadTeam(); loadPosts();
          loadSupAlerts();
          loadPickupAlerts();
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
      loadSupAlerts();
      loadPickupAlerts();
    } else {
      showPin();
    }
    // Poll for admin notifications (no-op for staff): supplies needing
    // ordering and pickups needing scheduling, same 45s interval.
    setInterval(function(){ loadSupAlerts(); loadPickupAlerts(); }, 45000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
`;

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

console.log('[OPS] Server starting...');
console.log('[OPS] Storage: persistent disk at ' + DATA_DIR);
loadData();
console.log('[OPS] Photos directory: ' + PHOTOS_DIR);
console.log('[OPS] Team initialized: ' + team.length + ' members');
console.log('[OPS] Posts loaded: ' + posts.length);
console.log('[OPS] Supplies items: ' + supplies.items.length);
console.log('[OPS] SOPs loaded: ' + sops.length);
server.listen(PORT, function () {
  console.log('[OPS] Running on port ' + PORT);
  console.log('[OPS] Ready — visit /ping to verify');
});

module.exports = server;
