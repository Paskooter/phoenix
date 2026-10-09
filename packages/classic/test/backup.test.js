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
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClassicEntrypoint, BackupStore } from '../src/index.js';
import { Store, createAccountService } from '@phoenix/account';
import {
  SYNTHETIC_PEER_TOKEN, freePort, setEnv, signedAmz, startClassicChild, storeCallerBoundary,
  syntheticAccount, writeSyntheticAccountStore,
} from './fixtures/signedClassic.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Since 07178e2 the robot-facing Backup face is authenticated: the executable entrypoint verifies
// SigV4 against the Account store, Backup's ownership check compares the VERIFIED caller with the
// Account loop's robot (backup.js ownershipRefusal), and Classic reaches Account's private GET /loop
// with ETCO_account_internalPeerToken. The shared server below is configured the same way: a
// synthetic robot account signs every call, and a real Account service owns the synthetic loops.
const ROBOT = syntheticAccount('robot-backup-synthetic');
const ROBOT_LOOPS = ['loop-1', 'loop-order', 'loop-retry', 'never-backed-up', 'loop-share', 'loop-restart'];

let server; let port; let backupDir; let accountDir; let accountFile; let accountServer; let restoreEnv;
const base = () => `http://127.0.0.1:${port}`;

async function amz(target, body) {
  const { status, errType, body: parsed } = await signedAmz(base(), target, body, ROBOT);
  return { status, errType, body: parsed };
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
  accountDir = mkdtempSync(join(tmpdir(), 'phx-backup-accounts-'));
  accountFile = join(accountDir, 'account.json');
  const accounts = writeSyntheticAccountStore(accountFile, {
    accounts: [ROBOT],
    loops: ROBOT_LOOPS.map((loopId) => ({
      _id: loopId, robot: ROBOT._id, owner: 'synthetic-owner', isSuspended: false, members: [],
    })),
  });
  accountServer = await createAccountService({ store: accounts }).listen(0);
  restoreEnv = setEnv({
    ETCO_classic_backupDir: backupDir,
    NET_account: `127.0.0.1:${accountServer.address().port}`,
    ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN,
  });
  // The authenticated entrypoint requires an explicit public origin for its bearer URLs; reserve
  // an ephemeral port first so the origin names this very listener.
  port = await freePort();
  server = await createClassicEntrypoint({
    callerBoundary: storeCallerBoundary(accounts),
    publicUrl: base(),
  }).listen(port, '127.0.0.1');
});
after(async () => {
  server.close();
  await new Promise((resolve) => accountServer.close(resolve));
  restoreEnv();
  rmSync(backupDir, { recursive: true, force: true });
  rmSync(accountDir, { recursive: true, force: true });
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
    const unsigned = await fetch(`${first.base}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Backup_20170222.New' },
      body: JSON.stringify({ loopId: 'loop-restart' }),
    });
    assert.equal(unsigned.status, 401, 'the executable entrypoint refuses an unsigned Backup call');
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

// The historical LAN-trust path (no identity -> allowed) was removed on purpose by 07178e2:
// backup.js credentialsAccountId/ownershipRefusal — "a missing header is never treated as LAN
// trust" — answers BACKUP_AUTH_REQUIRED 401. The only identity-free path left is the explicit,
// socket-loopback-only `allowLoopbackWithoutIdentity` opt-in (ETCO_classic_backupTrustedLoopback).
test('ownership: no resolved identity is refused BACKUP_AUTH_REQUIRED (401) unless the loopback opt-in is set', async () => {
  const res = await withOwnership(
    { accountId: () => null, loopRobotId: async () => 'someone-else' },
    async (b) => b.amz('Backup_20170222.New', { loopId: 'loop-lan' }),
  );
  assert.equal(res.status, 401, 'an absent identity is never authorization');
  assert.equal(res.body.code, 'BACKUP_AUTH_REQUIRED');
  assert.equal(res.body.message, 'Backup credentials required');

  const optedIn = await withOwnership(
    { accountId: () => null, loopRobotId: async () => 'someone-else', allowLoopbackWithoutIdentity: true },
    async (b) => b.amz('Backup_20170222.New', { loopId: 'loop-lan' }),
  );
  assert.equal(optedIn.status, 200, 'the explicit same-host opt-in accepts a loopback peer');
});

// 07178e2 made an unresolved Account lookup fail closed: backup.js accountLoopRobot documents
// that `undefined` (Account could not resolve the loop) is denied with a service-unavailable
// response "rather than authorizing through an outage".
test('ownership: an unresolved loop lookup fails closed (503 ACCOUNT_SERVICE_UNAVAILABLE)', async () => {
  const res = await withOwnership(
    { accountId: () => 'robot-1', loopRobotId: async () => undefined },
    async (b) => b.amz('Backup_20170222.New', { loopId: 'loop-unresolved' }),
  );
  assert.equal(res.status, 503, 'an Account outage is not authorization');
  assert.equal(res.body.code, 'ACCOUNT_SERVICE_UNAVAILABLE');
  assert.equal(res.body.message, 'Account service unavailable');
});

test('ownership: end-to-end through a real Account service (getLoop 200 and 404)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-backup-acct-'));
  const prev = process.env.NET_account;
  let accountServer; let classic; let restorePeerToken;
  try {
    // Account's GET /loop is a private peer route since 07178e2 (account/src/backupPeerRoutes.js):
    // it needs ETCO_account_internalPeerToken and the matching header backup.js sends.
    restorePeerToken = setEnv({ ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN });
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
    restorePeerToken?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('restore authorization is possession of the returned bearer URL (no request credentials)', async () => {
  const created = await amz('Backup_20170222.New', { loopId: 'loop-share' });
  await fetch(created.body.uploadUrl, { method: 'PUT', body: Buffer.from('shareable') });
  const listed = await amz('Backup_20170222.List', { loopId: 'loop-share' });
  const url = listed.body[0].location.url;
  // The source served an S3 presigned GET (the signature WAS the authorization). Since 07178e2
  // Phoenix's self-hosted URL carries the same kind of bearer: a server-held HMAC bound to method,
  // loop, key and expiry (backup.js signedBlobUrl/bearerIds). Holding the URL is enough...
  const res = await fetch(url); // no request credentials of any kind
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shareable');
  // ...but the URL without its signature (the old unsigned shape) is refused.
  const unsigned = new URL(url);
  unsigned.searchParams.delete('signature');
  const refused = await fetch(unsigned);
  assert.equal(refused.status, 403);
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

/** Start the real executable classic entrypoint as a child PROCESS with a fixed backup dir. */
async function startChild({ port, backupDir: dir }) {
  return startClassicChild({
    port,
    accountDataFile: accountFile,
    env: {
      ETCO_classic_backupDir: dir,
      NET_account: process.env.NET_account,
      ETCO_account_internalPeerToken: SYNTHETIC_PEER_TOKEN,
    },
    ready: async (baseUrl) => (await childAmz(baseUrl, 'Backup_20170222.List', { loopId: 'loop-restart' })).status === 200,
  });
}

async function childAmz(baseUrl, target, body) {
  const { status, body: parsed } = await signedAmz(baseUrl, target, body, ROBOT);
  return { status, body: parsed };
}

// Re-ported from the September week-review hardening (synthetic data).
test('ownership: missing identity fails closed unless the explicit loopback boundary is enabled', async () => {
  const denied = await withOwnership(
    undefined,
    async (b) => ({
      n: await b.amz('Backup_20170222.New', { loopId: 'loop-no-identity' }),
      l: await b.amz('Backup_20170222.List', { loopId: 'loop-no-identity' }),
    }),
  );
  for (const [name, res] of Object.entries(denied)) {
    assert.equal(res.status, 401, `${name}: a missing forwarding identity is not an authorization signal`);
    assert.equal(res.body.code, 'BACKUP_AUTH_REQUIRED');
  }

  const trusted = await withOwnership(
    { accountId: () => null, loopRobotId: async () => 'someone-else', allowLoopbackWithoutIdentity: true },
    async (b) => ({
      n: await b.amz('Backup_20170222.New', { loopId: 'loop-loopback' }),
      l: await b.amz('Backup_20170222.List', { loopId: 'loop-loopback' }),
    }),
  );
  assert.equal(trusted.n.status, 200, 'only the explicitly configured loopback seam may omit identity');
  assert.equal(trusted.l.status, 200, 'the same explicit loopback seam applies to List');
});

test('ownership: an Account lookup outage fails closed with ACCOUNT_SERVICE_UNAVAILABLE', async () => {
  const denied = await withOwnership(
    { accountId: () => 'robot-1', loopRobotId: async () => undefined },
    async (b) => ({
      n: await b.amz('Backup_20170222.New', { loopId: 'loop-unresolved' }),
      l: await b.amz('Backup_20170222.List', { loopId: 'loop-unresolved' }),
    }),
  );
  for (const [name, res] of Object.entries(denied)) {
    assert.equal(res.status, 503, `${name}: an unavailable Account lookup cannot authorize ownership`);
    assert.equal(res.body.statusCode, 503);
    assert.equal(res.body.error, 'Service Unavailable');
    assert.equal(res.body.code, 'ACCOUNT_SERVICE_UNAVAILABLE');
  }
});

test('restore authorization is possession of the returned URL (expiring, loop-bound bearer)', async () => {
  const created = await amz('Backup_20170222.New', { loopId: 'loop-share' });
  await fetch(created.body.uploadUrl, { method: 'PUT', body: Buffer.from('shareable') });
  const listed = await amz('Backup_20170222.List', { loopId: 'loop-share' });
  const url = listed.body[0].location.url;
  // The source served an S3 presigned GET. The self-hosted URL keeps that possession model, but
  // now carries a server-held HMAC and an enforced expiry; no robot credentials are needed.
  const res = await fetch(url); // no credentials of any kind
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'shareable');
});

test('backup blob bearer rejects forgery, wrong loop, expiry changes, and method replay on GET and PUT', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-backup-bearer-'));
  const secret = 'only-used-to-prove-it-is-not-in-the-url';
  let now = Date.now();
  let svc;
  try {
    const listenPort = await freePort();
    svc = await createClassicEntrypoint({
      publicUrl: `http://localhost:${listenPort}`,
      backup: { dir, bearerSecret: secret, clock: () => now, urlExpirationMs: 1000 },
      backupOwnership: { allowLoopbackWithoutIdentity: true },
    }).listen(listenPort);
    const p = svc.address().port;
    const post = async (target, body) => {
      const response = await fetch(`http://localhost:${p}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const created = await post('Backup_20170222.New', { loopId: 'loop-bearer' });
    assert.equal(created.status, 200);
    const putUrl = new URL(created.body.uploadUrl);
    assert.equal(putUrl.searchParams.get('loopId'), 'loop-bearer');
    assert.equal(putUrl.searchParams.get('key')?.length > 0, true);
    assert.match(putUrl.searchParams.get('signature') || '', /^[a-f0-9]{64}$/);
    assert.equal(putUrl.href.includes(secret), false, 'the bearer secret is never serialized into the URL');

    const unsigned = new URL(putUrl);
    unsigned.searchParams.delete('expires');
    unsigned.searchParams.delete('signature');
    assert.equal((await fetch(unsigned, { method: 'PUT', body: 'unsigned' })).status, 403);

    const forged = new URL(putUrl);
    forged.searchParams.set('signature', `${'0'.repeat(63)}0`);
    assert.equal((await fetch(forged, { method: 'PUT', body: 'forged' })).status, 403);

    const futureOnly = new URL(putUrl);
    futureOnly.searchParams.set('expires', String(now + 60_000));
    assert.equal((await fetch(futureOnly, { method: 'PUT', body: 'expiry-tampered' })).status, 403);

    const wrongLoop = new URL(putUrl);
    wrongLoop.searchParams.set('loopId', 'another-loop');
    assert.equal((await fetch(wrongLoop, { method: 'PUT', body: 'wrong-loop' })).status, 403);

    const put = await fetch(putUrl, { method: 'PUT', body: Buffer.from('bearer-bytes') });
    assert.equal(put.status, 200);
    assert.equal((await fetch(putUrl)).status, 403, 'a PUT bearer cannot be replayed as a GET bearer');

    const listed = await post('Backup_20170222.List', { loopId: 'loop-bearer' });
    assert.equal(listed.status, 200);
    const getUrl = new URL(listed.body[0].location.url);
    assert.equal(listed.body[0].location.expires, Number(getUrl.searchParams.get('expires')));
    assert.match(getUrl.searchParams.get('signature') || '', /^[a-f0-9]{64}$/);
    assert.equal((await fetch(getUrl, { method: 'PUT', body: 'method-replay' })).status, 403);

    const unsignedGet = new URL(getUrl);
    unsignedGet.searchParams.delete('expires');
    unsignedGet.searchParams.delete('signature');
    assert.equal((await fetch(unsignedGet)).status, 403, 'GET requires its bearer, not just loopId/key');

    const futureGet = new URL(getUrl);
    futureGet.searchParams.set('expires', String(now + 60_000));
    assert.equal((await fetch(futureGet)).status, 403, 'GET rejects an advertised expiry that is not signed');

    now += 1001;
    assert.equal((await fetch(getUrl)).status, 403, 'GET enforces expiry instead of trusting location.expires');

    const later = await post('Backup_20170222.New', { loopId: 'loop-bearer-put-expiry' });
    assert.equal(later.status, 200);
    const laterUrl = later.body.uploadUrl;
    now += 1001;
    assert.equal((await fetch(laterUrl, { method: 'PUT', body: 'expired-put' })).status, 403, 'PUT enforces expiry too');
  } finally {
    svc?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
