// H-06 — proactive context/history selection and payloads, observed at runtime.
//
// Two layers, both against the pinned contract:
//   * the selection primitives (context operators, PART_OF_DAY/DAY_OF_WEEK boundaries, IH
//     operators) driven directly, with the expected values read off the source tables;
//   * the real /v1/proactive WebSocket path through a live gateway whose history client talks
//     to a live history service and whose settings client talks to a live account/settings
//     service — NEW_ARRIVAL + SURPRISE replay, focused person, multiple/no candidates, seeded
//     selection, memo, speaker/referent, skipSurprises and the no-action/final frames.
//
// Pinned source: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/proactive/ProactiveTransactionHandler.ts:85-163  (trigger -> speaker, selection)
//   packages/hub/src/proactive/ProactiveTransactionHandler.ts:246-279 (match/no-action frames)
//   packages/hub/src/proactive/ProactiveTransactionHandler.ts:285-304 (memo payload, history record)
//   packages/hub/src/proactive/tools/ContextTools.ts:14-221
//   packages/hub/src/proactive/tools/IHTools.ts:23-129
//   packages/hub/src/proactive/tools/IHRulesChecker.ts:34-174
//   packages/hub/src/utils/TransactionHandler.ts:113-139 (recordSkillLaunch, timings)
//   packages/hub/src/utils/TransactionHelper.ts:9-14     (speaker-only personIDs)
//   packages/interfaces/src/proactive/proactive.ts:10-13 (TriggerSource)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

import { checkContextRules, evaluateMatchRule, extractContextData, getPartOfDay, getTimezonedDate } from '../src/proactive/contextRules.js';
import { checkIHRules, evaluateIHRule, buildHistoryQuery, getTimeByOffset } from '../src/proactive/ihRules.js';
import { validateIHQuery } from '../src/skillConfigValidation.js';
import { HistoryClient } from '../src/historyClient.js';
import { createGateway } from '../src/index.js';
// Worktree-relative on purpose: `@phoenix/*` resolves through the workspace symlink to the
// MAIN checkout, which would silently execute the pre-H-06 code instead of this worktree's.
import { createHistoryService } from '../../history/src/index.js';
import { HistoryStore } from '../../history/src/store.js';
import { createAccountService } from '../../account/src/index.js';
import { Store } from '../../account/src/store.js';
import { createOwnerAccount, createLoop } from '../../account/src/model.js';

const SECRET = 'h06-runtime-secret';
const ROBOT = 'h06-robot';
const manifestPath = new URL('../resources/skills/pegasus-skills/report_skill_manifest.json', import.meta.url);
const REPORT_MANIFEST = JSON.parse(await readFile(manifestPath, 'utf8'));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ctx({ runtime = {}, requestData = {} }) {
  return { context: { data: { runtime, general: { robotID: ROBOT } } }, requestData };
}

const CTX_BASE = {
  loop: { loopId: 'loop-1', users: [{ id: 'person-1', accountId: 'acct-1' }] },
  perception: { peoplePresent: [{ id: 'person-1' }, { id: 'person-2' }], speaker: 'person-1' },
  location: { iso: '2026-06-13T10:00:00-04:00' },
  dialog: {},
};
const REQ = { triggerSource: 'SURPRISE', triggerData: { looperID: 'person-1' } };

function match(field, matchRule, value) {
  const { context, requestData } = ctx({ runtime: CTX_BASE, requestData: REQ });
  return evaluateMatchRule(matchRule, extractContextData(field, context, requestData), value);
}

// ---------------------------------------------------------------------------
// 1. context operators
// ---------------------------------------------------------------------------

test('context: EXACT/NOT are deep and key-order-insensitive; FOCUSED_PERSON tracks the trigger', () => {
  assert.equal(match('FOCUSED_PERSON', 'EXACT', 'person-1'), true);
  assert.equal(match('FOCUSED_PERSON', 'EXACT', 'person-2'), false);
  assert.equal(match('FOCUSED_PERSON', 'NOT', 'UNKNOWN'), true);
  assert.equal(match('TRIGGER_SOURCE', 'EXACT', 'SURPRISE'), true);
  assert.equal(match('NUM_PEOPLE_PRESENT', 'EXACT', 2), true);
  assert.equal(match('NUM_IDENTIFIED_PEOPLE_PRESENT', 'EXACT', 2), true);
  // lodash isEqual compares arrays BY INDEX; only object keys are order-insensitive
  assert.equal(match('PERSON_IDS', 'EXACT', ['person-1', 'person-2']), true, 'the Set order is kept');
  assert.equal(match('PERSON_IDS', 'EXACT', ['person-2', 'person-1']), false, 'array order matters for isEqual');
  // object keys however are unordered
  assert.equal(match('PART_OF_DAY', 'EXACT', { detail: 'LATE', basic: 'MORNING' }), true);
});

