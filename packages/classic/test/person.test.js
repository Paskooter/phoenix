// Person_20160801 — the classic service behind the app's personalized questions ("This or That?"),
// per-account / per-loop properties, and loop holidays + birthdays.
//
// Every expectation is pinned to the archive, not invented:
//   apis/person-2016-08-01.normal.json            jiborobot/srv-jibo-server-client
//   jiborobot/srv-person-ws@fc06373f
//     src/handlers/person.handler.js, property.handler.js   per-op Joi + credentials.id
//     src/controllers/person.ctrl.js, property.ctrl.js      list/answer/holidays/properties
//     src/errors/person.js                                  the exact error catalogue
//     src/schemes/{answer,holiday,accountProperty,loopProperty}.js
//     config/config.json                                    the questions + 53 holidays (catalog)
//
// The regression this file exists to prevent: the tier-3 stub answered List with `[]` forever,
// Answer with a placeholder that stored nothing, and holidays with a bare "Command accepted" that
// never touched a store — nothing survived a restart and no error code was ever produced.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClassicEntrypoint } from '../src/index.js';
import { PersonStore } from '../src/person.js';
import { PERSON_QUESTIONS, HOLIDAYS } from '../src/personCatalog.js';

const LOOP = '5a0b20f5ddee0000197e2881';
const OTHER_LOOP = '59e66fc3762588001e64c296';
const OWNER = '43ca532ad4090cfb80f2e7a5';
const ROBOT = '43ca532ad4090cfb80f2e7a6';
const OUTSIDER = 'deadbeefdeadbeefdeadbeef';

// The source AccountClient seam: isLoopMember / isAccountOwnerOrRobot / listBirthdays. Injected
// the way the deployed launcher injects it (colocated account store). Omitting it exercises the
// documented LAN-trust skip instead.
const account = {
  isLoopMember: async ({ loopId, accountId }) => loopId === LOOP && accountId === OWNER,
  isAccountOwnerOrRobot: async ({ loopId, accountId }) => loopId === LOOP && (accountId === OWNER || accountId === ROBOT),
  listBirthdays: async (loopId) => (loopId === LOOP ? [{ memberId: 'm1', date: '2018-06-01' }] : []),
};

