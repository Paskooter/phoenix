// Media_20160725 — the cloud photo store behind the mobile app's Gallery tab.
//
// Every expectation here is pinned to the archive, not invented:
//   apis/media-2016-07-25.normal.json (jiborobot/srv-jibo-server-client)
//   jiborobot/srv-media-ws src/{handlers/media.handler.js,controllers/media.ctrl.js,
//                                schemes/media.js,errors/media.js}
//   the Android client JiboMediaClient / Media / MediaHelper in jibo-aws-library-release.aar
//
// The regression this file exists to prevent: the Gallery tab's List call used to be answered by
// a stub that returned `[]` unconditionally, and its Create used to return a record with `url: ''`
// without storing a byte. A photo could be uploaded and never read back.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';
import { MediaStore } from '../src/media.js';

let server; let port; let dir; let store;
const LOOP = '5a0b20f5ddee0000197e2881';
const OTHER_LOOP = '59e66fc3762588001e64c296';
const PAGE_LOOP = '5a0b20f5ddee0000197e2889';
const CAP_LOOP = '5a0b20f5ddee0000197e288a';
const ACCOUNT = '43ca532ad4090cfb80f2e7a5';
const OUTSIDER = 'deadbeefdeadbeefdeadbeef';

// Membership is injected the way the deployed launcher injects it (colocated account store).
// Not passing `loops` at all would exercise the documented LAN-trust skip instead.
const loops = {
  members: (loopId) => ([LOOP, OTHER_LOOP, PAGE_LOOP, CAP_LOOP].includes(loopId) ? [ACCOUNT] : []),
  accountLoops: (accountId) => (accountId === ACCOUNT ? [LOOP, OTHER_LOOP, PAGE_LOOP, CAP_LOOP] : []),
  ownedLoops: () => [],
};

function jsonAmz(target, body, accessKeyId = ACCOUNT) {
  return fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260910/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
}

async function list(body, accessKeyId = ACCOUNT) {
  const res = await jsonAmz('Media_20160725.List', body, accessKeyId);
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json() };
}

async function upload(path, bytes, { type = 'image', reference, accessKeyId = ACCOUNT, loopId = LOOP, encrypted = false } = {}) {
  const headers = {
    'content-type': 'application/octet-stream',
    'x-amz-target': 'Media_20160725.Create',
    'x-loop-id': loopId,
    'x-path': path,
    'x-type': type,
    'x-encrypted': encrypted ? 'true' : 'false',
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260910/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
  };
  if (reference) headers['x-reference'] = reference;
  const res = await fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: bytes });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json() };
}

/** Insert a record with a controlled `created` so ordering assertions are deterministic. */
function seed(path, created, extra = {}) {
  store.records.set(path, {
    path, type: 'image', accountId: ACCOUNT, loopId: PAGE_LOOP, url: `u/${path}`, created,
    meta: {}, isEncrypted: false, isDeleted: false, thumbs: [], ...extra,
  });
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phoenix-media-test-'));
  store = new MediaStore({ directory: join(dir, 'objects'), file: join(dir, 'media.json') });
  // No accountResolver: the default derives the caller from the SigV4 accessKeyId, exactly as the
  // other Classic services do, so `Credential=<ACCOUNT>/...` is the account seen by membership.
  server = await createClassicEntrypoint({ media: { store, loops } }).listen(0);
  port = server.address().port;
});
after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });

// -- the app's Gallery path ---------------------------------------------------