test('context: CONTAINS_ALL / CONTAINS_ANY / NOT_CONTAIN on arrays, objects and the empty boundary', () => {
  assert.equal(match('PERSON_IDS', 'CONTAINS_ALL', ['person-1', 'person-2']), true);
  assert.equal(match('PERSON_IDS', 'CONTAINS_ALL', ['person-1', 'ghost']), false);
  assert.equal(match('PERSON_IDS', 'CONTAINS_ALL', []), true, 'empty query array returns true');
  assert.equal(match('PERSON_IDS', 'CONTAINS_ANY', ['ghost', 'person-2']), true);
  assert.equal(match('PERSON_IDS', 'CONTAINS_ANY', []), false, 'empty query array returns false');
  assert.equal(match('PERSON_IDS', 'NOT_CONTAIN', ['ghost']), true);
  assert.equal(match('PERSON_IDS', 'NOT_CONTAIN', ['person-1']), false);
  assert.equal(match('PERSON_IDS', 'NOT_CONTAIN', []), true);
  assert.equal(match('PERSON_IDS', 'CONTAINS_ALL', { person: 'person-1' }), false, 'object rule value compares properties');
  // an object rule value whose key is an array index does match (hasEqualProperty)
  assert.equal(match('PERSON_IDS', 'CONTAINS_ALL', { 0: 'person-1' }), true);
  assert.equal(match('PERSON_IDS', 'NOT_CONTAIN', { 0: 'person-1' }), false);
  // a non-collection data value throws for the contain operators
  assert.throws(() => match('NUM_PEOPLE_PRESENT', 'CONTAINS_ANY', { 0: 2 }), /Contain rule values must be collections/);
});

test('context: string collections are iterated by CHARACTER, not matched as a substring', () => {
  // lodash `some('person-1', el => isEqual(<element>, el))` walks characters, so `['person-1']`
  // never matches the string 'person-1' — the previous `dataValue.includes(el)` substring test
  // returned true here.
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ALL', ['person-1']), false);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ANY', ['person-1']), false);
  assert.equal(match('FOCUSED_PERSON', 'NOT_CONTAIN', ['person-1']), true);
  // a single character that IS present does match
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ALL', ['p']), true);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ANY', ['p', 'q']), true);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ALL', ['p', 'q']), false);
  // a STRING rule value iterates its own characters
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ALL', 'p'), true);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINS_ALL', 'pz'), false);
  assert.equal(match('FOCUSED_PERSON', 'NOT_CONTAIN', 'pz'), false);
  assert.equal(match('FOCUSED_PERSON', 'NOT_CONTAIN', 'xyz'), true);
  // CONTAINED_IN(ruleValue, dataValue) is the same character walk
  assert.equal(match('FOCUSED_PERSON', 'CONTAINED_IN', ['person-1']), true);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINED_IN', 'person-1'), false);
  assert.equal(match('FOCUSED_PERSON', 'CONTAINED_IN', 'p'), false, 'dataValue is the whole string, elements are chars');
});

test('context: CONTAINS_* reject non-collection values and CONTAINED_IN rejects non-string/array', () => {
  assert.throws(() => match('NUM_PEOPLE_PRESENT', 'CONTAINS_ALL', 3), /Contain rule values must be collections/);
  assert.throws(() => match('NUM_PEOPLE_PRESENT', 'CONTAINS_ANY', true), /Contain rule values must be collections/);
  assert.throws(() => match('NUM_PEOPLE_PRESENT', 'NOT_CONTAIN', 3), /Contain rule values must be collections/);
  assert.throws(() => match('NUM_PEOPLE_PRESENT', 'CONTAINED_IN', 3), /ContainedIn rule values must be either arrays or strings/);
  assert.throws(() => match('FOCUSED_PERSON', 'NOPE', 1), /unrecognized matchRule: NOPE/);
  const { context, requestData } = ctx({ runtime: CTX_BASE, requestData: REQ });
  assert.throws(() => extractContextData('NOT_A_FIELD', context, requestData), /Unknown field NOT_A_FIELD/);
  // a rule-free registration is eligible in every context; a malformed one throws through checkContextRules
  assert.equal(checkContextRules({ skillID: 'x', contextRules: [] }, context, requestData), true);
  assert.throws(
    () => checkContextRules({ skillID: 'x', contextRules: [{ field: 'NUM_PEOPLE_PRESENT', matchRule: 'CONTAINS_ALL', value: 3 }] }, context, requestData),
    /Contain rule values must be collections/,
  );
});

test('context: GREATER_THAN is ruleValue < dataValue and LESS_THAN is ruleValue > dataValue', () => {
  assert.equal(match('NUM_PEOPLE_PRESENT', 'GREATER_THAN', 1), true, '1 < 2');
  assert.equal(match('NUM_PEOPLE_PRESENT', 'GREATER_THAN', 2), false);
  assert.equal(match('NUM_PEOPLE_PRESENT', 'LESS_THAN', 3), true, '3 > 2');
  assert.equal(match('NUM_PEOPLE_PRESENT', 'LESS_THAN', 1), false);
});

