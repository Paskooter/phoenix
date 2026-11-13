// An OS update check and the package download it leads to must be traceable to one robot in
// the OTA log, without the log ever holding who the robot is. Each line carries `robotRef`: a
// short keyed hash of the robot's identity. It is the same for the same robot (across checks,
// downloads and service restarts), different for different robots, and never the robot's
// name, serial, account id or owner email.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { recentLogs } from '@phoenix/common';
import { Catalog } from '../src/catalog.js';
import { createOtaService } from '../src/service.js';

const HOST = 'ota.fixture.test';
const SECRET = 'synthetic-ota-robot-ref-key';
const PEER_TOKEN = 'synthetic-classic-ota-peer-token';
const PAYLOAD = Buffer.from('synthetic OS 13.1.0 package bytes');
const NOW = 1_800_000_000_000;
// Content-Length can arrive before server-side source EOF/pipeline cleanup.
const downloadAgent = new http.Agent({ keepAlive: true });

// Synthetic robots. Every identifying value is distinctive so a leak is easy to find.
const ROBOTS = {
  first: { id: 'acct-robot-first-5f1c', friendlyId: 'Synthetic-Amber-Otter', email: 'first-owner@example.test', serial: 'SYNSERIAL0001' },
  second: { id: 'acct-robot-second-9a2e', friendlyId: 'Synthetic-Cobalt-Heron', email: 'second-owner@example.test', serial: 'SYNSERIAL0002' },
};
const SERIALS = new Map(Object.values(ROBOTS).map((robot) => [robot.friendlyId, robot.serial]));

let dir;
let catalog;
const servers = [];

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ota-robot-ref-'));
  await writeFile(path.join(dir, 'os-13.1.0.tar'), PAYLOAD);
  // serialOf mirrors the deployed friendlyId -> serial target lookup, so the serial is in play.
  catalog = await Catalog.load({
    dataDir: dir,
    log: {},
    serialOf: async (friendlyId) => SERIALS.get(friendlyId),
    entries: [{ id: 'os-13.1.0-fcs', subsystem: 'os', fromVersion: '*', toVersion: '13.1.0', filter: 'fcs', file: 'os-13.1.0.tar' }],
  });
});

