// A-19 runtime probe: proves every Jot operation is SERVED (not merely present in source) by
// starting the real classic entrypoint and sending the archived integration test's literal
// `Jot_20160512` targets plus the model's `Jot_20160126` targets, the direct bulk route, and the
// pinned error precedence. Writes live-probe.json next to this file.
//
//   node docs/parity/evidence/2026-09-10/a19-jot/probe.mjs
//
// Exit 0 = every expectation held; 1 = a mismatch.

import { createClassicEntrypoint, JotStore } from '../../../../../packages/classic/src/index.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOP = '5a0b20f5ddee0000197e2881';
const OTHER_LOOP = '59e66fc3762588001e64c296';
const OWNER = '43ca532ad4090cfb80f2e7a5';
const ROBOT = '43ca532ad4090cfb80f2e7a6';
const RECEIVER = '43ca532ad4090cfb80f2e7a7';
const INVITED = 'cafebabecafebabecafebabe';
const OUTSIDER = 'deadbeefdeadbeefdeadbeef';

const account = {
  get: async (loopId) => (loopId === LOOP ? {
    id: LOOP,
    robot: ROBOT,
    members: [
      { memberId: OWNER, accountId: OWNER, status: 'accepted' },
      { memberId: RECEIVER, accountId: RECEIVER, status: 'accepted' },
      { memberId: INVITED, accountId: INVITED, status: 'invited' },
    ],
  } : (loopId === OTHER_LOOP ? { id: OTHER_LOOP, robot: ROBOT, members: [{ memberId: OUTSIDER, accountId: OUTSIDER, status: 'accepted' }] } : null)),
};
const media = {
  getMedia: async (accountId, paths) => paths.filter((p) => p === 'photo').map((path) => ({
    path, url: 'https://media.example/photo', type: 'image', loopId: LOOP, accountId: OWNER, reference: null, created: 1700000000000, isDeleted: false,
  })),
};

const dir = await mkdtemp(join(tmpdir(), 'a19-probe-'));
const store = new JotStore({ file: join(dir, 'jot.json') });
const events = [];
const server = await createClassicEntrypoint({
  jot: { store, account, media, onEvent: async (e) => events.push(e.payload) },
}).listen(0);
const port = server.address().port;