test('context: CONTAINED_IN checks the data value against an array of pods / a number list', () => {
  assert.equal(match('PART_OF_DAY', 'CONTAINED_IN', [{ basic: 'MORNING', detail: 'LATE' }, { basic: 'NIGHT', detail: 'MID' }]), true);
  assert.equal(match('PART_OF_DAY', 'CONTAINED_IN', [{ basic: 'MORNING', detail: 'EARLY' }]), false);
  assert.equal(match('DAY_OF_WEEK', 'CONTAINED_IN', [0, 1, 2, 3, 4, 5, 6]), true);
});

// ---------------------------------------------------------------------------
// 2. date boundaries (jibo-cai-utils PartOfDayTimes / TimeUtils.getPartOfDay)
// ---------------------------------------------------------------------------

const podOf = (iso) => getPartOfDay(getTimezonedDate(iso));
const wall = (hm, day = '2026-06-13') => `${day}T${hm}:00-04:00`;
const podStr = (iso) => { const p = podOf(iso); return `${p.basic}/${p.detail}`; };

test('part-of-day: the 13 source boundaries resolve to the source pods', () => {
  assert.equal(podStr(wall('00:00')), 'NIGHT/MID');
  assert.equal(podStr(wall('01:59')), 'NIGHT/MID');
  assert.equal(podStr(wall('02:00')), 'NIGHT/LATE');
  assert.equal(podStr(wall('04:44')), 'NIGHT/LATE');
  assert.equal(podStr(wall('04:45')), 'MORNING/EARLY'); // EARLY_MORNING_HOURS/MINUTES
  assert.equal(podStr(wall('06:44')), 'MORNING/EARLY');
  assert.equal(podStr(wall('06:45')), 'MORNING/MID');
  assert.equal(podStr(wall('09:59')), 'MORNING/MID');
  assert.equal(podStr(wall('10:00')), 'MORNING/LATE');
  assert.equal(podStr(wall('11:59')), 'MORNING/LATE');
  assert.equal(podStr(wall('12:00')), 'AFTERNOON/EARLY');
  assert.equal(podStr(wall('14:00')), 'AFTERNOON/MID');
  assert.equal(podStr(wall('16:00')), 'AFTERNOON/LATE');
  assert.equal(podStr(wall('17:30')), 'AFTERNOON/LATE'); // the old buckets said EVENING/EARLY
  assert.equal(podStr(wall('18:00')), 'EVENING/EARLY');
  assert.equal(podStr(wall('19:00')), 'EVENING/EARLY'); // the old buckets said EVENING/MID
  assert.equal(podStr(wall('20:00')), 'EVENING/MID'); // the old buckets said EVENING/LATE
  assert.equal(podStr(wall('21:00')), 'EVENING/LATE');
  assert.equal(podStr(wall('22:00')), 'NIGHT/EARLY');
  assert.equal(podStr(wall('22:14')), 'NIGHT/EARLY');
  assert.equal(podStr(wall('22:15')), 'NIGHT/MID');
  assert.equal(podStr(wall('23:30')), 'NIGHT/MID');
});

test('day-of-week: the timezone offset is carried into the wall clock day', () => {
  // 2026-06-13 is a Saturday (6); 2026-06-14 a Sunday (0).
  assert.equal(extractContextData('DAY_OF_WEEK', { data: { runtime: { ...CTX_BASE, location: { iso: '2026-06-13T10:00:00-04:00' } } } }, REQ), 6);
  assert.equal(extractContextData('DAY_OF_WEEK', { data: { runtime: { ...CTX_BASE, location: { iso: '2026-06-14T00:30:00+05:00' } } } }, REQ), 0);
  // offset is negative-going: 10:00-04:00 is 10:00 on the robot's wall clock, not 14:00 UTC
  assert.equal(getTimezonedDate('2026-06-13T10:00:00-04:00').getHours(), 10);
  assert.equal(getTimezonedDate('2026-06-13T10:00:00Z').getHours(), 10);
  assert.equal(getTimezonedDate('2026-06-13T10:00:00+02:00').getHours(), 10);
});

// ---------------------------------------------------------------------------
// 3. IH operators against the REAL history service
// ---------------------------------------------------------------------------

async function withHistory(run) {
  const store = new HistoryStore();
  const svc = createHistoryService(store);
  await svc.listen(0);
  const base = `http://127.0.0.1:${svc.server.address().port}`;
  try {
    return await run({ base, client: new HistoryClient(base) });
  } finally {
    await new Promise((r) => svc.server.close(r));
  }
}

