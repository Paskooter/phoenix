// Jibo Jot — the loop-scoped family messaging service (A-19).
//
// Every expectation is pinned to the archive, not invented:
//   jibo:server/jot-ws@9a725d3ed8d991aa840131f5ef98c630df2fdf4e
//     src/handlers/message.handler.js, src/controllers/message.ctrl.js, src/errors/message.js,
//     src/schemes/message.js, src/clients/{account,media}.client.js
//   jibo:jiborobot/srv-jot-ws-archived@4432ac5d017ae1971a447f42e7a4b29da7eb2e58
//     archive/message.spec.js (literal X-Amz-Target `Jot_20160512.<Op>`),
//     src/controllers/message.ctrl.js, src/routes/route.js (POST /numberOfUnreadMessagesBulk)
//   jiborobot/srv-jibo-server-client apis/jot-2016-05-12.normal.json (the last wire model)
//   jibo:server/message-bus src/events/{base,jotEvents}.js (the JotMessageCreated payload)
//
// The regression this file exists to prevent: there was no /^jot/i route at all, so every Jot
// target — including the archived test's literal `Jot_20160512.CreateMessage` — answered
// UnknownOperationException 400 and no message ever persisted.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createClassicEntrypoint, JotStore, JOT_OPERATIONS, JOT_TARGET_PREFIXES, JOT_MESSAGES_LIMIT, JOT_BULK_ROUTE,
  JOT_DISPATCH_RULE, jotMethodNotFound, lowerFirstOp,
} from '../src/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = join(ROOT, 'packages', 'classic', 'src', 'index.js');

const LOOP = '5a0b20f5ddee0000197e2881';
const OTHER_LOOP = '59e66fc3762588001e64c296';
const OWNER = '43ca532ad4090cfb80f2e7a5';
const ROBOT = '43ca532ad4090cfb80f2e7a6';
const RECEIVER = '43ca532ad4090cfb80f2e7a7';
const INVITED = 'cafebabecafebabecafebabe';
const OUTSIDER = 'deadbeefdeadbeefdeadbeef';

// The AccountClient seam: GET /loop?loopId= -> the populated loop (the archived test's own fixture
// shape: members carry accountId + status; the Account store's populated loop also carries memberId,
// so both fields are present because the two recovered Jot revisions read different ones).
const LOOPS = {
  [LOOP]: {
    id: LOOP,
    robot: ROBOT,
    members: [
      { memberId: OWNER, accountId: OWNER, status: 'accepted' },
      { memberId: RECEIVER, accountId: RECEIVER, status: 'accepted' },
      { memberId: INVITED, accountId: INVITED, status: 'invited' },
    ],
  },
  [OTHER_LOOP]: {
    id: OTHER_LOOP,
    robot: ROBOT,
    members: [{ memberId: OUTSIDER, accountId: OUTSIDER, status: 'accepted' }],
  },
};
const account = { get: async (loopId) => LOOPS[loopId] || null };

// The MediaClient seam: POST /getMedia { accountId, paths } -> the expanded media rows. Only the
// paths the store actually holds come back (the source getMedia queries by path).
const MEDIA_PATHS = new Set(['known', 'p1', 'p2']);
const media = {
  getMedia: async (accountId, paths) => paths.filter((path) => MEDIA_PATHS.has(path)).map((path) => ({
    path, url: `https://media.example/${path}`, type: 'image', loopId: LOOP,
    accountId: OWNER, reference: null, created: 1700000000000, isDeleted: false,
  })),
};

let now = Date.UTC(2018, 8, 10, 12, 0, 0);
const clock = () => (now += 1);