function amz(target, body, accessKeyId = OWNER, extraHeaders = {}) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target, ...extraHeaders };
  if (accessKeyId) headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20180910/us-east-1/person/aws4_request, SignedHeaders=host, Signature=ff`;
  return fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
}

async function call(target, body, accessKeyId = OWNER) {
  const res = await amz(target, body, accessKeyId);
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

let server; let port; let dir;
const NOV_2018 = Date.UTC(2018, 8, 10, 12, 0, 0); // source uses new Date() for the holiday year

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'phoenix-person-'));
  server = await createClassicEntrypoint({
    person: { store: new PersonStore({ file: join(dir, 'person.json') }), account, now: () => NOV_2018 },
  }).listen(0);
  port = server.address().port;
});
after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }); });

// --- questions / answers ------------------------------------------------------------------------

test('person list returns the pinned "app" questions until they are answered', async () => {
  const listed = await call('Person_20160801.List', { category: 'app' });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.map((q) => q.key), ['APP_CAKE_PREFERENCE', 'APP_PLACE_TO_LIVE']);
  // Shape check against the pinned catalog (questions carry options with keys + image urls).
  assert.equal(listed.body[0].question, 'This or That?');
  assert.deepEqual(listed.body[0].options.map((o) => o.key), ['PINEAPPLE', 'RASPBERRY']);
});

test('person list for an unknown category is CATEGORY_NOT_FOUND 404', async () => {
  const r = await call('Person_20160801.List', { category: 'nope' });
  assert.equal(r.status, 404);
  assert.equal(r.errType, 'CATEGORY_NOT_FOUND');
});

test('person answer stores an option, drops it from list, and refuses a second answer', async () => {
  const answered = await call('Person_20160801.Answer', { key: 'APP_CAKE_PREFERENCE', answer: 'PINEAPPLE' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.key, 'APP_CAKE_PREFERENCE');
  assert.equal(answered.body.answer, 'PINEAPPLE');

  const remaining = await call('Person_20160801.List', { category: 'app' });
  assert.deepEqual(remaining.body.map((q) => q.key), ['APP_PLACE_TO_LIVE']);

  const again = await call('Person_20160801.Answer', { key: 'APP_CAKE_PREFERENCE', answer: 'RASPBERRY' });
  assert.equal(again.status, 409);
  assert.equal(again.errType, 'ALREADY_ANSWERED');
});

test('person answer validates the option (422) and the question (404)', async () => {
  const wrong = await call('Person_20160801.Answer', { key: 'APP_PLACE_TO_LIVE', answer: 'NOT_AN_OPTION' });
  assert.equal(wrong.status, 422);
  assert.equal(wrong.errType, 'ANSWER_OPTION_WRONG');

  const missing = await call('Person_20160801.Answer', { key: 'NO_SUCH_QUESTION', answer: 'x' });
  assert.equal(missing.status, 404);
  assert.equal(missing.errType, 'QUESTION_NOT_FOUND');
});

// --- properties ---------------------------------------------------------------------------------

test('person account properties round-trip and list only the caller keys', async () => {
  const set = await call('Person_20160801.SetAccountProperty', { key: 'favColor', value: { color: 'blue' } });
  assert.equal(set.status, 200);
  await call('Person_20160801.SetAccountProperty', { key: 'favFood', value: { food: 'cake' } });

  const got = await call('Person_20160801.GetAccountProperties', { keys: ['favColor'] });
  assert.deepEqual(got.body, { favColor: { color: 'blue' } });

  const keys = await call('Person_20160801.ListAccountPropertyKeys', {});
  assert.equal(keys.status, 200);
  assert.deepEqual(keys.body.keys.sort(), ['favColor', 'favFood']);
});

test('person loop properties are gated on loop membership (LOOP_MEMBER_ONLY 403)', async () => {
  const outsider = await call('Person_20160801.GetLoopProperties', { loopId: LOOP, keys: ['x'] }, OUTSIDER);
  assert.equal(outsider.status, 403);
  assert.equal(outsider.errType, 'LOOP_MEMBER_ONLY');

  const set = await call('Person_20160801.SetLoopProperty', { loopId: LOOP, key: 'lights', value: { on: true } });
  assert.equal(set.status, 200);
  const got = await call('Person_20160801.GetLoopProperties', { loopId: LOOP, keys: ['lights'] });
  assert.deepEqual(got.body, { lights: { on: true } });

  // A member of one loop may not read another loop's properties.
  const wrongLoop = await call('Person_20160801.GetLoopProperties', { loopId: OTHER_LOOP, keys: ['lights'] }, OWNER);
  assert.equal(wrongLoop.status, 403);
  assert.equal(wrongLoop.errType, 'LOOP_MEMBER_ONLY');
});

test('person account properties never leak across accounts', async () => {
  const other = await call('Person_20160801.GetAccountProperties', { keys: ['favColor'] }, ROBOT);
  assert.deepEqual(other.body, {});
  const keys = await call('Person_20160801.ListAccountPropertyKeys', {}, ROBOT);
  assert.deepEqual(keys.body.keys, []);
});

// --- holidays -----------------------------------------------------------------------------------

test('person listHolidays materializes the pinned holiday table + birthdays and hashes eventId', async () => {
  const r = await call('Person_20160801.ListHolidays', { loopId: LOOP });
  assert.equal(r.status, 200);
  const halloween = r.body.filter((h) => h.name === 'Halloween');
  // The pinned config lists Halloween for 2018 and 2019; the handler syncs one stored record and
  // projects it onto every matching configured date (source listHolidays loop).
  assert.deepEqual(halloween.map((h) => h.date).sort(), ['2018-10-31', '2019-10-31']);
  assert.equal(halloween[0].category, 'public');
  assert.equal(halloween[0].isEnabled, false);
  assert.equal(halloween[0].loopId, LOOP);
  assert.equal(halloween[0].endDate, halloween[0].date);
  const expected = createHash('sha256').update('Halloween2018-10-31').digest('hex');
  assert.equal(halloween.find((h) => h.date === '2018-10-31').eventId, expected);

  const birthday = r.body.find((h) => h.category === 'birthday');
  assert.deepEqual({ memberId: birthday.memberId, date: birthday.date }, { memberId: 'm1', date: '2018-06-01' });
  assert.equal(birthday.isEnabled, true); // first-ever birthdays default to enabled
  assert.ok(r.body.every((h) => typeof h.id === 'string' && h.id.length > 0));
});

test('person enable/disableHolidays flips isEnabled on the stored record', async () => {
  const before = await call('Person_20160801.ListHolidays', { loopId: LOOP });
  const target = before.body.find((h) => h.name === 'Halloween');
  const enabled = await call('Person_20160801.EnableHolidays', { ids: [target.id], loopId: LOOP });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.result, 'Command accepted');
  const afterEnable = await call('Person_20160801.ListHolidays', { loopId: LOOP });
  assert.ok(afterEnable.body.filter((h) => h.name === 'Halloween').every((h) => h.isEnabled === true));

  await call('Person_20160801.DisableHolidays', { ids: [target.id], loopId: LOOP });
  const afterDisable = await call('Person_20160801.ListHolidays', { loopId: LOOP });
  assert.ok(afterDisable.body.filter((h) => h.name === 'Halloween').every((h) => h.isEnabled === false));
});

test('person holidays are owner-or-robot only and null over account-service failure', async () => {
  const outsider = await call('Person_20160801.ListHolidays', { loopId: LOOP }, OUTSIDER);
  assert.equal(outsider.status, 403);
  assert.equal(outsider.errType, 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');

  const robot = await call('Person_20160801.ListHolidays', { loopId: LOOP }, ROBOT);
  assert.equal(robot.status, 200);

  const bad = await call('Person_20160801.EnableHolidays', { ids: ['x'], loopId: OTHER_LOOP }, OWNER);
  assert.equal(bad.status, 403);
  assert.equal(bad.errType, 'HOLIDAY_MUST_BE_OWNER_OR_ROBOT');
});

test('person holiday table outside the pinned years yields no named holidays', async () => {
  // config/config.json only lists dates 2016..2020; a live `now` has no configured named holiday.
  const store = new PersonStore({ file: join(dir, 'frozen.json') });
  const live = await createClassicEntrypoint({ person: { store } }).listen(0);
  const livePort = live.address().port;
  try {
    const res = await fetch(`http://localhost:${livePort}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Person_20160801.ListHolidays',
        authorization: `AWS4-HMAC-SHA256 Credential=${OWNER}/20260910/us-east-1/person/aws4_request, SignedHeaders=host, Signature=ff`,
      },
      body: JSON.stringify({ loopId: LOOP }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, []);
  } finally {
    await live.close();
  }
});