async function recordLaunch(base, body) {
  const res = await fetch(`${base}/v1/skill/launch`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `history write failed: ${await res.text()}`);
}

const launch = (over = {}) => ({ timestamp: Date.now() - 60_000, sessionID: 'sess', robotID: ROBOT, skillID: 'ih-skill', intent: 'proactive', personIDs: ['person-1'], ...over });
const IH_CTX = { robotID: ROBOT, focusedPerson: 'person-1', wakeUpTime: null };
const ihPr = (rules) => ({ skillID: 's', IHRules: rules });

async function runIH(client, prs, ihQueries = {}) {
  return checkIHRules(prs, ihQueries, IH_CTX, client, validateIHQuery);
}

test('ih: Count EXACT / NOT / GREATER_THAN / LESS_THAN against real stored launches', async () => {
  await withHistory(async ({ base, client }) => {
    await recordLaunch(base, launch({ skillID: 'ih-skill' }));
    await recordLaunch(base, launch({ skillID: 'ih-skill' }));
    const countDef = (matchRule, value) => ({ type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }] });
    const cases = [
      ['EXACT', 2, true], ['EXACT', 1, false], ['NOT', 1, true], ['NOT', 2, false],
      ['GREATER_THAN', 1, true], ['GREATER_THAN', 2, false], ['LESS_THAN', 3, true], ['LESS_THAN', 2, false],
    ];
    for (const [matchRule, value, expected] of cases) {
      const kept = await runIH(client, [ihPr([{ query: countDef(), matchRule, value }])]);
      assert.equal(kept.length, expected ? 1 : 0, `Count ${matchRule} ${value}`);
    }
  });
});

test('ih: a missing record returns null, so Count-less-than-1 passes and EXACT 0 does not', async () => {
  await withHistory(async ({ client }) => {
    const def = { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'never-launched' }] };
    // getSkillLaunchCount returns the number 0 for an empty store
    assert.equal((await runIH(client, [ihPr([{ query: def, matchRule: 'LESS_THAN', value: 1 }])])).length, 1);
    assert.equal((await runIH(client, [ihPr([{ query: def, matchRule: 'EXACT', value: 0 }])])).length, 1);
    // LastEvent with no record is null; typeof null !== 'number' short-circuits
    const lastDef = { type: 'LastEvent', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'never-launched' }] };
    assert.equal((await runIH(client, [ihPr([{ query: lastDef, matchRule: 'EXACT', value: 0 }])])).length, 0, 'null vs 0 -> false');
    assert.equal((await runIH(client, [ihPr([{ query: lastDef, matchRule: 'NOT', value: 0 }])])).length, 1, 'null vs 0 with NOT -> true');
  });
});

test('ih: LastEvent checkProperty + TimeSince transform read the stored record', async () => {
  await withHistory(async ({ base, client }) => {
    const timestamp = Date.now() - 120_000;
    await recordLaunch(base, launch({ timestamp, intent: 'proactive', personIDs: ['person-1'] }));
    const lastDef = { type: 'LastEvent', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }] };
    const byIntent = (matchRule, value) => ihPr([{ query: lastDef, checkProperty: 'intent', matchRule, value }]);
    assert.equal((await runIH(client, [byIntent('EXACT', 'proactive')])).length, 1);
    assert.equal((await runIH(client, [byIntent('EXACT', 'weather')])).length, 0);
    assert.equal((await runIH(client, [byIntent('NOT', 'weather')])).length, 1);
    // TimeSince: the result is `Date.now() - timestamp`, compared against a positive TimePeriod
    const since = (matchRule, value) => ihPr([{ query: lastDef, transform: 'TimeSince', matchRule, value }]);
    assert.equal((await runIH(client, [since('GREATER_THAN', [1, 'min'])]).then((k) => k.length)), 1, '2 minutes ago > 1 minute');
    assert.equal((await runIH(client, [since('LESS_THAN', [1, 'min'])]).then((k) => k.length)), 0);
    assert.equal((await runIH(client, [since('GREATER_THAN', [10, 'min'])]).then((k) => k.length)), 0);
  });
});

test('ih: personID rule is built and evaluated against the real service', async () => {
  await withHistory(async ({ base, client }) => {
    await recordLaunch(base, launch({ sessionID: 's1', personIDs: ['person-1'] }));
    await recordLaunch(base, launch({ sessionID: 's2', personIDs: ['UNKNOWN'] }));
    const def = (personID) => ({ type: 'Count', personID, queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }] });
    const count = async (personID) => (await runIH(client, [ihPr([{ query: def(personID), matchRule: 'EXACT', value: 1 }])])).length;
    assert.equal(await count('ANY'), 0, 'two records, not one');
    assert.equal(await count('FOCUSED_PERSON'), 1, 'one record carries person-1');
    assert.equal(await count('UNKNOWN'), 1, 'one record carries UNKNOWN');
    assert.equal(await count('NONE'), 0);
    // the builder itself: FOCUSED_PERSON appends a CONTAINS personIDs rule
    const built = buildHistoryQuery(def('IDENTIFIED'), IH_CTX, Date.now(), validateIHQuery);
    assert.deepEqual(built.rules, [
      { field: 'skillID', match: 'EXACT', value: 'ih-skill' },
      { field: 'personIDs', match: 'NOT_CONTAIN', value: ['UNKNOWN', 'NONE'] },
    ]);
  });
});