let dir;
before(async () => { dir = await mkdtemp(join(tmpdir(), 'phoenix-jot-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

let seq = 0;
const nextFile = () => join(dir, `jot-${(seq += 1)}.json`);

function amzOn(port, target, body, accessKeyId = OWNER) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (accessKeyId) {
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff`;
  }
  return fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) })
    .then(async (res) => ({ status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) }));
}

function assertJotBoom(result, { statusCode, error, message, code }) {
  assert.equal(result.status, statusCode);
  assert.equal(result.errType || null, null, 'source Boom responses carry no x-amzn-errortype');
  const expected = { statusCode, error, message };
  if (code !== undefined) expected.code = code;
  assert.deepEqual(result.body, expected);
}

// @jibo/server identifies Boom errors with `isBoom`; this is the smallest source-shaped error
// the Account/Media seams can throw to exercise registry and upstream payload outcomes.
function sourceBoomError(statusCode, message, code) {
  const error = new Error(message);
  error.isBoom = true;
  error.statusCode = statusCode;
  if (code !== undefined) error.code = code;
  return error;
}

/**
 * The archived integration client's EXACT headers (jiborobot/srv-jot-ws-archived@4432ac5d
 * archive/message.spec.js): `X-Amz-Target: Jot_20160512.<Op>` plus
 * `X-Amz-Credentials: {"id":"<accountId>"}`. parseCredentials reads that header on the internal hop
 * (@jibo/server src/parseCredentials.js: `JSON.parse(request.headers['x-amz-credentials'])`), which
 * is the form the security gateway hands the service. Returns the raw body + every header so the
 * Boom (non-AWS) envelopes can be asserted exactly.
 */
function archivedAmzOn(port, target, body, accountId) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target };
  if (accountId) headers['x-amz-credentials'] = JSON.stringify({ id: accountId });
  return fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) })
    .then(async (res) => ({
      status: res.status,
      errType: res.headers.get('x-amzn-errortype'),
      contentType: res.headers.get('content-type'),
      body: await res.json().catch(() => null),
  }));
}

/** Native node:http request used for A19 envelope checks; fetch is deliberately not involved. */
function rawAmzOn(port, target, body, accessKeyId = OWNER) {
  const payload = Buffer.from(JSON.stringify(body || {}));
  const headers = {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    'content-length': payload.length,
  };
  if (accessKeyId) {
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff`;
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, raw, body: JSON.parse(raw) });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The archived spec's own AccountClient.get fixture (archive/message.spec.js:17-27): the loop robot
// plus two accepted members that carry ONLY `accountId` — the pre-refactor controller compares
// `member.accountId`, the refactor compares `member.memberId`, so a faithful fixture proves Phoenix
// accepts both shapes.
const ARCHIVED_LOOP = {
  [LOOP]: {
    robot: ROBOT,
    members: [
      { accountId: OWNER, status: 'accepted' },
      { accountId: RECEIVER, status: 'accepted' },
    ],
  },
};
const archivedAccount = { get: async (loopId) => ARCHIVED_LOOP[loopId] || null };
// The archived spec's MediaClient.getMedia fixture (archive/message.spec.js:29-36).
const archivedMedia = {
  getMedia: async (accountId, paths) => paths.filter((path) => path === 'sample')
    .map((path) => ({ path, url: 'sample_url' })),
};

/** A private entrypoint + store for one test (no shared state, controllable clock). `sink: false`
 *  leaves the default event sink in place (the durable ledger) instead of capturing into an array. */
async function fresh({ account: acct = account, media: med = media, file = nextFile(), sink = true } = {}) {
  const store = new JotStore({ file, clock });
  const events = [];
  const opts = { jot: { store } };
  if (sink) opts.jot.onEvent = async (event) => events.push(JSON.parse(JSON.stringify(event)));
  if (acct !== undefined) opts.jot.account = acct;
  if (med !== undefined) opts.jot.media = med;
  const server = await createClassicEntrypoint(opts).listen(0);
  const port = server.address().port;
  return { server, port, store, events, amz: (t, b, ak) => amzOn(port, t, b, ak) };
}

// ------------------------------------------------------------------------------------------------
// The five operations are SERVED, under both observed prefixes
// ------------------------------------------------------------------------------------------------

test('CreateMessage is served on both observed Jot prefixes (Jot_20160126 and Jot_20160512)', async () => {
  const j = await fresh();
  try {
    for (const [prefix, content] of [['Jot_20160126', 'model-prefix'], ['Jot_20160512', 'archived-test-prefix']]) {
      const r = await j.amz(`${prefix}.CreateMessage`, { loopId: LOOP, content });
      assert.equal(r.status, 200, `${prefix}.CreateMessage is served`);
      assert.equal(r.body.content, content);
      assert.equal(r.body.loopId, LOOP);
      assert.equal(r.body.sender, OWNER);
      assert.equal(r.body.isRead, true, 'the sender always reads their own message (read:[sender])');
      assert.equal(r.body.isEncrypted, false);
      assert.match(r.body.id, /^[a-f0-9]{24}$/);
      assert.equal(typeof r.body.created, 'number');
    }
  } finally { await j.server.close(); }
});

test('ListMessages is served, answers the loop ascending, and isRead is per caller', async () => {
  const j = await fresh();
  try {
    for (const content of ['one', 'two', 'three']) {
      await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content });
    }
    const asReceiver = await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER);
    assert.equal(asReceiver.status, 200);
    assert.deepEqual(asReceiver.body.map((m) => m.content), ['one', 'two', 'three']);
    assert.ok(asReceiver.body.every((m) => m.isRead === false), 'the receiver has not read them');

    const asSender = await j.amz('Jot_20160126.ListMessages', { loopId: LOOP });
    assert.equal(asSender.status, 200);
    assert.ok(asSender.body.every((m) => m.isRead === true), 'the sender read all of their own');
  } finally { await j.server.close(); }
});

test('MarkRead and MarkLoopRead are served on both prefixes and flip isRead', async () => {
  const j = await fresh();
  try {
    const created = [];
    for (let i = 0; i < 4; i += 1) created.push((await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: `m${i}` })).body);

    const marked = await j.amz('Jot_20160512.MarkRead', { ids: [created[0].id, created[1].id] }, RECEIVER);
    assert.equal(marked.status, 200);
    assert.deepEqual(marked.body, { result: 'Marked as read' });

    let listed = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.deepEqual(listed.map((m) => m.isRead), [true, true, false, false]);

    // MarkRead is $addToSet: a repeat is a no-op success.
    const again = await j.amz('Jot_20160126.MarkRead', { ids: [created[0].id] }, RECEIVER);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { result: 'Marked as read' });

    const loopRead = await j.amz('Jot_20160126.MarkLoopRead', { loopId: LOOP }, RECEIVER);
    assert.equal(loopRead.status, 200);
    assert.deepEqual(loopRead.body, { result: 'Marked all as read' });

    listed = (await j.amz('Jot_20160126.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.ok(listed.every((m) => m.isRead === true), 'MarkLoopRead marked the whole loop');
  } finally { await j.server.close(); }
});

test('NumberOfUnreadMessagesInLoops is served and counts only the caller unread in those loops', async () => {
  const j = await fresh();
  try {
    for (let i = 0; i < 3; i += 1) await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: `u${i}` });
    await j.amz('Jot_20160512.CreateMessage', { loopId: OTHER_LOOP, content: 'other' }, OUTSIDER);

    // The source count is a raw `Message.count({read:{$ne}, loopId:{$in}})` with NO membership check
    // (the sibling of the markRead TODO hole), so a caller can count unread in a loop it cannot list.
    const all = await j.amz('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP, OTHER_LOOP] }, RECEIVER);
    assert.equal(all.status, 200);
    assert.deepEqual(all.body, { count: 4 }, 'three in LOOP plus one in the loop it cannot list; the sender never counts their own');

    const scoped = await j.amz('Jot_20160126.NumberOfUnreadMessagesInLoops', { loopIds: [OTHER_LOOP] }, RECEIVER);
    assert.deepEqual(scoped.body, { count: 1 });

    const owner = await j.amz('Jot_20160126.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, OWNER);
    assert.deepEqual(owner.body, { count: 0 }, 'the creator read their own messages (read:[sender])');

    const other = await j.amz('Jot_20160126.NumberOfUnreadMessagesInLoops', { loopIds: [OTHER_LOOP] }, OUTSIDER);
    assert.deepEqual(other.body, { count: 0 }, 'OUTSIDER created the OTHER_LOOP message, so it read it');
  } finally { await j.server.close(); }
});

