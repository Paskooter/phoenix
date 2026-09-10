// Backup_20170222 — the "Backing up robot…" step of the wipe/factory-reset flow. Exercises the
// exact sequence PlatformTeam/system-manager scripts/jibo-system-{backup,restore}.js drive:
//   Backup.New -> uploadUrl ; PUT the blob -> ETag ; Backup.List -> etag must match ; GET -> blob.
//
// Grounded in jiborobot/srv-backup-ws@1153de1 (handler.js / ctrl.js / errors/backup.js /
// clients/account.client.js) and the pinned response model
// jiborobot/srv-jibo-server-client/apis/backup-2017-02-22.normal.json. A-09 additions:
// durability across a REAL process restart, and the source ownership rule
// (loop.robot === caller, else 403 ROBOT_SHOULD_BELONG_TO_LOOP).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createClassicEntrypoint, BackupStore } from '../src/index.js';
import { Store, createAccountService } from '@phoenix/account';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'classic', 'src', 'index.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let server; let port; let backupDir; let prevBackupDir;
const base = () => `http://localhost:${port}`;

async function amz(target, body, { headers } = {}) {
  const res = await fetch(`${base()}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...(headers || {}) },
    body: JSON.stringify(body || {}),
  });
  return {
    status: res.status,
    errType: res.headers.get('x-amzn-errortype'),
    body: await res.json().catch(() => null),
  };
}

/** The pinned client's error precedence: lib/protocol/json.js:62-71 (__type || code || error). */
function clientErrorCode(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.__type || parsed.code || parsed.error || null;
}

// The backup store's index is rebuilt from the on-disk objects, so the shared entrypoint MUST
// use a per-run directory: the process default ($TMPDIR/phx-backups) accumulates objects across
// runs and would make `List` counts non-deterministic (a real durability property, not a bug).
before(async () => {
  backupDir = mkdtempSync(join(tmpdir(), 'phx-backup-shared-'));
  prevBackupDir = process.env.ETCO_classic_backupDir;
  process.env.ETCO_classic_backupDir = backupDir;
  server = await createClassicEntrypoint().listen(0);
  port = server.address().port;
});
after(() => {
  server.close();
  rmSync(backupDir, { recursive: true, force: true });
  if (prevBackupDir === undefined) delete process.env.ETCO_classic_backupDir;
  else process.env.ETCO_classic_backupDir = prevBackupDir;
});

// ---- the authoritative client sequence + content integrity ------------------

test('backup new -> PUT blob -> list (etag matches) -> GET restores the bytes', async () => {
  const blob = Buffer.from('jibo-backup-tarball-contents-\x00\x01\x02', 'binary');

  // 1) Backup.New -> a usable uploadUrl pointing back at this server (not the dead empty stub).
  const created = await amz('Backup_20170222.New', { loopId: 'loop-1' });
  assert.equal(created.status, 200);
  assert.ok(created.body.uploadUrl && created.body.uploadUrl.startsWith(base()), 'uploadUrl points here');

  // 2) the robot PUTs the (encrypted) blob; jibo-system-backup.js reads response.headers.etag.
  const put = await fetch(created.body.uploadUrl, {
    method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: blob,
  });
  assert.equal(put.status, 200);
  const etag = put.headers.get('etag');
  assert.ok(etag && /^\".*\"$/.test(etag), 'PUT returns a quoted S3-style ETag');
  // S3 ETag is the quoted md5 of the object; jibo-system-backup.js only compares it to List.
  const md5 = createHash('md5').update(blob).digest('hex');
  assert.equal(etag, `"${md5}"`, 'the ETag is the quoted md5 of the uploaded bytes');

  // 3) Backup.List (default max=1) -> exactly the one entry, whose etag the robot asserts == PUT's.
  const listed = await amz('Backup_20170222.List', { loopId: 'loop-1' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1, 'default max=1 returns the single latest');
  const entry = listed.body[0];
  assert.equal(entry.etag, etag, 'list etag matches the upload ETag — backup() succeeds');
  assert.equal(entry.size, blob.length);
  assert.equal(typeof entry.size, 'number', 'source emitted the S3 Size number even though the model types it string');
  assert.ok(!Number.isNaN(Date.parse(entry.modified)), 'modified is an ISO-8601 timestamp');
  assert.ok(entry.location && entry.location.url, 'a download location for restore');
  assert.equal(typeof entry.location.expires, 'number', 'source emitted epoch-ms expires');

  // 4) restore: plain GET of location.url returns the stored bytes verbatim.
  const got = await fetch(entry.location.url);
  assert.equal(got.status, 200);
  const back = Buffer.from(await got.arrayBuffer());
  assert.deepEqual(back, blob, 'restored bytes are byte-identical');
});

test('List is newest-first: default max=1 is the latest, max=2 is [latest, prior]', async () => {
  const loopId = 'loop-order';
  const first = await amz('Backup_20170222.New', { loopId });
  const put1 = await fetch(first.body.uploadUrl, { method: 'PUT', body: Buffer.from('older') });
  await sleep(5);
  const second = await amz('Backup_20170222.New', { loopId });
  const put2 = await fetch(second.body.uploadUrl, { method: 'PUT', body: Buffer.from('newer!') });

  const latest = await amz('Backup_20170222.List', { loopId });
  assert.equal(latest.body.length, 1);
  assert.equal(latest.body[0].etag, put2.headers.get('etag'), 'default max=1 is the newest object');

  const both = await amz('Backup_20170222.List', { loopId, max: 2 });
  assert.equal(both.body.length, 2);
  assert.deepEqual(
    both.body.map((e) => e.etag),
    [put2.headers.get('etag'), put1.headers.get('etag')],
    'newest first',
  );
});

test('retrying the same upload URL is last-write-wins and leaves one entry', async () => {
  const loopId = 'loop-retry';
  const created = await amz('Backup_20170222.New', { loopId });
  const url = created.body.uploadUrl;
  await fetch(url, { method: 'PUT', body: Buffer.from('first-attempt') });
  const retry = await fetch(url, { method: 'PUT', body: Buffer.from('second-attempt-wins') });
  const listed = await amz('Backup_20170222.List', { loopId, max: 10 });
  assert.equal(listed.body.length, 1, 'the same object key is replaced, not appended');
  assert.equal(listed.body[0].etag, retry.headers.get('etag'));
  assert.equal(listed.body[0].size, 'second-attempt-wins'.length);
  const got = await fetch(listed.body[0].location.url);
  assert.equal(await got.text(), 'second-attempt-wins');
});

// ---- source error envelopes -------------------------------------------------

test('missing loopId is the source Boom.badData 422 and an unknown op is the source 404', async () => {
  const bad = await amz('Backup_20170222.New', {});
  assert.equal(bad.status, 422, 'Joi.string().required() -> Boom.badData');
  assert.equal(bad.errType, null, 'the source Hapi reply carried no x-amzn-errortype header');
  assert.equal(bad.body.statusCode, 422);
  assert.equal(bad.body.error, 'Unprocessable Entity');
  assert.equal(bad.body.message, 'child "loopId" fails because ["loopId" is required]');
  assert.equal(clientErrorCode(bad.body), 'Unprocessable Entity', 'pinned client falls back to body.error');

  const nonString = await amz('Backup_20170222.List', { loopId: 7 });
  assert.equal(nonString.status, 422);
  assert.equal(nonString.body.message, 'child "loopId" fails because ["loopId" must be a string]');

  const unknown = await amz('Backup_20170222.Bogus', { loopId: 'l' });
  assert.equal(unknown.status, 404, 'source: Boom.notFound("Method <op> not found.")');
  assert.equal(unknown.body.message, 'Method bogus not found.', 'first char lowercased, like lowerMethodName');
  assert.equal(clientErrorCode(unknown.body), 'Not Found');
});

test('list of an unknown loop is an empty list (200), not an error', async () => {
  const empty = await amz('Backup_20170222.List', { loopId: 'never-backed-up' });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);
});

// ---- durability -------------------------------------------------------------

test('durable: a fresh in-process store re-indexes a loop directory from disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-backup-unit-'));
  try {
    const store = new BackupStore(dir);
    await store.put('loop-d', 'key-1', Readable.from(Buffer.from('on-disk-blob')));
    const restarted = new BackupStore(dir);
    assert.equal(restarted.index.size, 0, 'a restarted process starts with an empty in-memory index');
    const entries = restarted.list('loop-d', 5);
    assert.equal(entries.length, 1, 'the object file is re-indexed from disk');
    assert.equal(entries[0].size, 'on-disk-blob'.length);
    const md5 = createHash('md5').update(Buffer.from('on-disk-blob')).digest('hex');
    assert.equal(entries[0].etag, `"${md5}"`, 'the rebuilt ETag is the object content md5');
    assert.ok(restarted.find('loop-d', 'key-1'), 'find() re-indexes too');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('durable: Backup.New -> PUT -> List -> GET survive a real service restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-backup-restart-'));
  const blob = Buffer.from('survives-a-real-restart-\x00\x01\xff', 'binary');
  let first; let second;
  try {
    const p1 = await freePort();
    first = await startChild({ port: p1, backupDir: dir });
    const created = await childAmz(first.base, 'Backup_20170222.New', { loopId: 'loop-restart' });
    assert.equal(created.status, 200);
    const put = await fetch(created.body.uploadUrl, { method: 'PUT', body: blob });
    assert.equal(put.status, 200);
    const etag = put.headers.get('etag');

    // SIGKILL: no graceful shutdown, nothing flushed on the way out.
    await first.stop();

    const p2 = await freePort();
    second = await startChild({ port: p2, backupDir: dir });
    assert.notEqual(p1, p2, 'a genuinely new process on a new port');

    const listed = await childAmz(second.base, 'Backup_20170222.List', { loopId: 'loop-restart' });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 1, 'the restarted service lists the backup written before the kill');
    assert.equal(listed.body[0].etag, etag, 'the re-indexed ETag is byte-identical to the pre-restart ETag');
    assert.equal(listed.body[0].size, blob.length);

    const got = await fetch(listed.body[0].location.url);
    assert.equal(got.status, 200, 'the restarted service serves the blob the previous process wrote');
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), blob, 'restored bytes are byte-identical across the restart');
  } finally {
    await first?.stop();
    await second?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- ownership / restore semantics -----------------------------------------

test('ownership: the loop\'s own robot may New and List', async () => {
  const own = await withOwnership(
    { accountId: () => 'robot-1', loopRobotId: async () => 'robot-1' },
    async (b) => {
      const n = await b.amz('Backup_20170222.New', { loopId: 'loop-owned' });
      const l = await b.amz('Backup_20170222.List', { loopId: 'loop-owned' });
      return { n, l };
    },
  );
  assert.equal(own.n.status, 200, 'the owning robot is allowed to create a backup');
  assert.equal(own.l.status, 200, 'and to list it');
});

test('ownership: a different account is refused ROBOT_SHOULD_BELONG_TO_LOOP (403) on New and List', async () => {
  const denied = await withOwnership(
    { accountId: () => 'robot-1', loopRobotId: async () => 'robot-2' },
    async (b) => ({
      n: await b.amz('Backup_20170222.New', { loopId: 'loop-other' }),
      l: await b.amz('Backup_20170222.List', { loopId: 'loop-other' }),
    }),
  );
  for (const [name, res] of Object.entries(denied)) {
    assert.equal(res.status, 403, `${name}: source Boom.createWithCode(ROBOT_SHOULD_BELONG_TO_LOOP)`);
    assert.equal(res.body.statusCode, 403);
    assert.equal(res.body.error, 'Forbidden');
    assert.equal(res.body.message, 'Robot should belong to the loop');
    assert.equal(res.body.code, 'ROBOT_SHOULD_BELONG_TO_LOOP');
    assert.equal(clientErrorCode(res.body), 'ROBOT_SHOULD_BELONG_TO_LOOP', 'the pinned client sees the explicit code');
  }
});

test('ownership: no resolved identity keeps the documented LAN-trust path (200)', async () => {
  const res = await withOwnership(
    { accountId: () => null, loopRobotId: async () => 'someone-else' },
    async (b) => b.amz('Backup_20170222.New', { loopId: 'loop-lan' }),
  );
  assert.equal(res.status, 200, 'with no gateway-supplied identity there is nothing to check against');
});

test('ownership: an unresolved loop lookup does not fail a legitimate backup', async () => {
  const res = await withOwnership(
    { accountId: () => 'robot-1', loopRobotId: async () => undefined },
    async (b) => b.amz('Backup_20170222.New', { loopId: 'loop-unresolved' }),
  );
  assert.equal(res.status, 200, 'account service unreachable is not the robot\'s fault');
});

test('ownership: end-to-end through a real Account service (getLoop 200 and 404)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-backup-acct-'));
  const prev = process.env.NET_account;
  let accountServer; let classic;
  try {
    const store = new Store(join(dir, 'account.json'));
    store.accounts.set('robot-1', { _id: 'robot-1', friendlyId: 'r-one', isActive: true, isDeleted: false });
    store.accounts.set('robot-2', { _id: 'robot-2', friendlyId: 'r-two', isActive: true, isDeleted: false });
    store.loops.set('loop-1', { _id: 'loop-1', robot: 'robot-1', owner: 'owner-1', isSuspended: false, members: [] });
    const accountService = createAccountService({ store });
    accountServer = await accountService.listen(0);
    process.env.NET_account = `127.0.0.1:${accountServer.address().port}`;

    classic = await createClassicEntrypoint().listen(0);
    const cb = `http://localhost:${classic.address().port}`;
    const post = async (creds, body) => {
      const res = await fetch(`${cb}/`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-amz-json-1.1',
          'x-amz-target': 'Backup_20170222.New',
          'x-amz-credentials': JSON.stringify(creds),
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const owner = await post({ id: 'robot-1' }, { loopId: 'loop-1' });
    assert.equal(owner.status, 200, 'the loop\'s robot passes the source check against the real Account loop');

    const other = await post({ id: 'robot-2' }, { loopId: 'loop-1' });
    assert.equal(other.status, 403);
    assert.equal(other.body.code, 'ROBOT_SHOULD_BELONG_TO_LOOP');

    const missing = await post({ id: 'robot-1' }, { loopId: 'loop-nope' });
    assert.equal(missing.status, 403, 'a loop the account service does not know cannot be backed up');
  } finally {
    classic?.close();
    if (accountServer) await new Promise((r) => accountServer.close(r));
    if (prev === undefined) delete process.env.NET_account; else process.env.NET_account = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore authorization is possession of the returned URL (unsigned, self-hosted)', async () => {
  const created = await amz('Backup_20170222.New', { loopId: 'loop-share' });
  await fetch(created.body.uploadUrl, { method: 'PUT', body: Buffer.from('shareable') });
  const listed = await amz('Backup_20170222.List', { loopId: 'loop-share' });
  const url = listed.body[0].location.url;
  // The source served an S3 presigned GET (the signature WAS the authorization). Phoenix's
  // self-hosted URL is unsigned, so any holder of it can restore — the H-backup divergence.
  const res = await fetch(url); // no credentials of any kind
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shareable');
});

test('backup blob endpoints reject path-traversal in loopId/key', async () => {
  const res = await fetch(`${base()}/backup/blob?loopId=..%2f..%2fetc&key=passwd`, { method: 'PUT', body: 'x' });
  assert.equal(res.status, 400);
});

// ---- helpers ----------------------------------------------------------------

async function withOwnership(ownership, fn) {
  const svc = await createClassicEntrypoint({ backupOwnership: ownership }).listen(0);
  const p = svc.address().port;
  try {
    return await fn({
      port: p,
      amz: async (target, body) => {
        const res = await fetch(`http://localhost:${p}/`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
          body: JSON.stringify(body || {}),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
    });
  } finally {
    svc.close();
  }
}

async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  const p = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return p;
}

/** Start the real classic entrypoint as a child PROCESS bound to `port` with a fixed backup dir. */
async function startChild({ port, backupDir }) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ETCO_classic_backupDir: backupDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (c) => { stderr += c; });
  const baseUrl = `http://localhost:${port}`;
  const ready = async () => {
    try {
      const res = await fetch(`${baseUrl}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Backup_20170222.List' },
        body: JSON.stringify({ loopId: 'readiness-probe' }),
      });
      return res.status === 200;
    } catch { return false; }
  };
  for (let i = 0; i < 150; i++) {
    if (await ready()) {
      return {
        base: baseUrl,
        child,
        stop: () => new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('close', resolve);
          child.kill('SIGKILL');
        }),
      };
    }
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error(`classic entrypoint child did not start: ${stderr}`);
}

async function childAmz(baseUrl, target, body) {
  const res = await fetch(`${baseUrl}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