test('ih: SinceWaking always fails (wakeUpTime is null), turning the query into the ERROR sentinel', async () => {
  await withHistory(async ({ client }) => {
    const def = { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }], startTimeOffset: 'SinceWaking' };
    // value 'ERROR' is a string; a numeric expectation short-circuits to false...
    assert.equal((await runIH(client, [ihPr([{ query: def, matchRule: 'LESS_THAN', value: 1 }])])).length, 0);
    // ...and a NOT rule short-circuits to true, because the source has no ERROR special case.
    assert.equal((await runIH(client, [ihPr([{ query: def, matchRule: 'NOT', value: 1 }])])).length, 1);
    assert.throws(() => getTimeByOffset('SinceWaking', { wakeUpTime: null }), /Robot wake up time is unknown/);
    assert.throws(() => getTimeByOffset('Tomorrow', {}), /Unknown timeOffset: Tomorrow/);
    assert.throws(() => getTimeByOffset(7, {}), /Invalid time offset: 7/);
  });
});

test('ih: an unknown named query aborts the transaction (not swallowed into ERROR)', async () => {
  await withHistory(async ({ client }) => {
    await assert.rejects(() => runIH(client, [ihPr([{ query: 'NoSuchQuery', matchRule: 'EXACT', value: 1 }])]), /Missing query definition: NoSuchQuery/);
  });
});

test('ih: an unknown transform aborts the transaction and a bad offset resolves to ERROR', async () => {
  await withHistory(async ({ base, client }) => {
    await recordLaunch(base, launch({}));
    const def = { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }] };
    // evaluateIHRule runs in the filter, OUTSIDE the checker's per-query try/catch
    // (IHRulesChecker.ts:68-83), so an unimplemented transform propagates out.
    await assert.rejects(
      () => runIH(client, [ihPr([{ query: def, transform: 'WhenEver', matchRule: 'EXACT', value: 1 }])]),
      /Unknown transform method WhenEver/,
    );
    // the plain rule does see the single stored launch
    assert.equal((await runIH(client, [ihPr([{ query: def, matchRule: 'EXACT', value: 1 }])])).length, 1);
    // direct: evaluateIHRule throws on an unimplemented matchRule (evaluate, not the checker)
    assert.throws(() => evaluateIHRule({ query: def, matchRule: 'LIKE', value: 1 }, 1), /Unknown matchRule in IHRule: LIKE/);
    // a positive startTimeOffset fails the definition's negative-period rule -> ERROR sentinel
    const positiveOffset = { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-skill' }], startTimeOffset: [7, 'hours'] };
    assert.equal((await runIH(client, [ihPr([{ query: positiveOffset, matchRule: 'NOT', value: 1 }])])).length, 1);
    assert.equal((await runIH(client, [ihPr([{ query: positiveOffset, matchRule: 'LESS_THAN', value: 1 }])])).length, 0);
  });
});

// ---------------------------------------------------------------------------
// 4. runtime: live gateway + live history/settings + real /v1/proactive socket
// ---------------------------------------------------------------------------

function skillEntry({ id, url = '', onRobot = false, proactives = [], IHQueries }) {
  return { id, URL: url, onRobot, intents: [], proactives, ...(IHQueries ? { IHQueries } : {}) };
}
const alwaysPr = (memo) => ({ memo, topics: [], contextRules: [] });
const reg = (over = {}) => ({ topics: [], contextRules: [], ...over });

function stubSkill() {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      calls.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'SKILL_RESPONSE', msgID: 'sr1', ts: 1, data: { skill: { session: { id: 'sess-h06' } } } }));
    });
  });
  return { calls, server };
}