test('the direct POST /numberOfUnreadMessagesBulk route answers one entry per requested account', async () => {
  const j = await fresh();
  try {
    for (let i = 0; i < 2; i += 1) await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: `b${i}` });
    const res = await fetch(`http://localhost:${j.port}${JOT_BULK_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify([{ accountId: RECEIVER, loopIds: [LOOP] }, { accountId: OWNER, loopIds: [LOOP, OTHER_LOOP] }]),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [
      { count: 2, accountId: RECEIVER, loopIds: [LOOP] },
      { count: 0, accountId: OWNER, loopIds: [LOOP, OTHER_LOOP] },
    ]);

    const bad = await fetch(`http://localhost:${j.port}${JOT_BULK_ROUTE}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accountId: RECEIVER }),
    });
    assert.equal(bad.status, 400, 'the source route validates a required array payload');
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Shape / semantics
// ------------------------------------------------------------------------------------------------

test('a created message carries exactly the pinned Message members', async () => {
  const j = await fresh();
  try {
    const r = await j.amz('Jot_20160512.CreateMessage', {
      loopId: LOOP, content: 'shape', tags: [RECEIVER], isEncrypted: true, parts: [{ path: 'p1' }, { path: 'p2', meta: { k: 1 } }],
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ['content', 'created', 'id', 'isEncrypted', 'isRead', 'loopId', 'parts', 'sender', 'tags'].sort());
    assert.deepEqual(r.body.tags, [RECEIVER]);
    assert.equal(r.body.isEncrypted, true);
    assert.deepEqual(r.body.parts.map((p) => p.path), ['p1', 'p2']);
    assert.deepEqual(r.body.parts[1].meta, { k: 1 });
  } finally { await j.server.close(); }
});

test('list paginates with exclusive after/before bounds and caps at MESSAGES_LIMIT', async () => {
  const j = await fresh();
  try {
    const created = [];
    for (let i = 0; i < 20; i += 1) created.push((await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: `n${i}` })).body);

    const all = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.equal(all.length, 20);

    const after = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP, after: created[5].created }, RECEIVER)).body;
    assert.deepEqual(after.map((m) => m.content), created.slice(6).map((m) => m.content), 'after is an exclusive lower bound');
    assert.ok(after.every((m, index) => index === 0 || m.created >= after[index - 1].created), 'the page is ascending');

    const before = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP, before: created[14].created }, RECEIVER)).body;
    assert.deepEqual(before.map((m) => m.content), created.slice(0, 14).map((m) => m.content), 'before is an exclusive upper bound');

    for (let i = 20; i < 60; i += 1) created.push((await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: `n${i}` })).body);
    const capped = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.equal(capped.length, JOT_MESSAGES_LIMIT, 'the source limits the descending pass to 50 then reverses it');
    assert.deepEqual(capped.map((m) => m.content), created.slice(10).map((m) => m.content), 'the 50 NEWEST, answered ascending');
  } finally { await j.server.close(); }
});

test('messages never leak across loops', async () => {
  const j = await fresh();
  try {
    await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'in-my-loop' });
    await j.amz('Jot_20160512.CreateMessage', { loopId: OTHER_LOOP, content: 'in-another-loop' }, OUTSIDER);

    const mine = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.deepEqual(mine.map((m) => m.content), ['in-my-loop']);

    const theirs = (await j.amz('Jot_20160512.ListMessages', { loopId: OTHER_LOOP }, OUTSIDER)).body;
    assert.deepEqual(theirs.map((m) => m.content), ['in-another-loop']);

    // The receiver is not a member of OTHER_LOOP -> the membership gate, not an empty page.
    const denied = await j.amz('Jot_20160512.ListMessages', { loopId: OTHER_LOOP }, RECEIVER);
    assertJotBoom(denied, {
      statusCode: 403, error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    });
  } finally { await j.server.close(); }
});

test('media population fills the part url/type/reference from the Media getMedia hop', async () => {
  const j = await fresh();
  try {
    const r = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, parts: [{ path: 'known' }, { path: 'unknown' }] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.parts[0], {
      path: 'known', url: 'https://media.example/known', type: 'image', loopId: LOOP,
      accountId: OWNER, reference: null, created: 1700000000000, isDeleted: false,
    });
    assert.deepEqual(r.body.parts[1], { path: 'unknown' }, 'no media row -> path only, never a fabricated url');

    const listed = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.equal(listed[0].parts[0].url, 'https://media.example/known');
  } finally { await j.server.close(); }
});

test('create emits JotMessageCreated with the message-bus payload', async () => {
  const j = await fresh();
  try {
    const created = (await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'eventful', tags: [RECEIVER] })).body;
    assert.equal(j.events.length, 1);
    assert.deepEqual(j.events[0].payload, {
      eventKey: 'JotMessageCreated', messageId: created.id, senderId: OWNER,
      loopId: LOOP, tags: [RECEIVER], content: 'eventful',
    });
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Auth, membership, impersonation, validation, precedence, failures
// ------------------------------------------------------------------------------------------------

test('create refuses a non-member and a not-yet-accepted invitee (JOT_MUST_BE_LOOP_MEMBER 403)', async () => {
  const j = await fresh();
  try {
    const outsider = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }, OUTSIDER);
    assertJotBoom(outsider, {
      statusCode: 403, error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    });

    const invited = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }, INVITED);
    assertJotBoom(invited, {
      statusCode: 403, error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    });
  } finally { await j.server.close(); }
});

