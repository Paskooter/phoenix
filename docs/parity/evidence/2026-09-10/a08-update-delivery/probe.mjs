// Runtime probe for parity task A-08 (Update selection / reporting / package delivery).
//
// Boots the REAL OTA service entrypoint (packages/ota/src/index.js) as a child process with a
// temporary data dir + manifest, then sends real HTTP requests for every one of the eight
// operations declared by the two pinned models
//   jiborobot/srv-jibo-server-client/apis/update-2016-03-01.normal.json      (5 ops)
//   jiborobot/srv-jibo-server-client/apis/updateadmin-2016-03-01.normal.json (3 ops)
// plus the package-delivery route, and writes the observed status/code/body to probe.json.
//
// The manifest deliberately lists os-12.6.0 BEFORE os-12.10.0 so the ListUpdatesFrom ordering
// the source imposes (update.ctrl.ts:103 sorts toVersion DESCENDING) is observable here: a
// faithful server returns 12.10.0 first even though 12.6.0 was inserted first.
//
// Run: node docs/parity/evidence/2026-09-10/a08-update-delivery/probe.mjs
// SAFETY: this only SERVES update metadata/packages over a loopback port. It never contacts,
// and never installs anything on, any physical robot.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../../..');
const ENTRY = path.join(REPO, 'packages/ota/src/index.js');

const sha1 = (b) => createHash('sha1').update(b).digest('hex');
const PKG = {
  'os-12.6.0.tar': Buffer.from('OS-IMAGE-12.6.0-'.repeat(40)),
  'os-12.10.0.tar': Buffer.from('OS-IMAGE-12.10.0-'.repeat(64)),
  'be-green.tar': Buffer.from('BE-GREEN-10.0.16-'.repeat(30)),
  'main-pkg.tar': Buffer.from('MAIN-1.0.0-'.repeat(20)),
};
// NOTE the insertion order: 12.6.0 first, then 12.10.0.
const MANIFEST = {
  version: 1,
  updates: [
    { id: 'os-12.6.0', subsystem: 'os', fromVersion: '*', toVersion: '12.6.0', changes: 'os older', filter: '', dependencies: {}, file: 'os-12.6.0.tar' },
    { id: 'os-12.10.0', subsystem: 'os', fromVersion: '*', toVersion: '12.10.0', changes: 'os latest', filter: '', dependencies: {}, file: 'os-12.10.0.tar' },
    { id: 'be-green', subsystem: 'be', fromVersion: '*', toVersion: '10.0.16', changes: 'be green', filter: 'green', dependencies: {}, file: 'be-green.tar' },
    { id: 'main-pkg', subsystem: 'main', fromVersion: '*', toVersion: '1.0.0', changes: 'main', filter: '', dependencies: {}, file: 'main-pkg.tar' },
  ],
};

const ADMIN = { 'x-amz-credentials': JSON.stringify({ id: 'acct-admin', isAdmin: true }) };
const PLAIN = { 'x-amz-credentials': JSON.stringify({ id: 'acct-plain' }) };
const ROBOT = { 'x-amz-credentials': JSON.stringify({ id: 'acct-robot', friendlyId: 'BOJW-1000-5555' }) };

function request(port, { op, body, raw, headers = {} }) {
  return new Promise((resolve, reject) => {
    const hdrs = { ...headers };
    let payload;
    if (raw) {
      payload = raw;
      hdrs['content-type'] = hdrs['content-type'] || 'application/octet-stream';
    } else {
      payload = Buffer.from(JSON.stringify(body ?? {}));
      hdrs['content-type'] = 'application/x-amz-json-1.1';
    }
    hdrs['content-length'] = payload.length;
    if (op) hdrs['x-amz-target'] = `Update_20160301.${op}`;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString()); } catch { /* empty/non-JSON body */ }
        resolve({ status: res.statusCode, headers: res.headers, bytes: buf.length, sha1: sha1(buf), json, text: buf.toString() });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: pathname }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes: buf.length, sha1: sha1(buf), buf });
      });
    }).on('error', reject);
  });
}

