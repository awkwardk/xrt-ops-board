/*
 * ops-test.js — integration tests for XRT Ops Board.
 *
 * Usage: node ops-test.js server.js
 *
 * Spawns the server on a test port, waits for /ping, then runs the
 * 7 required checks. Exits non-zero if any test fails.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');

const serverFile = process.argv[2] || 'server.js';
const PORT = process.env.TEST_PORT || 4555;
const HOST = '127.0.0.1';

// Hermetic data dir so tests never touch the real persistent disk.
const TEST_DATA_DIR = path.join(os.tmpdir(), 'ops-test-data-' + process.pid);

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('  PASS  ' + name);
  } else {
    failed++;
    console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : ''));
  }
}

/* Minimal HTTP request helper. Returns { status, json, raw }. */
function request(opts, body) {
  return new Promise(function (resolve, reject) {
    const req = http.request({
      host: HOST,
      port: PORT,
      method: opts.method || 'GET',
      path: opts.path,
      headers: opts.headers || {}
    }, function (res) {
      const chunks = [];
      res.on('data', function (c) { chunks.push(c); });
      res.on('end', function () {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, json: json, raw: raw });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* Build a multipart/form-data body from a flat fields object. */
function multipart(fields) {
  const boundary = '----opsTestBoundary' + Date.now();
  let body = '';
  Object.keys(fields).forEach(function (k) {
    body += '--' + boundary + '\r\n';
    body += 'Content-Disposition: form-data; name="' + k + '"\r\n\r\n';
    body += fields[k] + '\r\n';
  });
  body += '--' + boundary + '--\r\n';
  return { body: Buffer.from(body, 'utf8'), contentType: 'multipart/form-data; boundary=' + boundary };
}

function waitForServer(retries) {
  return new Promise(function (resolve, reject) {
    function attempt(n) {
      request({ path: '/ping' }).then(function () { resolve(); })
        .catch(function () {
          if (n <= 0) return reject(new Error('Server did not start'));
          setTimeout(function () { attempt(n - 1); }, 200);
        });
    }
    attempt(retries);
  });
}

async function run() {
  // 1. /ping
  const ping = await request({ path: '/ping' });
  check('GET /ping returns { status: "ok" }',
    ping.json && ping.json.status === 'ok', JSON.stringify(ping.json));

  // 2. /api/posts returns array
  const posts0 = await request({ path: '/api/posts' });
  check('GET /api/posts returns an array', Array.isArray(posts0.json),
    JSON.stringify(posts0.json));

  // 3. /api/team returns 7 members
  const team = await request({ path: '/api/team' });
  check('GET /api/team returns 7 members',
    Array.isArray(team.json) && team.json.length === 7,
    team.json ? 'length=' + team.json.length : 'null');

  // 4. POST /api/posts creates a post (text fields only)
  const mp = multipart({ author: 'Reese', location: 'Cole', tag: 'info', text: 'Test update from ops-test' });
  const created = await request({
    method: 'POST', path: '/api/posts',
    headers: { 'Content-Type': mp.contentType, 'Content-Length': mp.body.length }
  }, mp.body);
  const newId = created.json && created.json.id;
  check('POST /api/posts creates a post',
    !!newId && created.json.author === 'Reese' && created.json.text === 'Test update from ops-test',
    JSON.stringify(created.json));

  // 5. DELETE /api/posts/:id with admin header
  const del = await request({
    method: 'DELETE', path: '/api/posts/' + encodeURIComponent(newId || 'x'),
    headers: { 'X-Access-Level': 'admin' }
  });
  const afterDel = await request({ path: '/api/posts' });
  const stillThere = Array.isArray(afterDel.json) && afterDel.json.some(function (p) { return p.id === newId; });
  check('DELETE /api/posts/:id (admin) removes the post',
    del.json && del.json.success === true && !stillThere, JSON.stringify(del.json));

  // 6. POST /api/settings/pins with WRONG current PIN
  const badPin = await request({
    method: 'POST', path: '/api/settings/pins',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ currentAdminPin: '0000', newStaffPin: '1111', newAdminPin: '2222' }));
  check('POST /api/settings/pins wrong PIN -> { success: false }',
    badPin.json && badPin.json.success === false, JSON.stringify(badPin.json));

  // 7. POST /api/settings/pins with CORRECT current PIN
  const goodPin = await request({
    method: 'POST', path: '/api/settings/pins',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ currentAdminPin: '9241', newStaffPin: '1234', newAdminPin: '5678' }));
  check('POST /api/settings/pins correct PIN -> updates successfully',
    goodPin.json && goodPin.json.success === true, JSON.stringify(goodPin.json));

  // ---- SOPs ----
  // 8. GET /api/sops returns the 2 pre-loaded placeholder SOPs
  const sops0 = await request({ path: '/api/sops' });
  check('GET /api/sops returns array with 2 default SOPs',
    Array.isArray(sops0.json) && sops0.json.length === 2 &&
    sops0.json.some(function (s) { return s.sopId === 'SOP-001'; }) &&
    sops0.json.some(function (s) { return s.sopId === 'SOP-002'; }),
    sops0.json ? 'length=' + sops0.json.length : 'null');

  // 9. auth enforcement: create without admin header is blocked
  const sopNoAuth = await request({
    method: 'POST', path: '/api/sops', headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Sneaky', category: 'General', body: 'nope' }));
  check('POST /api/sops without admin header -> blocked',
    sopNoAuth.status === 403 && sopNoAuth.json && sopNoAuth.json.success === false,
    'status=' + sopNoAuth.status);

  // 10. create with admin header
  const sopCreated = await request({
    method: 'POST', path: '/api/sops',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Test SOP', category: 'Safety', sopId: 'SOP-TEST', body: 'Wear gloves.' }));
  const sopId = sopCreated.json && sopCreated.json.sop && sopCreated.json.sop.id;
  check('POST /api/sops (admin) creates a SOP',
    !!sopId && sopCreated.json.sop.title === 'Test SOP' && !!sopCreated.json.sop.updated,
    JSON.stringify(sopCreated.json));

  // 11. update with admin header
  const sopUpdated = await request({
    method: 'PUT', path: '/api/sops/' + encodeURIComponent(sopId || 'x'),
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Test SOP Edited', category: 'Safety', sopId: 'SOP-TEST', body: 'Wear gloves and goggles.' }));
  check('PUT /api/sops/:id (admin) updates a SOP',
    sopUpdated.json && sopUpdated.json.success === true &&
    sopUpdated.json.sop.title === 'Test SOP Edited',
    JSON.stringify(sopUpdated.json));

  // 12. auth enforcement: delete without admin header is blocked
  const sopDelNoAuth = await request({
    method: 'DELETE', path: '/api/sops/' + encodeURIComponent(sopId || 'x')
  });
  check('DELETE /api/sops/:id without admin header -> blocked',
    sopDelNoAuth.status === 403 && sopDelNoAuth.json && sopDelNoAuth.json.success === false,
    'status=' + sopDelNoAuth.status);

  // 13. delete with admin header
  const sopDel = await request({
    method: 'DELETE', path: '/api/sops/' + encodeURIComponent(sopId || 'x'),
    headers: { 'X-Access-Level': 'admin' }
  });
  const sopsAfter = await request({ path: '/api/sops' });
  const sopGone = Array.isArray(sopsAfter.json) && !sopsAfter.json.some(function (s) { return s.id === sopId; });
  check('DELETE /api/sops/:id (admin) removes the SOP',
    sopDel.json && sopDel.json.success === true && sopGone, JSON.stringify(sopDel.json));
}

let child;
function shutdown(code) {
  if (child) { try { child.kill(); } catch (e) {} }
  try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch (e) {}
  process.exit(code);
}

console.log('Starting server: ' + serverFile + ' on port ' + PORT);
child = spawn(process.execPath, [path.resolve(serverFile)], {
  env: Object.assign({}, process.env, { PORT: String(PORT), OPS_DATA_DIR: TEST_DATA_DIR }),
  stdio: ['ignore', 'inherit', 'inherit']
});
child.on('error', function (err) {
  console.error('Failed to spawn server:', err.message);
  shutdown(1);
});

waitForServer(25).then(run).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  shutdown(failed === 0 ? 0 : 1);
}).catch(function (err) {
  console.error('\nTest harness error:', err.message);
  shutdown(1);
});