// --- auth / validation / durability -------------------------------------------------------------

test('person requires a signed request (MISSING_AUTH_HEADER 401) and validates payloads', async () => {
  const unsigned = await call('Person_20160801.ListAccountPropertyKeys', {}, null);
  assert.equal(unsigned.status, 401);
  assert.equal(unsigned.errType, 'MISSING_AUTH_HEADER');

  const badCategory = await call('Person_20160801.List', {});
  assert.equal(badCategory.status, 400);
  assert.equal(badCategory.errType, 'ValidationException');

  const badValue = await call('Person_20160801.SetAccountProperty', { key: 'k', value: 'not-an-object' });
  assert.equal(badValue.status, 400);
  assert.equal(badValue.errType, 'ValidationException');

  const badKeys = await call('Person_20160801.GetAccountProperties', { keys: [] });
  assert.equal(badKeys.status, 400);
  assert.equal(badKeys.errType, 'ValidationException');

  const unknown = await call('Person_20160801.Frobnicate', {});
  assert.equal(unknown.status, 400);
  assert.equal(unknown.errType, 'ValidationException');
});

test('person state survives a real restart (new entrypoint, same store file)', async () => {
  const file = join(dir, 'durable.json');
  const first = await createClassicEntrypoint({
    person: { store: new PersonStore({ file }), account, now: () => NOV_2018 },
  }).listen(0);
  const firstPort = first.address().port;
  const post = (port, target, body) => fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${OWNER}/20180910/us-east-1/person/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body),
  });
  await post(firstPort, 'Person_20160801.SetAccountProperty', { key: 'persisted', value: { n: 7 } });
  await post(firstPort, 'Person_20160801.Answer', { key: 'APP_CAKE_PREFERENCE', answer: 'RASPBERRY' });
  const holidays = await (await post(firstPort, 'Person_20160801.ListHolidays', { loopId: LOOP })).json();
  const halloween = holidays.find((h) => h.name === 'Halloween');
  await post(firstPort, 'Person_20160801.EnableHolidays', { ids: [halloween.id], loopId: LOOP });
  await first.close();

  // Restart: a brand-new entrypoint + a brand-new store object over the same file.
  const second = await createClassicEntrypoint({
    person: { store: new PersonStore({ file }), account, now: () => NOV_2018 },
  }).listen(0);
  const secondPort = second.address().port;
  try {
    const props = await (await post(secondPort, 'Person_20160801.GetAccountProperties', { keys: ['persisted'] })).json();
    assert.deepEqual(props, { persisted: { n: 7 } });
    const list = await (await post(secondPort, 'Person_20160801.List', { category: 'app' })).json();
    assert.deepEqual(list.map((q) => q.key), ['APP_PLACE_TO_LIVE']);
    const reopened = await (await post(secondPort, 'Person_20160801.ListHolidays', { loopId: LOOP })).json();
    assert.ok(reopened.filter((h) => h.name === 'Halloween').every((h) => h.isEnabled === true));
    assert.ok(reopened.find((h) => h.name === 'Halloween').id === halloween.id);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(Array.isArray(raw.holidays) && raw.holidays.length > 0);
  } finally {
    await second.close();
  }
});

test('person catalog is the pinned config (2 questions, 53 holidays)', () => {
  assert.deepEqual(Object.keys(PERSON_QUESTIONS), ['app']);
  assert.equal(PERSON_QUESTIONS.app.length, 2);
  assert.equal(Object.keys(HOLIDAYS).length, 53);
  assert.equal(HOLIDAYS['Halloween'].category, 'public');
});
