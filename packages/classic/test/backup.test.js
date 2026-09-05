// Backup_20170222 — the "Backing up robot…" step of the wipe/factory-reset flow. Exercises the
// exact sequence PlatformTeam/system-manager scripts/jibo-system-{backup,restore}.js drive:
//   Backup.New -> uploadUrl ; PUT the blob -> ETag ; Backup.List -> etag must match ; GET -> blob.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';

let server; let port;
const base = () => `http://localhost:${port}`;

async function amz(target, body) {
  const res = await fetch(`${base()}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => { server = await createClassicEntrypoint().listen(0); port = server.address().port; });
after(() => server.close());

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
  assert.ok(etag && /^".*"$/.test(etag), 'PUT returns a quoted S3-style ETag');

  // 3) Backup.List (default max=1) -> exactly the one entry, whose etag the robot asserts == PUT's.
  const listed = await amz('Backup_20170222.List', { loopId: 'loop-1' });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1, 'default max=1 returns the single latest');
  const entry = listed.body[0];
  assert.equal(entry.etag, etag, 'list etag matches the upload ETag — backup() succeeds');
  assert.equal(entry.size, blob.length);
  assert.ok(entry.location && entry.location.url, 'a download location for restore');

  // 4) restore: plain GET of location.url returns the stored bytes verbatim.
  const got = await fetch(entry.location.url);
  assert.equal(got.status, 200);
  const back = Buffer.from(await got.arrayBuffer());
  assert.deepEqual(back, blob, 'restored bytes are byte-identical');
});

test('backup new requires a loopId; list of an unknown loop is empty (not an error)', async () => {
  const bad = await amz('Backup_20170222.New', {});
  assert.equal(bad.status, 400);
  assert.equal(bad.errType, 'ValidationException');

  const empty = await amz('Backup_20170222.List', { loopId: 'never-backed-up' });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, []);
});

test('backup blob endpoints reject path-traversal in loopId/key', async () => {
  const res = await fetch(`${base()}/backup/blob?loopId=..%2f..%2fetc&key=passwd`, { method: 'PUT', body: 'x' });
  assert.equal(res.status, 400);
});
