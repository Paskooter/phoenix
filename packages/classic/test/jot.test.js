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
    assert.equal(denied.status, 403);
    assert.equal(denied.errType, 'JOT_MUST_BE_LOOP_MEMBER');
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
    assert.equal(outsider.status, 403);
    assert.equal(outsider.errType, 'JOT_MUST_BE_LOOP_MEMBER');
    assert.equal(outsider.body.message, 'You must be a member of the loop to list or create messages');

    const invited = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }, INVITED);
    assert.equal(invited.status, 403);
    assert.equal(invited.errType, 'JOT_MUST_BE_LOOP_MEMBER');
  } finally { await j.server.close(); }
});

test('membership precedes the content-or-parts check (403 before 422)', async () => {
  const j = await fresh();
  try {
    // getImpersonatedAccount is the first statement of the source create: an outsider with NO content
    // and NO parts still gets the membership error, not the content error.
    const outsiderEmpty = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP }, OUTSIDER);
    assert.equal(outsiderEmpty.status, 403);
    assert.equal(outsiderEmpty.errType, 'JOT_MUST_BE_LOOP_MEMBER');

    for (const body of [{ loopId: LOOP }, { loopId: LOOP, parts: [] }, { loopId: LOOP, content: '' }]) {
      const r = await j.amz('Jot_20160512.CreateMessage', body);
      assert.equal(r.status, 422, JSON.stringify(body));
      assert.equal(r.errType, 'JOT_CONTENT_OR_PARTS_REQUIRED');
      assert.equal(r.body.message, 'Either content or parts must be present');
    }

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
    assert.equal(member.status, 403);
    assert.equal(member.errType, 'JOT_ROBOT_CAN_IMPERSONATE');
    assert.equal(member.body.message, 'Only robot can impersonate as loop member');

    // Even the robot cannot impersonate a non-member.
    const robotOutsider = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x', impersonateAs: OUTSIDER }, ROBOT);
    assert.equal(robotOutsider.status, 403);
    assert.equal(robotOutsider.errType, 'JOT_MUST_BE_LOOP_MEMBER');
  } finally { await j.server.close(); }
});

test('an unsigned request is MISSING_AUTH_HEADER 401 and an unknown operation is 400', async () => {
  const j = await fresh();
  try {
    const unsigned = await j.amz('Jot_20160512.ListMessages', { loopId: LOOP }, null);
    assert.equal(unsigned.status, 401);
    assert.equal(unsigned.errType, 'MISSING_AUTH_HEADER');

    const unknown = await j.amz('Jot_20160512.Frobnicate', { loopId: LOOP });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.errType, 'ValidationException');
    assert.match(unknown.body.message, /unknown jot operation/);

    // A party-era operation with no recovered matching-era handler is NOT invented.
    const partyEra = await j.amz('Jot_20160310.CreatePart', { path: 'p' });
    assert.equal(partyEra.status, 400);
    assert.equal(partyEra.errType, 'ValidationException');
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
      assert.equal(r.status, 400, `${target} ${JSON.stringify(body)}`);
      assert.equal(r.errType, 'ValidationException');
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

test('a failing account hop is ACCOUNT_SERVICE_UNAVAILABLE 503', async () => {
  const broken = { get: async () => { throw new Error('account down'); } };
  const j = await fresh({ account: broken });
  try {
    for (const [target, body] of [['Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }], ['Jot_20160512.ListMessages', { loopId: LOOP }]]) {
      const r = await j.amz(target, body);
      assert.equal(r.status, 503, target);
      assert.equal(r.errType, 'ACCOUNT_SERVICE_UNAVAILABLE');
      assert.equal(r.body.message, 'Account service not available');
    }
  } finally { await j.server.close(); }
});

test('a failing media hop is MEDIA_SERVICE_UNAVAILABLE 503 after the message is persisted', async () => {
  const brokenMedia = { getMedia: async () => { throw new Error('media down'); } };
  const j = await fresh({ media: brokenMedia });
  try {
    const part = await j.amz('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'persisted-first' });
    assert.equal(part.status, 503);
    assert.equal(part.errType, 'MEDIA_SERVICE_UNAVAILABLE');
    // The source commits Message.create and sends the event BEFORE populateParts, so the row stays.
    assert.equal(j.store.findForList({ loopId: LOOP }).length, 1);
    assert.equal(j.events.length, 1);
  } finally { await j.server.close(); }
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
});