test('membership precedes the content-or-parts check (403 before 422)', async () => {
  const j = await fresh();
  try {
    // getImpersonatedAccount is the first statement of the source create: an outsider with NO content
    // and NO parts still gets the membership error, not the content error.
    const outsiderEmpty = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP }, OUTSIDER);
    assertJotBoom(outsiderEmpty, {
      statusCode: 403, error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    });

    for (const body of [{ loopId: LOOP }, { loopId: LOOP, parts: [] }]) {
      const r = await j.amz('Jot_20160512.CreateMessage', body);
      assertJotBoom(r, {
        statusCode: 422, error: 'Unprocessable Entity',
        message: 'Either content or parts must be present',
        code: 'JOT_CONTENT_OR_PARTS_REQUIRED',
      });
    }
    const emptyContent = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: '' });
    assertJotBoom(emptyContent, {
      statusCode: 422, error: 'Unprocessable Entity',
      message: 'child "content" fails because ["content" is not allowed to be empty]',
    });

    const withParts = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, parts: [{ path: 'p' }] });
    assert.equal(withParts.status, 200, 'parts alone are enough');
  } finally { await j.server.close(); }
});

test('only the loop robot may impersonate; a member may not (JOT_ROBOT_CAN_IMPERSONATE 403)', async () => {
  const j = await fresh();
  try {
    const robot = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'from-the-robot', impersonateAs: RECEIVER }, ROBOT);
    assert.equal(robot.status, 200);
    assert.equal(robot.body.sender, RECEIVER, 'the message is attributed to the impersonated member');

    const member = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'nope', impersonateAs: RECEIVER }, OWNER);
    assertJotBoom(member, {
      statusCode: 403, error: 'Forbidden', message: 'Only robot can impersonate as loop member',
      code: 'JOT_ROBOT_CAN_IMPERSONATE',
    });

    // Even the robot cannot impersonate a non-member.
    const robotOutsider = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x', impersonateAs: OUTSIDER }, ROBOT);
    assertJotBoom(robotOutsider, {
      statusCode: 403, error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    });
  } finally { await j.server.close(); }
});

test('an unsigned request is MISSING_AUTH_HEADER 401; an unmapped operation is the framework 404', async () => {
  const j = await fresh();
  try {
    const unsigned = await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, null);
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.errType, 'MISSING_AUTH_HEADER');
    assert.equal(unsigned.body.message, 'Request is not signed properly, missing authorization header');

    // The framework resolves the operation BEFORE parseCredentials/validatePayload, so an unmapped
    // operation is the raw Boom 404 even when unsigned — not the 400 ValidationException the other
    // classic services use for an unknown method.
    const unknown = await j.amz('Jot_20160512.Frobnicate', { loopId: LOOP });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.errType, null, 'the raw Boom body carries no x-amzn-errortype');
    assert.deepEqual(unknown.body, { statusCode: 404, error: 'Not Found', message: 'Method frobnicate not found.' });

    const unsignedUnknown = await j.amz('Jot_20160512.Frobnicate', { loopId: LOOP }, null);
    assert.equal(unsignedUnknown.status, 404, 'handler resolution precedes the auth gate');
    assert.deepEqual(unsignedUnknown.body, { statusCode: 404, error: 'Not Found', message: 'Method frobnicate not found.' });

    // A party-era operation with no recovered matching-era handler is NOT invented: it is the same
    // framework 404, with the lower-first operation name quoted back.
    const partyEra = await j.amz('Jot_20160310.CreatePart', { path: 'p' });
    assert.equal(partyEra.status, 404);
    assert.equal(partyEra.errType, null);
    assert.deepEqual(partyEra.body, { statusCode: 404, error: 'Not Found', message: 'Method createPart not found.' });
  } finally { await j.server.close(); }
});

test('payload validation matches the pinned @validatePayload Joi rules', async () => {
  const j = await fresh();
  const cases = [
    ['Jot_20160512.CreateMessage', {}],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, content: 5 }],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, impersonateAs: 5 }],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, tags: 'not-an-array' }],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, tags: [1] }],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, isEncrypted: 'yes' }],
    ['Jot_20160512.CreateMessage', { loopId: LOOP, parts: [{}] }],
    ['Jot_20160512.ListMessages', { loopId: LOOP, before: 'x' }],
    ['Jot_20160512.ListMessages', {}],
    ['Jot_20160512.MarkRead', { ids: [] }],
    ['Jot_20160512.MarkRead', { ids: 'x' }],
    ['Jot_20160512.MarkRead', {}],
    ['Jot_20160512.MarkLoopRead', {}],
    ['Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [] }],
    ['Jot_20160512.NumberOfUnreadMessagesInLoops', {}],
  ];
  try {
    for (const [target, body] of cases) {
      const r = await j.amz(target, body);
      assert.equal(r.status, 422, `${target} ${JSON.stringify(body)}`);
      assert.equal(r.errType, null, `${target} carries no x-amzn-errortype`);
      assert.equal(r.body.statusCode, 422);
      assert.equal(r.body.error, 'Unprocessable Entity');
      assert.equal(r.body.code, undefined);
    }
    // The bound fields quoted back are the Joi child names.
    const missing = await j.amz('Jot_20160512.ListMessages', {});
    assert.match(missing.body.message, /"loopId" is required/);
    const emptyIds = await j.amz('Jot_20160512.MarkRead', { ids: [] });
    assert.match(emptyIds.body.message, /"ids" must contain at least 1 items/);
    const badParts = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, parts: [{}] });
    assert.match(badParts.body.message, /"path" is required/);
  } finally { await j.server.close(); }
});