async function freePort() {
  return await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function waitReady(port, ms = 15000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const r = await get(port, '/healthcheck');
      if (r.status === 200) return true;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const out = { task: 'A-08', started: new Date().toISOString(), safety: 'no robot contacted; no OTA installed', steps: [] };
const rec = (name, obj) => { out.steps.push({ name, ...obj }); console.log(name, JSON.stringify(obj).slice(0, 400)); };

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'a08-probe-'));
const manifestPath = path.join(dataDir, 'manifest.json');
for (const [name, buf] of Object.entries(PKG)) await writeFile(path.join(dataDir, name), buf);
await writeFile(manifestPath, JSON.stringify(MANIFEST, null, 2));

const port = await freePort();
const child = spawn(process.execPath, [ENTRY], {
  env: { ...process.env, PORT: String(port), ETCO_ota_manifest: manifestPath, ETCO_ota_dataDir: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

try {
  const ready = await waitReady(port);
  out.port = port;
  out.entrypoint = path.relative(REPO, ENTRY);
  out.entrypoint_ready = ready;
  rec('entrypoint_boot', { ready, port, log: childLog.trim().split('\n').slice(0, 4) });
  if (!ready) throw new Error(`ota entrypoint never became ready: ${childLog}`);

  // 1. ListUpdates — subsystem defaults to "main"
  const listDefault = await request(port, { op: 'ListUpdates', body: {} });
  rec('1.ListUpdates(no subsystem -> "main")', { status: listDefault.status, ids: (listDefault.json || []).map((u) => u._id) });
  const listMain = await request(port, { op: 'ListUpdates', body: { subsystem: 'main' } });
  rec('1b.ListUpdates(subsystem=main)', { status: listMain.status, ids: (listMain.json || []).map((u) => u._id), first: listMain.json?.[0] });

  // 2. ListUpdatesFrom — ORDER IS OBSERVABLE (source sorts toVersion DESC)
  const luf = await request(port, { op: 'ListUpdatesFrom', body: { fromVersion: '3.3.4', subsystem: 'os' } });
  rec('2.ListUpdatesFrom(subsystem=os, fromVersion=3.3.4)', {
    status: luf.status,
    toVersion_order: (luf.json || []).map((u) => u.toVersion),
    ids: (luf.json || []).map((u) => u._id),
    manifest_insertion_order: ['os-12.6.0', 'os-12.10.0'],
  });

  // 3. GetUpdateFrom — optimal (highest toVersion)
  const guf = await request(port, { op: 'GetUpdateFrom', body: { fromVersion: '3.3.4', subsystem: 'os' } });
  rec('3.GetUpdateFrom', { status: guf.status, id: guf.json?._id, toVersion: guf.json?.toVersion, shaHash: guf.json?.shaHash, length: guf.json?.length, url: guf.json?.url });
  const gufNone = await request(port, { op: 'GetUpdateFrom', body: { fromVersion: '12.10.0', subsystem: 'os' } });
  rec('3b.GetUpdateFrom(no applicable)', { status: gufNone.status, code: gufNone.json?.__type, message: gufNone.json?.message });

  // 3c. error envelope for a missing required member
  const bad = await request(port, { op: 'GetUpdateFrom', body: { subsystem: 'os' } });
  rec('3c.GetUpdateFrom(missing fromVersion)', { status: bad.status, body: bad.json, x_amzn_errortype: bad.headers['x-amzn-errortype'] ?? null });

  // 4. CreateUpdate — admin-gated, raw package entity
  const asPlain = await request(port, { op: 'CreateUpdate', raw: PKG['os-12.10.0.tar'], headers: { ...PLAIN, 'x-update-from-version': '1.0.0', 'x-update-to-version': '2.0.0', 'x-update-changes': 'nope' } });
  rec('4a.CreateUpdate(non-admin)', { status: asPlain.status, code: asPlain.json?.__type, message: asPlain.json?.message });
  const created = await request(port, { op: 'CreateUpdate', raw: PKG['os-12.10.0.tar'], headers: { ...ADMIN, 'x-update-from-version': '1.0.0', 'x-update-to-version': '2.0.0', 'x-update-changes': 'probe', 'x-update-subsystem': 'os' } });
  rec('4b.CreateUpdate(admin)', { status: created.status, id: created.json?._id, length: created.json?.length, shaHash: created.json?.shaHash, filter: created.json?.filter, keys: created.json ? Object.keys(created.json).sort() : null });
  const dup = await request(port, { op: 'CreateUpdate', raw: PKG['os-12.10.0.tar'], headers: { ...ADMIN, 'x-update-from-version': '1.0.0', 'x-update-to-version': '2.0.0', 'x-update-changes': 'probe', 'x-update-subsystem': 'os' } });
  rec('4c.CreateUpdate(duplicate)', { status: dup.status, code: dup.json?.__type, message: dup.json?.message });

  // 5. RemoveUpdate
  const rmOther = await request(port, { op: 'RemoveUpdate', body: { id: created.json._id }, headers: { ...JSON.parse(JSON.stringify(ADMIN)), ...{ 'x-amz-credentials': JSON.stringify({ id: 'acct-other', isAdmin: true }) } } });
  rec('5a.RemoveUpdate(other account)', { status: rmOther.status, code: rmOther.json?.__type });
  const rmMissing = await request(port, { op: 'RemoveUpdate', body: { id: 'ffffffffffffffffffffffff' }, headers: ADMIN });
  rec('5b.RemoveUpdate(unknown id)', { status: rmMissing.status, code: rmMissing.json?.__type });
  const rmOk = await request(port, { op: 'RemoveUpdate', body: { id: created.json._id }, headers: ADMIN });
  rec('5c.RemoveUpdate(creator)', { status: rmOk.status, id: rmOk.json?._id });

  // 6. ListUniqueFilters (admin)
  const lufAnon = await request(port, { op: 'ListUniqueFilters', body: {} });
  rec('6a.ListUniqueFilters(anon)', { status: lufAnon.status, code: lufAnon.json?.__type, message: lufAnon.json?.message });
  const lufAdmin = await request(port, { op: 'ListUniqueFilters', body: {}, headers: ADMIN });
  rec('6b.ListUniqueFilters(admin)', { status: lufAdmin.status, filters: lufAdmin.json });

  // 7. SetTarget (admin)
  const setAnon = await request(port, { op: 'SetTarget', body: { serial: 'BOJW-1000-5555', target: 'green' } });
  rec('7a.SetTarget(anon)', { status: setAnon.status, code: setAnon.json?.__type });
  const setOk = await request(port, { op: 'SetTarget', body: { serial: 'BOJW-1000-5555', target: 'green' }, headers: ADMIN });
  rec('7b.SetTarget(admin)', { status: setOk.status, body: setOk.text, bytes: setOk.bytes });

  // 8. ListTargets (admin)
  const lt = await request(port, { op: 'ListTargets', body: {}, headers: ADMIN });
  rec('8.ListTargets(admin)', { status: lt.status, targets: lt.json });

  // 8b. a targeted robot sees the filter its target maps to (selection override)
  const robotSees = await request(port, { op: 'GetUpdateFrom', body: { fromVersion: '3.3.4', subsystem: 'be' }, headers: ROBOT });
  rec('8b.GetUpdateFrom(targeted robot)', { status: robotSees.status, id: robotSees.json?._id, filter: robotSees.json?.filter });
  const otherSees = await request(port, { op: 'GetUpdateFrom', body: { fromVersion: '3.3.4', subsystem: 'be' }, headers: { 'x-amz-credentials': JSON.stringify({ id: 'acct-other2', friendlyId: 'OTHER-ROBOT' }) } });
  rec('8c.GetUpdateFrom(untargeted robot)', { status: otherSees.status, code: otherSees.json?.__type });
  await request(port, { op: 'SetTarget', body: { serial: 'BOJW-1000-5555', target: null }, headers: ADMIN });

  // 9. package delivery
  const id = 'os-12.10.0';
  const pkg = await get(port, `/ota/package?id=${id}`);
  rec('9.GET /ota/package', { status: pkg.status, content_type: pkg.headers['content-type'], content_length: pkg.headers['content-length'], bytes: pkg.bytes, sha1: pkg.sha1, expected_sha1: sha1(PKG['os-12.10.0.tar']), match: pkg.sha1 === sha1(PKG['os-12.10.0.tar']) });
  const pkg404 = await get(port, '/ota/package?id=nope');
  rec('9b.GET /ota/package(unknown)', { status: pkg404.status });

  out.operations_served = out.steps.filter((s) => /^(1|2|3|4|5|6|7|8)/.test(s.name)).length;
} catch (e) {
  out.error = String(e && e.stack || e);
} finally {
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 200));
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
  out.child_log_tail = childLog.trim().split('\n').slice(-8);
  await writeFile(path.join(HERE, 'probe.json'), `${JSON.stringify(out, null, 2)}\n`);
  await rm(dataDir, { recursive: true, force: true });
  console.log('WROTE probe.json');
}