async function withRuntime({ skills, historyURL, settingsURL }, run) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-h06-'));
  const store = new Store(join(dir, 'store.json'));
  const owner = createOwnerAccount(store, { email: 'h06-owner@jetson.test', password: 'h06-pass' });
  const { loop } = createLoop(store, { owner, robotId: ROBOT });
  const account = await createAccountService({ store }).listen(0);
  const settings = settingsURL === undefined ? `http://127.0.0.1:${account.address().port}` : settingsURL;

  const gateway = await createGateway({
    hubTokenSecret: SECRET, disableAuth: false, accountUrl: '',
    parserURL: 'http://127.0.0.1:9', historyURL, settingsURL: settings, recordLaunchHistory: true,
    skills,
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;

  const amz = (op, body) => fetch(`http://127.0.0.1:${account.address().port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json;charset=utf-8', 'x-amz-target': `Settings_20160801.${op}`, 'x-amz-credentials': JSON.stringify({ id: owner._id }) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));

  try {
    return await run({ owner, loop, port, amz });
  } finally {
    for (const socket of gateway.wss.clients) socket.terminate();
    await new Promise((r) => gateway.wss.close(r));
    await new Promise((r) => gateway.service.server.close(r));
    await new Promise((r) => account.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

function token(ownerId) { return jwt.sign({ id: ownerId, friendlyId: ROBOT }, SECRET); }

/** Open a proactive socket, send every frame, collect responses until one is final. */
function driveProactive(port, frames, ownerId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/proactive`, { headers: { Authorization: `Bearer ${token(ownerId)}`, 'x-jibo-transid': 'h06-trans' } });
    const messages = [];
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close(); } catch {} resolve(messages); };
    const timer = setTimeout(finish, 5000);
    ws.on('open', () => frames.forEach((frame) => ws.send(JSON.stringify(frame))));
    ws.on('message', (data) => { const m = JSON.parse(data.toString()); messages.push(m); if (m.final) { clearTimeout(timer); setTimeout(finish, 10); } });
    ws.on('error', reject);
  });
}

function framesFor(ownerId, { triggerSource = 'SURPRISE', looperID = 'person-1', speaker = 'person-1', loopId = 'loop-1', iso = '2026-06-13T10:00:00-04:00' } = {}) {
  return [
    { type: 'CONTEXT', msgID: 'c1', ts: Date.now(), data: {
      general: { accountID: ownerId, robotID: ROBOT, lang: 'en-US', release: '2.0.1' },
      runtime: {
        loop: { loopId, users: [{ id: 'person-1', accountId: ownerId, firstName: 'Ada' }] },
        perception: { peoplePresent: [{ id: 'person-1' }], speaker },
        location: { iso }, dialog: {},
      },
      skill: { id: null },
    } },
    { type: 'TRIGGER', msgID: 't1', ts: Date.now(), data: { triggerSource, triggerData: looperID ? { looperID } : {} } },
  ];
}

const proactiveFrames = (messages) => messages.filter((m) => m.type === 'PROACTIVE');
const matchedSkill = (messages) => { const f = proactiveFrames(messages).find((m) => m.data && m.data.match); return f && f.data.match.skillID; };

/** Run the callback with Math.random pinned to `value` (the same-process gateway shares it). */
async function withRandom(value, run) {
  const real = Math.random;
  Math.random = () => value;
  try { return await run(); } finally { Math.random = real; }
}

test('runtime: a live history service backs the IH gate (count < 1 passes, count >= 1 suppresses)', async () => {
  const store = new HistoryStore();
  const history = createHistoryService(store);
  await history.listen(0);
  const historyURL = `http://127.0.0.1:${history.server.address().port}`;
  const skills = [skillEntry({
    id: 'ih-gate', onRobot: true,
    proactives: [reg({ IHRules: [{ query: 'LaunchCount', matchRule: 'LESS_THAN', value: 1 }] })],
    IHQueries: { LaunchCount: { type: 'Count', queryRules: [{ field: 'skillID', match: 'EXACT', value: 'ih-gate' }], startTimeOffset: [-7, 'hours'], endTimeOffset: [0, 'hours'] } },
  })];
  try {
    await withRuntime({ skills, historyURL }, async ({ owner, port }) => {
      const first = await driveProactive(port, framesFor(owner._id), owner._id);
      assert.equal(matchedSkill(first), 'ih-gate', 'no launch recorded yet, count 0 < 1');

      // record one launch for this robot through the real history service, then replay
      await recordLaunch(historyURL, { timestamp: Date.now(), sessionID: 's9', robotID: ROBOT, skillID: 'ih-gate', intent: 'proactive', personIDs: ['person-1'] });
      const second = await driveProactive(port, framesFor(owner._id), owner._id);
      assert.equal(matchedSkill(second), undefined, 'count 1 is not < 1');
      assert.deepEqual(second[0].data, {}, 'the no-action frame carries empty data');
      assert.equal(second[0].final, true);
    });
  } finally { await new Promise((r) => history.server.close(r)); }
});

test('runtime: seeded selection picks the configured index across multiple candidates', async () => {
  const skills = ['sel-a', 'sel-b', 'sel-c'].map((id) => skillEntry({ id, onRobot: true, proactives: [alwaysPr(`memo-${id}`)] }));
  await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
    await withRandom(0, async () => {
      const m = await driveProactive(port, framesFor(owner._id), owner._id);
      assert.equal(matchedSkill(m), 'sel-a');
      assert.equal(proactiveFrames(m)[0].data.match.isProactive, true);
      assert.equal(proactiveFrames(m)[0].data.match.onRobot, true);
      assert.equal(proactiveFrames(m)[0].final, true, 'an onRobot match is the final frame');
    });
    await withRandom(0.5, async () => {
      assert.equal(matchedSkill(await driveProactive(port, framesFor(owner._id), owner._id)), 'sel-b');
    });
    await withRandom(0.999999, async () => {
      assert.equal(matchedSkill(await driveProactive(port, framesFor(owner._id), owner._id)), 'sel-c');
    });
  });
});