test('A19e/f/g raw node:http envelopes, precedence, and negative headers', async () => {
  const j = await fresh();
  try {
    // Boom.badData from @validatePayload: 422, reason phrase, no code or AWS header.
    const validation = await rawAmzOn(j.port, 'Jot_20160512.ListMessages', {}, OWNER);
    assert.equal(validation.status, 422);
    assert.equal(validation.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(validation.headers['x-amzn-errortype'], undefined);
    assert.equal(validation.headers['x-powered-by'], undefined);
    assert.equal(validation.raw, JSON.stringify({
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'child "loopId" fails because ["loopId" is required]',
    }));
    assert.equal(validation.body.code, undefined, 'Joi failures do not acquire the controller code');
    assert.equal(validation.body.__type, undefined, 'Joi failures do not acquire an AWS __type');

    // Boom.createWithCode from message.ctrl.js: the explicit JOT code is in the body only.
    const membership = await rawAmzOn(j.port, 'Jot_20160512.ListMessages', { loopId: OTHER_LOOP }, RECEIVER);
    assert.equal(membership.status, 403);
    assert.equal(membership.headers['x-amzn-errortype'], undefined);
    assert.equal(membership.raw, JSON.stringify({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You must be a member of the loop to list or create messages',
      code: 'JOT_MUST_BE_LOOP_MEMBER',
    }));
    assert.equal(membership.body.__type, undefined, 'Jot business refusals do not acquire an AWS __type');

    const content = await rawAmzOn(j.port, 'Jot_20160512.CreateMessage', { loopId: LOOP }, OWNER);
    assert.equal(content.status, 422);
    assert.equal(content.headers['x-amzn-errortype'], undefined);
    assert.deepEqual(content.body, {
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'Either content or parts must be present',
      code: 'JOT_CONTENT_OR_PARTS_REQUIRED',
    });

    // Joi.string() also rejects an explicitly empty content member before the controller runs;
    // this is a validation 422 with no JOT_CONTENT_OR_PARTS_REQUIRED code.
    const emptyContent = await rawAmzOn(j.port, 'Jot_20160512.CreateMessage', { loopId: LOOP, content: '' }, OWNER);
    assert.equal(emptyContent.status, 422);
    assert.equal(emptyContent.headers['x-amzn-errortype'], undefined);
    assert.deepEqual(emptyContent.body, {
      statusCode: 422,
      error: 'Unprocessable Entity',
      message: 'child "content" fails because ["content" is not allowed to be empty]',
    });

    // @parseCredentials is outermost: an unsigned mapped request remains the AWS 401 and does
    // not fall through to the 422 Joi branch.
    const unsigned = await rawAmzOn(j.port, 'Jot_20160512.ListMessages', {}, null);
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.headers['x-amzn-errortype'], 'MISSING_AUTH_HEADER');
    assert.deepEqual(unsigned.body, {
      __type: 'MISSING_AUTH_HEADER',
      message: 'Request is not signed properly, missing authorization header',
    });

    // The pinned lowerMethodName throws before auth/method lookup for a dotless target; this is
    // the scoped framework 500 branch in the shared Classic router.
    const dotless = await rawAmzOn(j.port, 'Jot_20160512CreateMessage', {}, null);
    assert.equal(dotless.status, 500);
    assert.equal(dotless.headers['x-amzn-errortype'], undefined);
    assert.equal(dotless.raw, JSON.stringify({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'An internal server error occurred',
    }));

    // Unmapped operations still take the framework 404 before auth/validation.
    const unknown = await rawAmzOn(j.port, 'Jot_20160512.Frobnicate', {}, null);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers['x-amzn-errortype'], undefined);
    assert.deepEqual(unknown.body, {
      statusCode: 404,
      error: 'Not Found',
      message: 'Method frobnicate not found.',
    });
  } finally { await j.server.close(); }
});

test('a generic account network hop is the source raw 500', async () => {
  const broken = { get: async () => { throw new Error('account down'); } };
  const j = await fresh({ account: broken });
  try {
    for (const [target, body] of [['Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }], ['Jot_20160512.ListMessages', { loopId: LOOP }]]) {
      const r = await j.amz(target, body);
      assertJotBoom(r, {
        statusCode: 500, error: 'Internal Server Error', message: 'An internal server error occurred',
      });
    }
  } finally { await j.server.close(); }
});

test('a generic media network hop is the source raw 500 after the message is persisted', async () => {
  const brokenMedia = { getMedia: async () => { throw new Error('media down'); } };
  const j = await fresh({ media: brokenMedia });
  try {
    const part = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'persisted-first' });
    assertJotBoom(part, {
      statusCode: 500, error: 'Internal Server Error', message: 'An internal server error occurred',
    });
    // The source commits Message.create and sends the event BEFORE populateParts, so the row stays.
    assert.equal(j.store.findForList({ loopId: LOOP }).length, 1);
    assert.equal(j.events.length, 1);
  } finally { await j.server.close(); }
});

test('A19f Account/Media registry, upstream, and network failures preserve source raw classification', async () => {
  const cases = [
    {
      name: 'account registry unavailable',
      options: { account: { get: async () => { throw sourceBoomError(503, 'Account service not available', 'ACCOUNT_SERVICE_UNAVAILABLE'); } } },
      target: 'Jot_20160512.ListMessages',
      body: { loopId: LOOP },
      expected: { statusCode: 503, error: 'Service Unavailable', message: 'Account service not available', code: 'ACCOUNT_SERVICE_UNAVAILABLE' },
    },
    {
      name: 'account upstream payload error',
      options: { account: { get: async () => { throw sourceBoomError(502, 'account payload failure'); } } },
      target: 'Jot_20160512.ListMessages',
      body: { loopId: LOOP },
      expected: { statusCode: 502, error: 'Bad Gateway', message: 'account payload failure' },
    },
    {
      name: 'account generic network failure',
      options: { account: { get: async () => { throw new Error('ECONNREFUSED'); } } },
      target: 'Jot_20160512.ListMessages',
      body: { loopId: LOOP },
      expected: { statusCode: 500, error: 'Internal Server Error', message: 'An internal server error occurred' },
    },
    {
      name: 'media registry unavailable',
      options: { media: { getMedia: async () => { throw sourceBoomError(503, 'Media service not available', 'MEDIA_SERVICE_UNAVAILABLE'); } } },
      target: 'Jot_20160512.CreateMessage',
      body: { loopId: LOOP, content: 'media-registry' },
      expected: { statusCode: 503, error: 'Service Unavailable', message: 'Media service not available', code: 'MEDIA_SERVICE_UNAVAILABLE' },
    },
    {
      name: 'media upstream payload error',
      options: { media: { getMedia: async () => { throw sourceBoomError(502, 'media payload failure'); } } },
      target: 'Jot_20160512.CreateMessage',
      body: { loopId: LOOP, content: 'media-upstream' },
      expected: { statusCode: 502, error: 'Bad Gateway', message: 'media payload failure' },
    },
    {
      name: 'media generic network failure',
      options: { media: { getMedia: async () => { throw new Error('ECONNRESET'); } } },
      target: 'Jot_20160512.CreateMessage',
      body: { loopId: LOOP, content: 'media-network' },
      expected: { statusCode: 500, error: 'Internal Server Error', message: 'An internal server error occurred' },
    },
  ];
  for (const item of cases) {
    const j = await fresh(item.options);
    try {
      const result = await rawAmzOn(j.port, item.target, item.body);
      assertJotBoom(result, item.expected);
      assert.equal(result.headers['content-type'], 'application/json; charset=utf-8', item.name);
      assert.equal(result.headers['x-amzn-errortype'], undefined, `${item.name} has no AWS error header`);
      assert.equal(result.headers['x-powered-by'], undefined, `${item.name} has no framework power header`);
    } finally {
      await j.server.close();
    }
  }
});