test('List answers an empty MediaList (not an error) for a loop with no media', async () => {
  const r = await list({ loopIds: [LOOP] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('a robot photo + its thumbnail come back as the rows the Gallery grid selects', async () => {
  const image = await upload('photo-1', Buffer.from('JPEGDATA-one'));
  assert.equal(image.status, 200);
  assert.equal(image.body.path, 'photo-1');
  assert.equal(image.body.type, 'image');
  assert.equal(image.body.accountId, ACCOUNT);
  assert.equal(image.body.loopId, LOOP);
  assert.equal(typeof image.body.created, 'number');
  assert.match(image.body.url, /^http:\/\/localhost:\d+\/media\/blob\/photo-1$/);

  const thumb = await upload('thumb-1', Buffer.from('THUMBDATA-one'), { type: 'thumb', reference: 'photo-1' });
  assert.equal(thumb.status, 200);
  assert.equal(thumb.body.path, 'thumb-1');
  assert.equal(thumb.body.type, 'thumb');
  assert.equal(thumb.body.reference, 'photo-1');
  // The source answers the referenced document's JSON, not the new thumb document.
  assert.equal(thumb.body.accountId, ACCOUNT);

  const { status, body } = await list({ loopIds: [LOOP] });
  assert.equal(status, 200);
  assert.equal(body.length, 2);
  // The source reverses the EXPANDED list (`expand()` then `.reverse()`), so a parent and its
  // thumbs come back in reverse — the thumb row first. That is the real wire order; the grid
  // re-sorts from its own SQLite cursor, so only the row content matters to the app.
  const thumbRow = body[0];
  const parentRow = body[1];
  assert.equal(thumbRow.path, 'thumb-1');
  assert.equal(thumbRow.type, 'thumb');
  assert.equal(thumbRow.reference, 'photo-1');
  assert.equal(thumbRow.url, `http://localhost:${port}/media/blob/thumb-1`);
  assert.equal(thumbRow.loopId, LOOP);
  // This conjunction is MediaFragment's MediaCursor WHERE clause for the grid.
  assert.ok(thumbRow.type === 'thumb' && thumbRow.url && thumbRow.reference);
  assert.equal(parentRow.path, 'photo-1');
  assert.equal(parentRow.url, `http://localhost:${port}/media/blob/photo-1`);
});

test('the answered url actually serves the uploaded bytes', async () => {
  const { body } = await list({ loopIds: [LOOP] });
  const image = body.find((row) => row.path === 'photo-1');
  const res = await fetch(image.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'JPEGDATA-one');
  const thumb = body.find((row) => row.path === 'thumb-1');
  const thumbRes = await fetch(thumb.url);
  assert.equal(thumbRes.status, 200);
  assert.equal(await thumbRes.text(), 'THUMBDATA-one');
});

test('an unknown path on the blob route is a 404, not a 500', async () => {
  const res = await fetch(`http://localhost:${port}/media/blob/no-such-object`);
  assert.equal(res.status, 404);
});

test('a Media url with a ?loopId= query (MediaHelper appends it for encrypted media) still serves', async () => {
  const enc = await upload('photo-enc', Buffer.from('ENCBYTES'), { encrypted: true });
  assert.equal(enc.body.isEncrypted, true);
  const res = await fetch(`${enc.body.url}?loopId=${LOOP}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ENCBYTES');
});

test('List orders ascending and an `after` marker returns only newer rows', async () => {
  seed('page-1', 1_000);
  seed('page-2', 2_000);
  seed('page-3', 3_000);
  const all = await list({ loopIds: [PAGE_LOOP] });
  assert.deepEqual(all.body.map((row) => row.created), [1_000, 2_000, 3_000]);
  const page = await list({ loopIds: [PAGE_LOOP], after: 1_000 });
  assert.deepEqual(page.body.map((row) => row.created), [2_000, 3_000]);
  // ...and the marker-less page is still ascending (the source sorts desc then reverses).
  const before = await list({ loopIds: [PAGE_LOOP], before: 3_000 });
  assert.deepEqual(before.body.map((row) => row.created), [1_000, 2_000]);
});

test('List pages 50 rows by default and never past the source hard cap of 200', async () => {
  for (let i = 0; i < 60; i++) seed(`cap-${i}`, 10_000 + i, { loopId: CAP_LOOP });
  const dflt = await list({ loopIds: [CAP_LOOP] });
  assert.equal(dflt.body.length, 50);
  // The source sorts DESC, limits, then reverses: the page is the NEWEST 50, answered ascending.
  assert.equal(dflt.body[0].created, 10_010);
  assert.equal(dflt.body[49].created, 10_059);
  const capped = await list({ loopIds: [CAP_LOOP], limit: 999 });
  assert.equal(capped.body.length, 60);
});

test('Get returns rows by path and refuses to answer soft-deleted ones', async () => {
  const got = await jsonAmz('Media_20160725.Get', { paths: ['photo-1', 'thumb-1'] });
  assert.equal(got.status, 200);
  const body = await got.json();
  assert.deepEqual(body.map((row) => row.path).sort(), ['photo-1', 'thumb-1']);

  const removed = await jsonAmz('Media_20160725.Remove', { paths: ['photo-1', 'thumb-1'] });
  assert.equal(removed.status, 200);
  const removedRows = await removed.json();
  assert.deepEqual(removedRows.map((row) => row.path).sort(), ['photo-1', 'thumb-1']);

  const afterRemove = await (await jsonAmz('Media_20160725.Get', { paths: ['photo-1', 'thumb-1'] })).json();
  assert.deepEqual(afterRemove, []);
});

// -- source-faithful error envelopes ------------------------------------------

test('List without loopIds -> ValidationException 400', async () => {
  const r = await list({});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('a non-member cannot list -> MEDIA_MUST_BE_MEMBER 403', async () => {
  const r = await list({ loopIds: [LOOP] }, OUTSIDER);
  assert.equal(r.status, 403);
  assert.equal(r.errType, 'MEDIA_MUST_BE_MEMBER');
});

test('a non-member cannot upload -> MEDIA_MUST_BE_MEMBER 403 and no bytes stored', async () => {
  const r = await upload('photo-outsider', Buffer.from('NOPE'), { accessKeyId: OUTSIDER });
  assert.equal(r.status, 403);
  assert.equal(r.errType, 'MEDIA_MUST_BE_MEMBER');
  assert.equal(store.find('photo-outsider'), null);
});

test('Create without x-loop-id -> ValidationException 400', async () => {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Media_20160725.Create',
      authorization: 'AWS4-HMAC-SHA256 Credential=x/20260910/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff',
    },
    body: Buffer.from('x'),
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('x-amzn-errortype'), 'ValidationException');
});

test('an unknown media type is rejected with ValidationException', async () => {
  const r = await upload('photo-badtype', Buffer.from('x'), { type: 'photo' });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('a duplicate path -> MEDIA_ALREADY_EXISTS 409', async () => {
  const r = await upload('photo-1', Buffer.from('again'));
  assert.equal(r.status, 409);
  assert.equal(r.errType, 'MEDIA_ALREADY_EXISTS');
});

test('a thumb pointing at a missing parent -> REFERENCE_NOT_FOUND 404', async () => {
  const r = await upload('thumb-orphan', Buffer.from('t'), { type: 'thumb', reference: 'no-such-image' });
  assert.equal(r.status, 404);
  assert.equal(r.errType, 'REFERENCE_NOT_FOUND');
});

test('a reference on a non-thumb type -> REFERENCE_FOR_THUMB 422', async () => {
  const r = await upload('photo-ref', Buffer.from('p'), { type: 'image', reference: 'photo-1' });
  assert.equal(r.status, 422);
  assert.equal(r.errType, 'REFERENCE_FOR_THUMB');
});

test('unknown media op -> ValidationException', async () => {
  const res = await jsonAmz('Media_20160725.Frobnicate', {});
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('x-amzn-errortype'), 'ValidationException');
});

test('RemoveAllMediaFromLoop drops the loop and answers what it removed', async () => {
  await upload('other-1', Buffer.from('o'), { loopId: OTHER_LOOP });
  const res = await jsonAmz('Media_20160725.RemoveAllMediaFromLoop', { loopId: OTHER_LOOP });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.map((row) => row.path), ['other-1']);
  assert.deepEqual((await list({ loopIds: [OTHER_LOOP] })).body, []);
});

// -- durability / semantics of the local store --------------------------------

test('a soft-deleted row keeps its place in List but loses its url (same as the source toJSON)', async () => {
  await upload('photo-soft', Buffer.from('s'));
  await jsonAmz('Media_20160725.Remove', { paths: ['photo-soft'] });
  const { body } = await list({ loopIds: [LOOP] });
  const row = body.find((entry) => entry.path === 'photo-soft');
  assert.ok(row, 'the source list query does not filter isDeleted');
  assert.equal(row.isDeleted, true);
  assert.equal(row.url, undefined);
});

test('the store survives a restart on the same file and the bytes are on disk', async () => {
  await upload('photo-durable', Buffer.from('durable-bytes'));
  const reopened = new MediaStore({ directory: join(dir, 'objects'), file: join(dir, 'media.json') });
  assert.ok(reopened.find('photo-durable'));
  const stream = reopened.openObject('photo-durable');
  assert.ok(stream);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'durable-bytes');
  const onDisk = await readFile(join(dir, 'objects', ACCOUNT, 'photo-durable.jpg'), 'utf8');
  assert.equal(onDisk, 'durable-bytes');
  // A thumbnail's bytes are reachable by the thumbnail's own path too.
  assert.equal(typeof reopened.objectFile('thumb-1'), 'string');
});

test('a recording is stored with the source .mp4 suffix', async () => {
  const rec = await upload('rec-1', Buffer.from('MP4'), { type: 'recording' });
  assert.equal(rec.body.type, 'recording');
  const res = await fetch(rec.body.url);
  assert.equal(await res.text(), 'MP4');
  const onDisk = await readFile(join(dir, 'objects', ACCOUNT, 'rec-1.mp4'), 'utf8');
  assert.equal(onDisk, 'MP4');
});