test('runtime: no eligible candidate yields the single no-action final frame', async () => {
  const skills = [skillEntry({
    id: 'nope', onRobot: true,
    proactives: [reg({ contextRules: [{ field: 'FOCUSED_PERSON', matchRule: 'EXACT', value: 'nobody' }] })],
  })];
  await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
    const m = await driveProactive(port, framesFor(owner._id), owner._id);
    assert.deepEqual(m.map((x) => x.type), ['PROACTIVE']);
    assert.deepEqual(m[0].data, {});
    assert.equal(m[0].final, true);
  });
});

test('runtime: SURPRISE sets skipSurprises, NEW_ARRIVAL clears it (same registration)', async () => {
  const skill = stubSkill();
  await new Promise((r) => skill.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${skill.server.address().port}`;
  const skills = [skillEntry({ id: 'launcher', url, proactives: [alwaysPr('The Memo')] })];
  try {
    await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
      const surprise = await driveProactive(port, framesFor(owner._id, { triggerSource: 'SURPRISE' }), owner._id);
      assert.equal(proactiveFrames(surprise)[0].data.match.skipSurprises, true);
      assert.equal(proactiveFrames(surprise)[0].final, false, 'a cloud match is not final');

      const arrival = await driveProactive(port, framesFor(owner._id, { triggerSource: 'NEW_ARRIVAL' }), owner._id);
      assert.equal(proactiveFrames(arrival)[0].data.match.skipSurprises, false);
      assert.equal(matchedSkill(arrival), 'launcher');

      // the skill received the memo, the speaker-overwritten context and nothing else
      assert.equal(skill.calls.length, 2);
      const body = skill.calls[0].data;
      assert.equal(skill.calls[0].type, 'PROACTIVE_LAUNCH');
      assert.equal(body.skill.id, 'launcher');
      assert.equal(body.result.memo, 'The Memo');
      assert.equal(body.result.nlu, undefined);
      assert.equal(body.runtime.perception.speaker, 'person-1', 'the trigger looperID becomes the speaker (referent)');
      assert.equal(body.general.robotID, ROBOT);
    });
  } finally { await new Promise((r) => skill.server.close(r)); }
});

test('runtime: the trigger looperID overrides a stale speaker for both focused person and payload', async () => {
  const skill = stubSkill();
  await new Promise((r) => skill.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${skill.server.address().port}`;
  const skills = [skillEntry({ id: 'focus', url, proactives: [reg({ contextRules: [{ field: 'FOCUSED_PERSON', matchRule: 'EXACT', value: 'person-1' }] })] })];
  try {
    await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
      // context speaker is UNKNOWN, the trigger identifies person-1 -> eligible, and the
      // launched context carries person-1 as the speaker.
      const m = await driveProactive(port, framesFor(owner._id, { looperID: 'person-1', speaker: 'UNKNOWN' }), owner._id);
      assert.equal(matchedSkill(m), 'focus');
      assert.equal(skill.calls[0].data.runtime.perception.speaker, 'person-1');
      assert.equal(skill.calls[0].data.runtime.perception.peoplePresent[0].id, 'person-1');

      // a trigger without a looperID and an UNKNOWN speaker stays UNKNOWN -> FOCUSED_PERSON fails
      const none = await driveProactive(port, framesFor(owner._id, { looperID: null, speaker: 'UNKNOWN' }), owner._id);
      assert.equal(matchedSkill(none), undefined);
    });
  } finally { await new Promise((r) => skill.server.close(r)); }
});