test('LAN trust: with no account seam wired the membership and robot gates are skipped', async () => {
  const j = await fresh({ account: null });
  try {
    const outsider = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'lan-trust' }, OUTSIDER);
    assert.equal(outsider.status, 200);
    assert.equal(outsider.body.sender, OUTSIDER);

    const robot = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'on-behalf', impersonateAs: RECEIVER }, ROBOT);
    assert.equal(robot.status, 200);
    assert.equal(robot.body.sender, RECEIVER, 'the impersonation substitution is kept when the gates are skipped');
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Durability
// ------------------------------------------------------------------------------------------------

test('jot state survives a restart (new entrypoint, same store file) including the event ledger', async () => {
  const file = nextFile();
  const first = await fresh({ file, sink: false });
  let ids;
  try {
    ids = [];
    for (const content of ['persisted-a', 'persisted-b']) {
      ids.push((await first.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content })).body.id);
    }
    await first.amz('Jot_20160512.MarkRead', { ids: [ids[0]] }, RECEIVER);
  } finally { await first.server.close(); }

  // A brand-new entrypoint + store object over the same file; the default sink is the event ledger.
  const second = await fresh({ file, sink: false });
  try {
    const listed = (await second.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.deepEqual(listed.map((m) => m.id), ids);
    assert.deepEqual(listed.map((m) => m.isRead), [true, false], 'the read set survives');
    assert.deepEqual((await second.amz('Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, RECEIVER)).body, { count: 1 });
  } finally { await second.server.close(); }

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.messages.length, 2);
  assert.deepEqual(raw.events.map((e) => e.eventKey), ['JotMessageCreated', 'JotMessageCreated']);
  assert.deepEqual(raw.events.map((e) => e.messageId), ids);
});

test('jot state survives a SIGKILL process restart (fresh process, same store file)', async () => {
  const file = nextFile();
  const first = await startChild(file);
  let created;
  try {
    created = (await childAmz(first.base, 'Jot_20160512.CreateMessage', { loopId: LOOP, content: 'survives-a-kill', tags: [RECEIVER] })).body;
    assert.equal(created.content, 'survives-a-kill');
    await childAmz(first.base, 'Jot_20160512.MarkRead', { ids: [created.id] }, RECEIVER);
  } finally { await first.stop(); } // SIGKILL: no graceful shutdown, nothing flushed on exit

  const second = await startChild(file);
  try {
    const listed = (await childAmz(second.base, 'Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].content, 'survives-a-kill');
    assert.equal(listed[0].isRead, true, 'the read set read back from disk after the kill');
    assert.deepEqual((await childAmz(second.base, 'Jot_20160512.NumberOfUnreadMessagesInLoops', { loopIds: [LOOP] }, RECEIVER)).body, { count: 0 });
  } finally { await second.stop(); }

  const raw = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(raw.messages.length, 1);
  assert.deepEqual(raw.events.map((e) => e.payload && e.payload.eventKey ? e.payload.eventKey : e.eventKey), ['JotMessageCreated']);
});

async function freePort() {
  const srv = http.createServer();
  await new Promise((resolve) => srv.listen(0, resolve));
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** Start the real classic entrypoint as a child process over `jotFile` (its own fresh JotStore). */
async function startChild(jotFile) {
  const port = await freePort();
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), ETCO_classic_jotFile: jotFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://localhost:${port}`;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const res = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Jot_20160512.ListMessages', authorization: `AWS4-HMAC-SHA256 Credential=${OWNER}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff` },
        body: JSON.stringify({ loopId: LOOP }),
      });
      if (res.status === 200) {
        return {
          base,
          child,
          stop: () => new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('close', resolve);
            child.kill('SIGKILL');
          }),
        };
      }
    } catch { /* not listening yet */ }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`classic entrypoint child did not start: ${stderr}`);
}