after(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  downloadAgent.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function startService(now = () => NOW) {
  const server = await createOtaService({
    catalog,
    publicBaseUrl: `https://${HOST}`,
    packageBearerSecret: SECRET,
    resolveCredentials: () => null,
    internalPeerToken: PEER_TOKEN,
    now,
  }).listen(0, '127.0.0.1');
  servers.push(server);
  return server;
}

function request(server, { method = 'GET', pathname, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: server.address().port, method, path: pathname, headers: { host: HOST, ...headers },
      agent: downloadAgent,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The verified robot identity as it arrives through Classic's authenticated loopback hop. */
async function check(server, robot, op = 'GetUpdateFrom', query = {}) {
  return request(server, {
    method: 'POST',
    pathname: '/',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `Update_20160301.${op}`,
      'x-phoenix-ota-peer-token': PEER_TOKEN,
      'x-phoenix-verified-account': JSON.stringify({ id: robot.id, email: robot.email, friendlyId: robot.friendlyId }),
    },
    body: JSON.stringify({ fromVersion: '13.0.8', subsystem: 'os', filter: 'fcs', ...query }),
  });
}

async function issuedUrl(server, robot) {
  const response = await check(server, robot);
  assert.equal(response.status, 200);
  const update = JSON.parse(response.body);
  assert.equal(update._id, 'os-13.1.0-fcs');
  return new URL(update.url);
}

async function download(server, url) {
  const download = await request(server, { pathname: url.pathname + url.search });
  assert.equal(download.status, 200);
  assert.equal(download.headers['content-length'], String(PAYLOAD.length));
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.deepEqual(download.body, PAYLOAD);
}

/** A robot's update check, then the exact package URL offered by that check. */
async function checkAndDownload(server, robot) {
  const url = await issuedUrl(server, robot);
  await download(server, url);
  return url;
}

async function logsDuring(action, downloads = 1) {
  const { cursor } = recentLogs({ limit: 0 });
  const result = await action();
  // The download line is written when the server's stream finishes, which can trail the
  // client's last byte by a tick.
  for (let i = 0; i < 100 && recentLogs({ since: cursor, ns: 'ota' }).events.filter((l) => l.msg === 'ota package download').length < downloads; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { result, lines: recentLogs({ since: cursor, ns: 'ota', limit: 1000 }).events };
}

function refsIn(lines) {
  const check = lines.filter((line) => line.msg === 'update query');
  const download = lines.filter((line) => line.msg === 'ota package download');
  assert.equal(check.length, 1, 'one update-query line per check');
  assert.equal(download.length, 1, 'one download line per download');
  assert.equal(download[0].id, 'os-13.1.0-fcs');
  return { check: check[0].robotRef, download: download[0].robotRef };
}

function assertDownloadRef(lines, robotRef) {
  const downloads = lines.filter(line => line.msg === 'ota package download');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].id, 'os-13.1.0-fcs');
  assert.equal(downloads[0].bytes, PAYLOAD.length);
  assert.equal(downloads[0].robotRef, robotRef);
  assert.equal(lines.filter(line => line.msg === 'ota package URL rejected' || line.msg === 'ota package stream interrupted').length, 0);
}

function assertAnonymous(lines, urls) {
  const raw = JSON.stringify(lines);
  for (const robot of Object.values(ROBOTS)) {
    for (const [field, value] of Object.entries(robot)) {
      assert.ok(!raw.includes(value), `the robot's ${field} must not appear in OTA logs`);
    }
  }
  for (const url of urls) {
    assert.ok(!raw.includes(url.searchParams.get('signature')), 'the package bearer must not appear in OTA logs');
    for (const trace of url.searchParams.getAll('trace').filter(Boolean)) {
      assert.ok(!raw.includes(trace), 'the signed log metadata must not appear in OTA logs');
    }
  }
  assert.ok(!raw.includes(SECRET), 'the signing key must not appear in OTA logs');
}

test('update checks and downloads carry a stable anonymous robot reference', async () => {
  const server = await startService();
  const first = await logsDuring(() => checkAndDownload(server, ROBOTS.first));
  const firstAgain = await logsDuring(() => checkAndDownload(server, ROBOTS.first));
  const second = await logsDuring(() => checkAndDownload(server, ROBOTS.second));

  const a = refsIn(first.lines);
  const a2 = refsIn(firstAgain.lines);
  const b = refsIn(second.lines);

  assert.match(a.check, /^[0-9a-f]{12}$/, 'a short hex reference');
  assert.equal(a.download, a.check, "the download line names the same robot as the check that issued its URL");
  assert.deepEqual(a2, a, 'the same robot keeps the same reference on its next check and download');
  assert.equal(b.download, b.check);
  assert.notEqual(b.check, a.check, 'different robots get different references');

  // A restarted service (same deployment key) still names the robot the same way.
  const restarted = await startService();
  const afterRestart = await logsDuring(() => checkAndDownload(restarted, ROBOTS.first));
  assert.deepEqual(refsIn(afterRestart.lines), a);

  assertAnonymous([...first.lines, ...firstAgain.lines, ...second.lines, ...afterRestart.lines],
    [first.result, firstAgain.result, second.result, afterRestart.result]);
});

test('the reference is keyed: another deployment key yields unrelated references', async () => {
  const server = await startService();
  const here = refsIn((await logsDuring(() => checkAndDownload(server, ROBOTS.first))).lines);
  const elsewhere = await createOtaService({
    catalog,
    publicBaseUrl: `https://${HOST}`,
    packageBearerSecret: `${SECRET}-other-deployment`,
    resolveCredentials: () => null,
    internalPeerToken: PEER_TOKEN,
    now: () => NOW,
  }).listen(0, '127.0.0.1');
  servers.push(elsewhere);
  const there = refsIn((await logsDuring(() => checkAndDownload(elsewhere, ROBOTS.first))).lines);
  assert.notEqual(there.check, here.check, 'without the deployment key a name cannot be hashed to its reference');
});

test('same-millisecond checks for one package never assign one robot the other robot reference', async () => {
  const server = await startService();
  const { result: urls, lines } = await logsDuring(async () => {
    const first = await issuedUrl(server, ROBOTS.first);
    const second = await issuedUrl(server, ROBOTS.second);
    assert.equal(first.searchParams.get('expires'), second.searchParams.get('expires'), 'both offers use the same fixed millisecond');
    await download(server, first);
    await download(server, second);
    return [first, second];
  }, 2);
  const checks = lines.filter(l => l.msg === 'update query');
  const downloads = lines.filter(l => l.msg === 'ota package download');
  assert.equal(checks.length, 2);
  assert.equal(downloads.length, 2);
  assert.notEqual(checks[0].robotRef, checks[1].robotRef);
  assert.equal(downloads[0].robotRef, checks[0].robotRef, 'the first issued URL still belongs to the first robot');
  assert.equal(downloads[1].robotRef, checks[1].robotRef);
  assertAnonymous(lines, urls);
});

test('a URL issued before a service restart keeps its original robot reference', async () => {
  const original = await startService();
  const restarted = await startService();
  const { result: url, lines } = await logsDuring(async () => {
    const issued = await issuedUrl(original, ROBOTS.first);
    await download(restarted, issued);
    return issued;
  });
  const refs = refsIn(lines);
  assert.match(refs.check, /^[a-f0-9]{12}$/);
  assert.equal(refs.download, refs.check, 'a fresh service can trace an already-issued URL');
  assertAnonymous(lines, [url]);
});

const flipHex = value => `${value[0] === 'a' ? 'b' : 'a'}${value.slice(1)}`;

for (const [name, mutate] of [
  ['legacy URL without trace', url => url.searchParams.delete('trace')],
  ['tampered robot reference', url => {
    const [ref, mac] = url.searchParams.get('trace').split('.');
    url.searchParams.set('trace', `${flipHex(ref)}.${mac}`);
  }],
  ['tampered trace signature', url => {
    const [ref, mac] = url.searchParams.get('trace').split('.');
    url.searchParams.set('trace', `${ref}.${flipHex(mac)}`);
  }],
  ['malformed trace', url => url.searchParams.set('trace', 'not-a-trace')],
  ['empty trace', url => url.searchParams.set('trace', '')],
  ['duplicate trace', url => url.searchParams.append('trace', url.searchParams.get('trace'))],
]) {
  test(`${name} downloads full bytes with unknown log identity`, async () => {
    const server = await startService();
    const { result: url, lines } = await logsDuring(async () => {
      const issued = await issuedUrl(server, ROBOTS.first);
      assert.match(issued.searchParams.get('trace'), /^[a-f0-9]{12}\.[a-f0-9]{64}$/);
      mutate(issued);
      await download(server, issued);
      return issued;
    });
    assert.match(refsIn(lines).check, /^[a-f0-9]{12}$/);
    assertDownloadRef(lines, 'unknown');
    assertAnonymous(lines, [url]);
  });
}

test('trace copied from another bearer cannot assign its robot to the downloaded package', async () => {
  const server = await startService();
  const later = await startService(() => NOW + 1);
  const { result: urls, lines } = await logsDuring(async () => {
    const issued = await issuedUrl(server, ROBOTS.first);
    const other = await issuedUrl(later, ROBOTS.second);
    assert.notEqual(issued.searchParams.get('signature'), other.searchParams.get('signature'), 'different expiry means a different bearer');
    assert.match(other.searchParams.get('trace'), /^[a-f0-9]{12}\.[a-f0-9]{64}$/);
    issued.searchParams.set('trace', other.searchParams.get('trace'));
    await download(server, issued);
    return [issued, other];
  });
  const checks = lines.filter(line => line.msg === 'update query');
  assert.equal(checks.length, 2);
  assert.notEqual(checks[0].robotRef, checks[1].robotRef);
  assertDownloadRef(lines, 'unknown');
  assertAnonymous(lines, urls);
});

for (const [name, mutate] of [
  ['uppercase bearer signature', url => url.searchParams.set('signature', url.searchParams.get('signature').toUpperCase())],
  ['percent-encoded bearer and trace', url => {
    url.search = '?' + Array.from(url.searchParams, ([key, value]) =>
      `${key}=${Array.from(value, char => `%${char.charCodeAt(0).toString(16)}`).join('')}`).join('&');
  }],
]) {
  test(`${name} preserves full bytes and traced download identity`, async () => {
    const server = await startService();
    const { result: url, lines } = await logsDuring(async () => {
      const issued = await issuedUrl(server, ROBOTS.first);
      const trace = issued.searchParams.get('trace');
      assert.match(trace, /^[a-f0-9]{12}\.[a-f0-9]{64}$/);
      mutate(issued);
      assert.equal(issued.searchParams.get('trace'), trace, 'equivalent encodings retain the signed metadata');
      await download(server, issued);
      return issued;
    });
    const refs = refsIn(lines);
    assert.match(refs.check, /^[a-f0-9]{12}$/);
    assertDownloadRef(lines, refs.check);
    assertAnonymous(lines, [url]);
  });
}

for (const bearer of ['forged', 'expired']) {
  for (const trace of ['issued', 'missing', 'malformed']) {
    test(`${bearer} bearer stays forbidden with ${trace} trace`, async () => {
      const server = await startService();
      const { result: url, lines } = await logsDuring(async () => {
        const issued = await issuedUrl(server, ROBOTS.first);
        assert.match(issued.searchParams.get('trace'), /^[a-f0-9]{12}\.[a-f0-9]{64}$/);
        if (bearer === 'forged') issued.searchParams.set('signature', flipHex(issued.searchParams.get('signature')));
        if (trace === 'missing') issued.searchParams.delete('trace');
        if (trace === 'malformed') issued.searchParams.set('trace', 'not-a-trace');
        const target = bearer === 'expired'
          ? await startService(() => Number(issued.searchParams.get('expires'))) : server;
        const response = await request(target, { pathname: issued.pathname + issued.search });
        assert.equal(response.status, 403);
        assert.deepEqual(response.body, Buffer.from('forbidden'));
        assert.equal(response.headers['cache-control'], 'no-store');
        return issued;
      }, 0);
      const rejected = lines.filter(line => line.msg === 'ota package URL rejected');
      assert.equal(rejected.length, 1);
      assert.equal(rejected[0].id, 'os-13.1.0-fcs');
      assert.equal(rejected[0].reason, bearer === 'forged' ? 'signature-mismatch' : 'expired');
      if (bearer === 'expired') assert.equal(rejected[0].expiredForSeconds, 0);
      assert.equal(rejected[0].robotRef, undefined, 'refused bearers never acquire a download identity');
      assert.equal(lines.filter(line => line.msg === 'ota package download' || line.msg === 'ota package stream interrupted').length, 0);
      assertAnonymous(lines, [url]);
    });
  }
}

test('custom target filters and identifying query values never enter OTA query logs', async () => {
  const server = await startService();
  catalog.targets.set(ROBOTS.first.serial, `ring-${ROBOTS.first.serial}`);
  try {
    const { lines } = await logsDuring(async () => {
      for (const op of ['GetUpdateFrom', 'ListUpdatesFrom', 'ListUpdates']) {
        const response = await check(server, ROBOTS.first, op, {
          filter: ROBOTS.first.friendlyId, subsystem: ROBOTS.first.id, fromVersion: ROBOTS.first.email,
        });
        assert.equal(response.status, op === 'GetUpdateFrom' ? 404 : 200, 'matching behavior is unchanged');
      }
    }, 0);
    assert.equal(lines.filter(l => l.msg === 'update query').length, 3);
    assertAnonymous(lines, []);
    for (const line of lines.filter(l => l.msg === 'update query')) {
      assert.match(line.robotRef, /^[a-f0-9]{12}$/);
      assert.equal(line.filter, '[custom]');
      assert.equal(line.subsystem, '[custom]');
      assert.equal(line.fromVersion, '[redacted]');
    }
  } finally { catalog.targets.delete(ROBOTS.first.serial); }
});