test('runtime: the final skill frame is final with total+skill timings', async () => {
  const skill = stubSkill();
  await new Promise((r) => skill.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${skill.server.address().port}`;
  const skills = [skillEntry({ id: 'timed', url, proactives: [alwaysPr('m')] })];
  try {
    await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
      const m = await driveProactive(port, framesFor(owner._id), owner._id);
      assert.equal(m.length, 2);
      assert.equal(m[0].type, 'PROACTIVE');
      assert.equal(m[1].type, 'SKILL_RESPONSE');
      assert.equal(m[1].final, true);
      assert.equal(typeof m[1].timings.total, 'number');
      assert.equal(typeof m[1].timings.skill, 'number', 'TransactionHandler.emitSkillResult reports timings.skill');
      assert.deepEqual(m[1].data, { skill: { session: { id: 'sess-h06' } } });
    });
  } finally { await new Promise((r) => skill.server.close(r)); }
});

test('runtime: the launch history record carries the speaker only, through the real history service', async () => {
  const store = new HistoryStore();
  const history = createHistoryService(store);
  await history.listen(0);
  const historyURL = `http://127.0.0.1:${history.server.address().port}`;
  const skill = stubSkill();
  await new Promise((r) => skill.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${skill.server.address().port}`;
  // peoplePresent has two people; only the speaker must be recorded (TransactionHelper.getPersonIDs)
  const skills = [skillEntry({ id: 'rec', url, proactives: [alwaysPr('m')] })];
  try {
    await withRuntime({ skills, historyURL }, async ({ owner, port }) => {
      const frames = framesFor(owner._id);
      frames[0].data.runtime.perception.peoplePresent = [{ id: 'person-1' }, { id: 'person-2' }];
      await driveProactive(port, frames, owner._id);
      const latest = await fetch(`${historyURL}/v1/skill/launch/latest`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ robotID: ROBOT, skillID: 'rec' }),
      }).then((r) => r.json());
      assert.equal(latest.skillID, 'rec');
      assert.equal(latest.intent, 'proactive');
      assert.equal(latest.sessionID, 'sess-h06');
      assert.deepEqual(latest.personIDs, ['person-1'], 'the speaker only, never peoplePresent');
    });
  } finally {
    await new Promise((r) => skill.server.close(r));
    await new Promise((r) => history.server.close(r));
  }
});

test('runtime: the full filter pipeline (context + IH + settings) over live services, on the real report manifest', async () => {
  const store = new HistoryStore();
  const history = createHistoryService(store);
  await history.listen(0);
  const historyURL = `http://127.0.0.1:${history.server.address().port}`;
  const skill = stubSkill();
  await new Promise((r) => skill.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${skill.server.address().port}`;
  const skills = [{ ...REPORT_MANIFEST, URL: url }];
  try {
    await withRuntime({ skills, historyURL }, async ({ owner, loop, port, amz }) => {
      // context: SURPRISE + PART_OF_DAY MORNING/LATE + DAY_OF_WEEK Saturday + focused person
      // IH:      count(report-skill in the last 7h) < 1
      // settings: offerProactively EXACT {value:true}
      const frames = (over = {}) => framesFor(owner._id, { loopId: loop._id, ...over });
      assert.equal((await amz('UpdateSettings', { data: { offerProactively: { value: true } } })).status, 200);
      const allowed = await driveProactive(port, frames({ iso: '2026-06-13T10:00:00-04:00' }), owner._id);
      assert.equal(matchedSkill(allowed), 'report-skill');
      assert.equal(skill.calls.length, 1);

      // context still passes, IH still passes, but the preference is off -> suppressed
      assert.equal((await amz('UpdateSettings', { data: { offerProactively: { value: false } } })).status, 200);
      const denied = await driveProactive(port, frames({ iso: '2026-06-13T10:00:00-04:00' }), owner._id);
      assert.equal(matchedSkill(denied), undefined);
      assert.deepEqual(denied[0].data, {});

      // NEW_ARRIVAL fails the registration's TRIGGER_SOURCE EXACT SURPRISE rule
      assert.equal((await amz('UpdateSettings', { data: { offerProactively: { value: true } } })).status, 200);
      const arrival = await driveProactive(port, frames({ triggerSource: 'NEW_ARRIVAL' }), owner._id);
      assert.equal(matchedSkill(arrival), undefined, 'TRIGGER_SOURCE EXACT SURPRISE rejects NEW_ARRIVAL');

      // a NIGHT context fails the PART_OF_DAY CONTAINED_IN MORNING list (DAY_OF_WEEK still passes)
      const night = await driveProactive(port, frames({ iso: '2026-06-13T02:00:00-04:00' }), owner._id);
      assert.equal(matchedSkill(night), undefined, 'PART_OF_DAY NIGHT/LATE is not in the MORNING list');
    });
  } finally {
    await new Promise((r) => skill.server.close(r));
    await new Promise((r) => history.server.close(r));
  }
});

test('runtime: a malformed context rule fails the whole transaction with an ERROR frame', async () => {
  const skills = [skillEntry({
    id: 'bad-rule', onRobot: true,
    proactives: [reg({ contextRules: [{ field: 'NUM_PEOPLE_PRESENT', matchRule: 'CONTAINS_ALL', value: 3 }] })],
  })];
  await withRuntime({ skills, historyURL: 'http://127.0.0.1:9' }, async ({ owner, port }) => {
    const m = await driveProactive(port, framesFor(owner._id), owner._id);
    assert.deepEqual(m.map((x) => x.type), ['ERROR']);
    assert.equal(m[0].final, true);
    assert.match(m[0].data.message, /Contain rule values must be collections/);
  });
});