function childAmz(base, target, body, accessKeyId = OWNER) {
  return fetch(`${base}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  }).then(async (res) => ({ status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) }));
}

// ------------------------------------------------------------------------------------------------
// The mapped contract
// ------------------------------------------------------------------------------------------------

test('jot maps exactly the five pinned loop-era operations and records both observed prefixes', () => {
  assert.deepEqual(JOT_OPERATIONS, ['createmessage', 'listmessages', 'markread', 'markloopread', 'numberofunreadmessagesinloops']);
  assert.deepEqual(JOT_TARGET_PREFIXES, ['Jot_20160126', 'Jot_20160512']);
  assert.equal(JOT_MESSAGES_LIMIT, 50);
  assert.equal(JOT_BULK_ROUTE, '/numberOfUnreadMessagesBulk');
  assert.equal(JOT_DISPATCH_RULE, 'operation-name-only');
});

// ------------------------------------------------------------------------------------------------
// A19a — the deployed dispatch rule: the target prefix is NOT significant
// ------------------------------------------------------------------------------------------------

test('A19a resolved: every Jot target prefix reaches the same five handlers', async () => {
  const j = await fresh();
  try {
    // server/server src/server.js lowerMethodName / @jibo/server@3.1.1 dst/server.js:70-73:
    //   const methodName = target.split('.')[1];
    //   return methodName[0].toLowerCase() + methodName.substring(1);
    assert.equal(lowerFirstOp('CreateMessage'), 'createMessage', 'only the FIRST character is lowered');
    assert.equal(lowerFirstOp('NumberOfUnreadMessagesInLoops'), 'numberOfUnreadMessagesInLoops');
    assert.equal(lowerFirstOp(''), '');

    // `Jot_20160126` = the prefix the last SDK model declares; `Jot_20160512` = the literal prefix of
    // the only recovered runtime test; `Jot_20160310` = the party-era model; `Jot_29991231` = a
    // prefix no archive artifact ever carried. The dispatcher never compares the prefix, so all four
    // select the same five operations.
    for (const prefix of ['Jot_20160126', 'Jot_20160512', 'Jot_20160310', 'Jot_29991231']) {
      const created = await j.amz(`${prefix}.CreateMessage`, { loopId: LOOP, content: `via ${prefix}` });
      assert.equal(created.status, 200, `${prefix}.CreateMessage`);
      assert.equal(created.body.sender, OWNER);
      assert.equal(created.body.content, `via ${prefix}`);

      const listed = await j.amz(`${prefix}.ListMessages`, { loopId: LOOP }, RECEIVER);
      assert.equal(listed.status, 200, `${prefix}.ListMessages`);
      assert.ok(listed.body.some((m) => m.content === `via ${prefix}`));

      assert.equal((await j.amz(`${prefix}.MarkRead`, { ids: [created.body.id] }, RECEIVER)).status, 200, `${prefix}.MarkRead`);
      assert.equal((await j.amz(`${prefix}.MarkLoopRead`, { loopId: LOOP }, RECEIVER)).status, 200, `${prefix}.MarkLoopRead`);

      const count = await j.amz(`${prefix}.NumberOfUnreadMessagesInLoops`, { loopIds: [LOOP] }, RECEIVER);
      assert.equal(count.status, 200, `${prefix}.NumberOfUnreadMessagesInLoops`);
      assert.deepEqual(Object.keys(count.body), ['count'], 'the declared output shape is exactly {count}');
    }
  } finally { await j.server.close(); }
});

test('every model-declared Jot operation maps to the served set or the framework 404, per version', async () => {
  // Read directly from jiborobot/srv-jibo-server-client through the archive MCP (revisions cited in
  // src/jot.js). Each entry is a model file and its declared operations.
  const MODEL_OPERATIONS = [
    ['jot-2016-01-26@4c68f963', 'Jot_20160126', ['CreateMessage', 'RemoveMessage', 'ListIncomingMessages', 'ListSentMessages', 'MarkDelivered', 'MarkSeen']],
    ['jot-2016-05-12@b2da11bc', 'Jot_20160126', ['CreateMessage', 'ListMessages', 'MarkRead', 'MarkLoopRead', 'NumberOfUnreadMessagesInLoops']],
    ['jot-2016-03-10@1b26ad78', 'Jot_20160310', ['CreatePart', 'CreateMessage', 'UpdateMessage', 'RemoveMessage', 'GetMessages', 'ListIncomingMessages', 'ListSentMessages', 'MarkDelivered', 'MarkAllDelivered', 'MarkSeen', 'MarkAllSeen']],
    ['jot-2016-03-10@39f53698', 'Jot_20160310', ['CreatePart', 'CreateMessage', 'UpdateMessage', 'RemoveMessage', 'GetMessages', 'ListMessages', 'MarkSeen', 'MarkAllSeen']],
  ];
  // Pairs that live only in the A-01 operation map's Jot_20160310 union (a later model cut that was
  // not fetched here); included so the map the task refers to is covered end to end.
  const MAP_ONLY = ['ListInbox', 'ListSent'];

  const pairs = [];
  for (const [, prefix, ops] of MODEL_OPERATIONS) for (const op of ops) pairs.push([prefix, op]);
  for (const op of MAP_ONLY) pairs.push(['Jot_20160310', op]);

  // A body that satisfies the pinned @validatePayload for each SERVED operation. An unserved
  // operation is answered before @validatePayload runs, so its body is irrelevant (asserted below).
  const validBodyFor = (op) => ({
    CreateMessage: { loopId: LOOP, content: 'model-op' },
    ListMessages: { loopId: LOOP },
    MarkRead: { ids: ['a'.repeat(24)] },
    MarkLoopRead: { loopId: LOOP },
    NumberOfUnreadMessagesInLoops: { loopIds: [LOOP] },
  }[op] || {});

  const j = await fresh();
  try {
    const served = new Set();
    const refused = new Set();
    for (const [prefix, op] of pairs) {
      const r = await j.amz(`${prefix}.${op}`, validBodyFor(op));
      if (r.status === 200) { served.add(op.toLowerCase()); continue; }
      assert.equal(r.status, 404, `${prefix}.${op}`);
      assert.equal(r.errType, null, `${prefix}.${op} carries no x-amzn-errortype`);
      assert.deepEqual(r.body, jotMethodNotFound(op), `${prefix}.${op}`);
      refused.add(op.toLowerCase());
    }
    assert.deepEqual([...served].sort(), [...JOT_OPERATIONS].sort(), 'exactly the five loop-era names are served');
    // 17 distinct model operation names - the 5 served = the 12 refused.
    assert.equal(refused.size, 12);
    for (const name of refused) assert.ok(!JOT_OPERATIONS.includes(name));
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Original-client messaging journeys (acceptance 4) — the substitution, stated explicitly
// ------------------------------------------------------------------------------------------------
// The original client is DEAD: the Jibo mobile app and the robot's SDK build cannot be run, and the
// only recovered EXERCISE of this service is jiborobot/srv-jot-ws-archived@4432ac5d
// archive/message.spec.js (an in-process Hapi `server.inject` suite). THE SUBSTITUTE: that spec's
// requests are replayed VERBATIM at the WIRE level against a REAL Phoenix entrypoint listening on a
// real TCP socket. The wire contract is byte-for-byte the archived client's — POST /, Content-Type
// application/x-amz-json-1.1, X-Amz-Target `Jot_20160512.<Op>`, X-Amz-Credentials `{"id":…}` — and
// every postcondition the archived spec asserted is asserted here. What it cannot prove is named in
// the task report (the real SDK's SigV4 signing / the TLS hop to the security gateway, which is
// substituted by the x-amz-credentials form the gateway injects on the internal hop).

test('original-client journey: the archived archive/message.spec.js sequence, over real HTTP', async () => {
  const j = await fresh({ account: archivedAccount, media: archivedMedia });
  const amz = (target, body, accountId = OWNER) => archivedAmzOn(j.port, target, body, accountId);
  try {
    // 20 creates with parts[{path:'sample'}] (message.spec.js:49-80).
    const createdMessages = [];
    for (let i = 0; i < 20; i += 1) {
      const r = await amz('Jot_20160512.CreateMessage', {
        loopId: LOOP, content: `sample${i}`, tags: [RECEIVER], parts: [{ path: 'sample' }],
      });
      assert.equal(r.status, 200, `create ${i}`);
      createdMessages.push(r.body);
      assert.equal(r.body.content, `sample${i}`);
      assert.equal(r.body.isRead, true, 'the sender reads their own message');
      assert.equal(r.body.parts.length, 1);
      assert.equal(r.body.parts[0].url, 'sample_url', 'MediaClient.getMedia populated the part url');
    }

    // list inbox as the receiver: 20 rows, the first still unread (message.spec.js:81-98).
    let listed = await amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.length, 20);
    assert.equal(listed.body[0].isRead, false);

    // markRead [0,1] as the receiver, then list read (message.spec.js:99-133).
    assert.equal((await amz('Jot_20160512.MarkRead', { ids: [createdMessages[0].id, createdMessages[1].id] }, RECEIVER)).status, 200);
    listed = await amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER);
    assert.equal(listed.body.length, 20);
    assert.equal(listed.body[0].isRead, true);
    assert.equal(listed.body[1].isRead, true);

    // markLoopRead as the receiver, then list all read (message.spec.js:134-168).
    assert.equal((await amz('Jot_20160512.MarkLoopRead', { loopId: LOOP }, RECEIVER)).status, 200);
    listed = await amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER);
    assert.equal(listed.body.length, 20);
    assert.equal(listed.body[2].isRead, true);
    assert.equal(listed.body[3].isRead, true);

    // list after/before a created timestamp (message.spec.js:169-204).
    const after = await amz('Jot_20160512.ListMessages', { loopId: LOOP, after: createdMessages[5].created }, RECEIVER);
    assert.equal(after.body.length, 14);
    const before = await amz('Jot_20160512.ListMessages', { loopId: LOOP, before: createdMessages[14].created }, RECEIVER);
    assert.equal(before.body.length, 14);

    // the robot creates a message as a member, parts and all (message.spec.js:205-230).
    const impersonated = await amz('Jot_20160512.CreateMessage', {
      loopId: LOOP, content: 'sample', tags: [RECEIVER], impersonateAs: OWNER, parts: [{ path: 'sample' }],
    }, ROBOT);
    assert.equal(impersonated.status, 200);
    assert.equal(impersonated.body.sender, OWNER, 'impersonateAs attributes the message to the member');
    assert.equal(impersonated.body.parts[0].url, 'sample_url');
  } finally { await j.server.close(); }
});

// ------------------------------------------------------------------------------------------------
// Retry semantics
// ------------------------------------------------------------------------------------------------

test('retry semantics: a re-sent CreateMessage is not deduplicated; a re-sent MarkRead is a no-op', async () => {
  const j = await fresh();
  try {
    const body = { loopId: LOOP, content: 'sent-once-intended', tags: [RECEIVER] };
    const first = await j.amz('Jot_20160512.CreateMessage', body);
    const retry = await j.amz('Jot_20160512.CreateMessage', body);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    // No idempotency key exists anywhere in the pinned model, handler or controller.
    assert.notEqual(first.body.id, retry.body.id);
    assert.equal(j.store.findForList({ loopId: LOOP }).length, 2);
    assert.deepEqual(j.events.map((e) => e.payload.messageId), [first.body.id, retry.body.id],
      'each attempt emits its own JotMessageCreated');

    // `$addToSet` makes the read side idempotent: delivering the same MarkRead twice is invisible.
    await j.amz('Jot_20160512.MarkRead', { ids: [first.body.id] }, RECEIVER);
    const beforeRow = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body.find((m) => m.id === first.body.id);
    await j.amz('Jot_20160512.MarkRead', { ids: [first.body.id] }, RECEIVER);
    const afterRow = (await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, RECEIVER)).body.find((m) => m.id === first.body.id);
    assert.equal(beforeRow.isRead, true);
    assert.deepEqual(afterRow, beforeRow);
  } finally { await j.server.close(); }
});

test('retry after a failed media hop: the failed attempt persisted, the retry adds a second row', async () => {
  let fail = true;
  const flaky = {
    getMedia: async () => {
      if (fail) { fail = false; throw new Error('media down'); }
      return [];
    },
  };
  const j = await fresh({ media: flaky });
  try {
    const first = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'flaky' });
    assertJotBoom(first, {
      statusCode: 500, error: 'Internal Server Error', message: 'An internal server error occurred',
    });
    const retry = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'flaky' });
    assert.equal(retry.status, 200);
    // The source order is create -> send event -> populateParts, so the failed attempt had already
    // committed; a real client retrying the 503 therefore leaves TWO rows, and the ledger holds one
    // event per committed row.
    const rows = j.store.findForList({ loopId: LOOP });
    assert.equal(rows.length, 2);
    assert.deepEqual(j.events.map((e) => e.payload.messageId), rows.map((r) => r.id));
  } finally { await j.server.close(); }
});
