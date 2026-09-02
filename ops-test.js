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

/* Build multipart with flat fields + one binary file part (field name "photos"). */
function multipartWithFile(fields, filename, fileBuf, mime) {
  const boundary = '----opsTestBoundary' + Date.now();
  const parts = [];
  Object.keys(fields).forEach(function (k) {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + fields[k] + '\r\n', 'utf8'));
  });
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="photos"; filename="' + filename + '"\r\nContent-Type: ' + mime + '\r\n\r\n', 'utf8'));
  parts.push(fileBuf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n', 'utf8'));
  return { body: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary };
}

// 1x1 PNG used as a disposable test photo.
const TEST_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

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
  }, JSON.stringify({ title: 'Test SOP', volume: 'V2', sortOrder: 5, sopId: 'SOP-TEST', body: 'Wear gloves.' }));
  const sopId = sopCreated.json && sopCreated.json.sop && sopCreated.json.sop.id;
  check('POST /api/sops (admin) creates an XOS entry with volume + sortOrder',
    !!sopId && sopCreated.json.sop.title === 'Test SOP' &&
    sopCreated.json.sop.volume === 'V2' && sopCreated.json.sop.sortOrder === 5 &&
    !!sopCreated.json.sop.updated,
    JSON.stringify(sopCreated.json));

  // 11. update with admin header (change volume + sortOrder)
  const sopUpdated = await request({
    method: 'PUT', path: '/api/sops/' + encodeURIComponent(sopId || 'x'),
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Test SOP Edited', volume: 'HR', sortOrder: 3, sopId: 'SOP-TEST', body: 'Wear gloves and goggles.' }));
  check('PUT /api/sops/:id (admin) updates title, volume, and sortOrder',
    sopUpdated.json && sopUpdated.json.success === true &&
    sopUpdated.json.sop.title === 'Test SOP Edited' &&
    sopUpdated.json.sop.volume === 'HR' && sopUpdated.json.sop.sortOrder === 3,
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

  // ---- To-Do Tasks ----
  // 14. GET /api/tasks returns an array
  const tasks0 = await request({ path: '/api/tasks' });
  check('GET /api/tasks returns an array', Array.isArray(tasks0.json), JSON.stringify(tasks0.json));

  // 15. create without admin header -> blocked
  const tNoAuth = await request({
    method: 'POST', path: '/api/tasks', headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'nope', location: 'Cole' }));
  check('POST /api/tasks without admin header -> blocked',
    tNoAuth.status === 403 && tNoAuth.json && tNoAuth.json.success === false, 'status=' + tNoAuth.status);

  // 16. create without createdBy -> blocked (createdBy now required)
  const tNoCreator = await request({
    method: 'POST', path: '/api/tasks',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Test task', location: 'Cole' }));
  check('POST /api/tasks without createdBy -> blocked (required)',
    tNoCreator.status === 400 && tNoCreator.json && tNoCreator.json.success === false,
    'status=' + tNoCreator.status + ' ' + JSON.stringify(tNoCreator.json));

  // 17. create with admin header + createdBy -> status open, fields set
  const tCreated = await request({
    method: 'POST', path: '/api/tasks',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Test task', location: 'Cole', assignedTo: 'Reese', createdBy: 'Manuel' }));
  const taskId = tCreated.json && tCreated.json.task && tCreated.json.task.id;
  check('POST /api/tasks (admin, zero photos) creates open task with empty referencePhotos + photos',
    !!taskId && tCreated.json.task.status === 'open' && tCreated.json.task.location === 'Cole' &&
    tCreated.json.task.assignedTo === 'Reese' && tCreated.json.task.createdBy === 'Manuel' &&
    !!tCreated.json.task.createdAt &&
    Array.isArray(tCreated.json.task.referencePhotos) && tCreated.json.task.referencePhotos.length === 0 &&
    Array.isArray(tCreated.json.task.photos) && tCreated.json.task.photos.length === 0,
    JSON.stringify(tCreated.json));

  // 18. start (staff, no admin) -> started + startedBy/At
  const tStarted = await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(taskId || 'x') + '/start',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ name: 'Nic' }));
  check('POST /api/tasks/:id/start (staff) records startedBy/At',
    tStarted.json && tStarted.json.success === true && tStarted.json.task.status === 'started' &&
    tStarted.json.task.startedBy === 'Nic' && !!tStarted.json.task.startedAt,
    JSON.stringify(tStarted.json));

  // 18. finish -> finished + finishedBy/At, and STILL PRESENT (not deleted)
  const tFinished = await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(taskId || 'x') + '/finish',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ name: 'Reese' }));
  const tasksAfterFinish = await request({ path: '/api/tasks' });
  const taskStillThere = Array.isArray(tasksAfterFinish.json) &&
    tasksAfterFinish.json.some(function (t) { return t.id === taskId && t.status === 'finished'; });
  check('POST /api/tasks/:id/finish (zero photos) records finish AND keeps the record',
    tFinished.json && tFinished.json.success === true && tFinished.json.task.status === 'finished' &&
    tFinished.json.task.finishedBy === 'Reese' && !!tFinished.json.task.finishedAt && taskStillThere &&
    Array.isArray(tFinished.json.task.photos) && tFinished.json.task.photos.length === 0,
    JSON.stringify(tFinished.json));

  // delete without admin header -> blocked
  const tDelNoAuth = await request({
    method: 'DELETE', path: '/api/tasks/' + encodeURIComponent(taskId || 'x')
  });
  check('DELETE /api/tasks/:id without admin header -> blocked',
    tDelNoAuth.status === 403 && tDelNoAuth.json && tDelNoAuth.json.success === false, 'status=' + tDelNoAuth.status);

  // delete with admin header -> removed (test cleanup)
  const tDel = await request({
    method: 'DELETE', path: '/api/tasks/' + encodeURIComponent(taskId || 'x'),
    headers: { 'X-Access-Level': 'admin' }
  });
  const tasksAfterDel = await request({ path: '/api/tasks' });
  const taskGone = Array.isArray(tasksAfterDel.json) && !tasksAfterDel.json.some(function (t) { return t.id === taskId; });
  check('DELETE /api/tasks/:id (admin) removes the task',
    tDel.json && tDel.json.success === true && taskGone, JSON.stringify(tDel.json));

  // ---- Finish WITH photos (multipart) round-trip + delete cleanup ----
  const tp = await request({
    method: 'POST', path: '/api/tasks',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': 'application/json' }
  }, JSON.stringify({ title: 'Photo task', location: 'Cole', createdBy: 'Marc' }));
  const pId = tp.json && tp.json.task && tp.json.task.id;
  await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(pId || 'x') + '/start',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ name: 'Nic' }));
  const mpf = multipartWithFile({ finishedBy: 'Reese' }, 'done.png', TEST_PNG, 'image/png');
  const pFin = await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(pId || 'x') + '/finish',
    headers: { 'Content-Type': mpf.contentType, 'Content-Length': mpf.body.length }
  }, mpf.body);
  const photoFn = pFin.json && pFin.json.task && Array.isArray(pFin.json.task.photos) && pFin.json.task.photos[0];
  check('POST /api/tasks/:id/finish (multipart) stores a completion photo',
    pFin.json && pFin.json.success === true && pFin.json.task.status === 'finished' &&
    pFin.json.task.photos.length === 1 && /^\d+-\d+\.(png|jpg)$/.test(String(photoFn)),
    JSON.stringify(pFin.json));

  // the stored photo is servable (200 with body bytes)
  const served = await request({ path: '/api/photo/' + encodeURIComponent(photoFn || 'x') });
  check('GET /api/photo/:fn serves the finish photo (200, non-empty)',
    served.status === 200 && served.raw.length > 0,
    'status=' + served.status + ' bytes=' + (served.raw ? served.raw.length : 0));

  // deleting the task removes its photo file from disk
  await request({
    method: 'DELETE', path: '/api/tasks/' + encodeURIComponent(pId || 'x'),
    headers: { 'X-Access-Level': 'admin' }
  });
  const servedAfter = await request({ path: '/api/photo/' + encodeURIComponent(photoFn || 'x') });
  check('DELETE task cleans up its photo file (GET /api/photo -> 404)',
    servedAfter.status === 404, 'status=' + servedAfter.status);

  // ---- Reference photo at CREATE, kept separate from completion photo ----
  const rpMp = multipartWithFile({ title: 'Ref task', location: 'Cole', createdBy: 'Marc' }, 'ref.png', TEST_PNG, 'image/png');
  const rpCreate = await request({
    method: 'POST', path: '/api/tasks',
    headers: { 'X-Access-Level': 'admin', 'Content-Type': rpMp.contentType, 'Content-Length': rpMp.body.length }
  }, rpMp.body);
  const rpId = rpCreate.json && rpCreate.json.task && rpCreate.json.task.id;
  const refFn = rpCreate.json && rpCreate.json.task && Array.isArray(rpCreate.json.task.referencePhotos) && rpCreate.json.task.referencePhotos[0];
  check('POST /api/tasks (multipart) stores a reference photo, completion empty',
    !!rpId && rpCreate.json.task.referencePhotos.length === 1 && rpCreate.json.task.photos.length === 0 &&
    /^\d+-\d+\.(png|jpg)$/.test(String(refFn)),
    JSON.stringify(rpCreate.json && rpCreate.json.task));

  const refServed = await request({ path: '/api/photo/' + encodeURIComponent(refFn || 'x') });
  check('GET /api/photo/:fn serves the reference photo (200, non-empty)',
    refServed.status === 200 && refServed.raw.length > 0, 'status=' + refServed.status);

  // finish it with a DISTINCT completion photo — both must coexist, not merge
  await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(rpId || 'x') + '/start',
    headers: { 'Content-Type': 'application/json' }
  }, JSON.stringify({ name: 'Nic' }));
  const compMp = multipartWithFile({ finishedBy: 'Reese' }, 'comp.png', TEST_PNG, 'image/png');
  const rpFin = await request({
    method: 'POST', path: '/api/tasks/' + encodeURIComponent(rpId || 'x') + '/finish',
    headers: { 'Content-Type': compMp.contentType, 'Content-Length': compMp.body.length }
  }, compMp.body);
  const compFn = rpFin.json && rpFin.json.task && rpFin.json.task.photos[0];
  check('reference + completion photos coexist and are DISTINCT files',
    rpFin.json && rpFin.json.success === true &&
    rpFin.json.task.referencePhotos.length === 1 && rpFin.json.task.referencePhotos[0] === refFn &&
    rpFin.json.task.photos.length === 1 && String(compFn) !== String(refFn),
    'ref=' + refFn + ' comp=' + compFn);

  // delete cleans up BOTH photo files
  await request({
    method: 'DELETE', path: '/api/tasks/' + encodeURIComponent(rpId || 'x'),
    headers: { 'X-Access-Level': 'admin' }
  });
  const refAfter = await request({ path: '/api/photo/' + encodeURIComponent(refFn || 'x') });
  const compAfter = await request({ path: '/api/photo/' + encodeURIComponent(compFn || 'x') });
  check('DELETE task cleans up BOTH reference and completion photos (both 404)',
    refAfter.status === 404 && compAfter.status === 404,
    'ref=' + refAfter.status + ' comp=' + compAfter.status);

  // ---- Team canCreateTasks flag ----
  const teamF = await request({ path: '/api/team' });
  const flagged = Array.isArray(teamF.json) ? teamF.json.filter(function (m) { return m.canCreateTasks === true; }).map(function (m) { return m.name; }) : [];
  const marc = teamF.json.find(function (m) { return m.name === 'Marc'; });
  const reese = teamF.json.find(function (m) { return m.name === 'Reese'; });
  check('GET /api/team: only Marc + Manuel have canCreateTasks=true',
    flagged.length === 2 && flagged.indexOf('Marc') !== -1 && flagged.indexOf('Manuel') !== -1 &&
    marc && marc.canCreateTasks === true && reese && !reese.canCreateTasks,
    'flagged=' + JSON.stringify(flagged));
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