const post = (target, body, accessKeyId = OWNER) => fetch(`http://localhost:${port}/`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-amz-json-1.1',
    'x-amz-target': target,
    ...(accessKeyId ? { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/jot/aws4_request, SignedHeaders=host, Signature=ff` } : {}),
  },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, errType: r.headers.get('x-amzn-errortype'), body: await r.json().catch(() => null) }));

const observations = [];
/** Key-order-insensitive JSON comparison: the event payload's insertion order is base.js's, and the
 *  values are what matter. (A raw JSON.stringify comparison here is order-sensitive and misleading.) */
const stable = (value) => (Array.isArray(value)
  ? value.map(stable)
  : (value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])])) : value));
const check = (name, got, want) => {
  const ok = JSON.stringify(stable(got)) === JSON.stringify(stable(want));
  observations.push({ name, got, want, ok });
  return ok;
};

try {
  // 1. Every mapped operation, under BOTH observed prefixes.
  for (const prefix of ['Jot_20160126', 'Jot_20160512']) {
    const create = await post(`${prefix}.CreateMessage`, { loopId: LOOP, content: `${prefix} create`, parts: [{ path: 'photo' }] });
    check(`${prefix}.CreateMessage 200 + populated part url`, [create.status, create.body.parts[0].url], [200, 'https://media.example/photo']);
    const list = await post(`${prefix}.ListMessages`, { loopId: LOOP }, RECEIVER);
    check(`${prefix}.ListMessages 200`, list.status, 200);
    const read = await post(`${prefix}.MarkRead`, { ids: [create.body.id] }, RECEIVER);
    check(`${prefix}.MarkRead 200 {result}`, [read.status, read.body], [200, { result: 'Marked as read' }]);
    const loopRead = await post(`${prefix}.MarkLoopRead`, { loopId: LOOP }, RECEIVER);
    check(`${prefix}.MarkLoopRead 200 {result}`, [loopRead.status, loopRead.body], [200, { result: 'Marked all as read' }]);
    const unread = await post(`${prefix}.NumberOfUnreadMessagesInLoops`, { loopIds: [LOOP] }, RECEIVER);
    check(`${prefix}.NumberOfUnreadMessagesInLoops 200 {count}`, [unread.status, unread.body], [200, { count: 0 }]);
  }

  // 2. The direct bulk route.
  const bulk = await fetch(`http://localhost:${port}/numberOfUnreadMessagesBulk`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ accountId: RECEIVER, loopIds: [LOOP] }, { accountId: OWNER, loopIds: [LOOP] }]),
  });
  check('POST /numberOfUnreadMessagesBulk 200 array', [bulk.status, await bulk.json()], [200, [{ count: 0, accountId: RECEIVER, loopIds: [LOOP] }, { count: 0, accountId: OWNER, loopIds: [LOOP] }]]);

  // 3. Error precedence / envelopes.
  const outsiderEmpty = await post('Jot_20160512.CreateMessage', { loopId: LOOP }, OUTSIDER);
  check('non-member with no content -> 403 membership precedes 422', [outsiderEmpty.status, outsiderEmpty.errType], [403, 'JOT_MUST_BE_LOOP_MEMBER']);
  const invited = await post('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x' }, INVITED);
  check('accepted-only membership -> invited is 403', [invited.status, invited.errType], [403, 'JOT_MUST_BE_LOOP_MEMBER']);
  const empty = await post('Jot_20160512.CreateMessage', { loopId: LOOP });
  check('member with no content/parts -> 422', [empty.status, empty.errType], [422, 'JOT_CONTENT_OR_PARTS_REQUIRED']);
  const member = await post('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'x', impersonateAs: RECEIVER }, OWNER);
  check('member may not impersonate -> 403', [member.status, member.errType], [403, 'JOT_ROBOT_CAN_IMPERSONATE']);
  const robot = await post('Jot_20160512.CreateMessage', { loopId: LOOP, content: 'robot', impersonateAs: RECEIVER }, ROBOT);
  check('robot impersonation attributes the sender', [robot.status, robot.body.sender], [200, RECEIVER]);
  const unsigned = await post('Jot_20160512.ListMessages', { loopId: LOOP }, null);
  check('unsigned -> 401', [unsigned.status, unsigned.errType], [401, 'MISSING_AUTH_HEADER']);
  const unknown = await post('Jot_20160512.Frobnicate', {});
  check('unknown op -> ValidationException 400', [unknown.status, unknown.errType], [400, 'ValidationException']);
  const partyEra = await post('Jot_20160310.CreatePart', { path: 'p' });
  check('party-era op with no recovered handler -> 400 (not invented)', [partyEra.status, partyEra.errType], [400, 'ValidationException']);

  // 4. The observable event side effect (message-bus JotMessageCreated payload).
  check('JotMessageCreated payload emitted', events.at(-1), {
    eventKey: 'JotMessageCreated', messageId: robot.body.id, senderId: RECEIVER, loopId: LOOP, tags: [], content: 'robot',
  });
} finally {
  await server.close();
}

const failed = observations.filter((o) => !o.ok);
await writeFile(fileURLToPath(new URL('./live-probe.json', import.meta.url)), `${JSON.stringify({
  date: '2026-09-10',
  phoenixRevision: 'w5/a19 worktree on 194b81a',
  entrypoint: 'createClassicEntrypoint({ jot: { store, account, media, onEvent } })',
  servedOperations: ['CreateMessage', 'ListMessages', 'MarkRead', 'MarkLoopRead', 'NumberOfUnreadMessagesInLoops'],
  prefixes: ['Jot_20160126', 'Jot_20160512'],
  directRoutes: ['POST /numberOfUnreadMessagesBulk'],
  observations,
}, null, 2)}\n`, 'utf8');
await rm(dir, { recursive: true, force: true });

for (const o of observations) console.log(`${o.ok ? 'ok  ' : 'FAIL'} ${o.name}  got=${JSON.stringify(o.got)}`);
console.log(failed.length === 0
  ? `PASS: ${observations.length}/${observations.length} runtime observations held`
  : `FAIL: ${failed.length}/${observations.length} observations failed`);
process.exit(failed.length === 0 ? 0 : 1);
