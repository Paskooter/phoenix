import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore, SKILL_LAUNCH_RETENTION_MS } from '../src/store.js';
import { MatchMethod, RuleField } from '../src/query.js';

const ROBOT = 'robot-1';
function launch(store, over = {}) {
  return store.addSkillLaunch({ robotID: ROBOT, sessionID: 's', skillID: 'answer-skill', intent: 'who', personIDs: ['p1'], ...over });
}

test('write returns an id and getLatest finds it', () => {
  const s = new HistoryStore();
  const rec = launch(s, { intent: 'weather' });
  assert.ok(rec.id);
  const latest = s.getLatest({ robotID: ROBOT, skillID: 'answer-skill' });
  assert.equal(latest.intent, 'weather');
});

test('no match returns null (not an error)', () => {
  const s = new HistoryStore();
  launch(s);
  assert.equal(s.getLatest({ robotID: ROBOT, skillID: 'nonexistent' }), null);
});

test('getLatest breaks timestamp ties by insertion order (newest wins)', () => {
  const s = new HistoryStore();
  const ts = Date.now();
  launch(s, { intent: 'first', timestamp: ts });
  launch(s, { intent: 'second', timestamp: ts });
  assert.equal(s.getLatest({ robotID: ROBOT }).intent, 'second');
});

test('robotID is required', () => {
  const s = new HistoryStore();
  assert.throws(() => s.getLatest({ skillID: 'x' }), /Robot ID is required/);
});

test('count + personID ($in personIDs) + intent filtering', () => {
  const s = new HistoryStore();
  launch(s, { intent: 'who', personIDs: ['p1'] });
  launch(s, { intent: 'who', personIDs: ['p2'] });
  launch(s, { intent: 'what', personIDs: ['p1'] });
  assert.equal(s.getCount({ robotID: ROBOT, intent: 'who' }), 2);
  assert.equal(s.getCount({ robotID: ROBOT, personID: 'p1' }), 2);
  assert.equal(s.getCount({ robotID: ROBOT, intent: 'who', personID: 'p2' }), 1);
});

test('payload EXACT requires all keys AND exact key count (payloadSize)', () => {
  const s = new HistoryStore();
  launch(s, { sessionID: 'a' });
  // Pegasus only attaches payloadSize on the payload-update path (PUT /skill/launch/payload),
  // not on the launch write — so a launch record carries no payloadSize key.
  assert.equal('payloadSize' in s.getLatest({ robotID: ROBOT, sessionID: 'a' }), false);
  s.saveSkillPayload({ robotID: ROBOT, sessionID: 'a', skillID: 'answer-skill', payload: { a: 1, b: 2 } });
  const exactMatch = { robotID: ROBOT, rules: [{ field: RuleField.PAYLOAD, match: MatchMethod.EXACT, value: { a: 1, b: 2 } }] };
  const subset = { robotID: ROBOT, rules: [{ field: RuleField.PAYLOAD, match: MatchMethod.EXACT, value: { a: 1 } }] };
  assert.equal(s.getCount(exactMatch), 1);
  assert.equal(s.getCount(subset), 0, 'subset must NOT match EXACT (key-count differs)');
});

test('payload CONTAINS_ALL matches a subset; NOT_CONTAIN excludes', () => {
  const s = new HistoryStore();
  launch(s, { payload: { a: 1, b: 2, c: 3 } });
  assert.equal(s.getCount({ robotID: ROBOT, rules: [{ field: RuleField.PAYLOAD, match: MatchMethod.CONTAINS_ALL, value: { a: 1, b: 2 } }] }), 1);
  assert.equal(s.getCount({ robotID: ROBOT, rules: [{ field: RuleField.PAYLOAD, match: MatchMethod.NOT_CONTAIN, value: { a: 9 } }] }), 1);
});

test('field rule NOT + time window', () => {
  const s = new HistoryStore();
  const base = Date.now();
  launch(s, { intent: 'who', timestamp: base - 1000 });
  launch(s, { intent: 'what', timestamp: base });
  assert.equal(s.getCount({ robotID: ROBOT, rules: [{ field: 'intent', match: MatchMethod.NOT, value: 'who' }] }), 1);
  assert.equal(s.getCount({ robotID: ROBOT, startTime: base - 500 }), 1);
});

test('notSessionID excludes the in-progress session', () => {
  const s = new HistoryStore();
  launch(s, { sessionID: 'cur' });
  launch(s, { sessionID: 'old' });
  const latest = s.getLatest({ robotID: ROBOT, notSessionID: 'cur' });
  assert.equal(latest.sessionID, 'old');
});

test('saveSkillPayload attaches payload to the matching launch', () => {
  const s = new HistoryStore();
  launch(s, { sessionID: 'sess-9' });
  const updated = s.saveSkillPayload({ robotID: ROBOT, sessionID: 'sess-9', skillID: 'answer-skill', payload: { x: 1 } });
  assert.equal(updated.payloadSize, 1);
  assert.equal(s.getCount({ robotID: ROBOT, rules: [{ field: RuleField.PAYLOAD, match: MatchMethod.EXACT, value: { x: 1 } }] }), 1);
});

test('speech updates are partial (non-erasing)', () => {
  const s = new HistoryStore();
  const id = s.addSpeech({ robotID: ROBOT, transID: 't1', asr: { text: 'hi' } });
  s.updateSpeech(id, { nlu: { intent: 'greet' } });
  const rec = s.speech.get(id);
  assert.equal(rec.asr.text, 'hi', 'existing field preserved');
  assert.equal(rec.nlu.intent, 'greet', 'new field added');
});

// ---------------------------------------------------------------------------
// I-03 retention — expiry is per-record (Mongo TTL semantics), not order-based
// ---------------------------------------------------------------------------
// The reference rule is a Mongo TTL index: SkillLaunchSchema.ts sets
// `expires: config.skillLaunch.eventExpirationSeconds` on `timestamp`, and
// HistoryServiceConfigProvider.ts sets `eventExpirationSeconds: 14 * 86400`. Mongo's TTL monitor
// deletes every document whose timestamp passes 14 days, in ANY position, so pruning the head of an
// insertion-ordered array is not equivalent (AUDIT F08 / probe P12: `skillLaunches[0]` stays recent
// while a back-dated row survives further down the array).

test('SKILL_LAUNCH_RETENTION_MS is the pinned 14 days (eventExpirationSeconds = 14 * 86400)', () => {
  assert.equal(SKILL_LAUNCH_RETENTION_MS, 14 * 86400 * 1000);
  assert.equal(SKILL_LAUNCH_RETENTION_MS, 1209600000);
});

test('a launch older than the window is pruned even when it is NOT the oldest array element', () => {
  const s = new HistoryStore();
  // Recent row first, so the back-dated row is appended AFTER it — this is exactly the P12 shape:
  // the head of the array is fresh, so a head-only prune never fires.
  launch(s, { sessionID: 'recent', intent: 'recent' });
  launch(s, { sessionID: 'stale', intent: 'stale', timestamp: Date.now() - 40 * 86400000 });
  assert.equal(s.getCount({ robotID: ROBOT }), 1, 'the 40-day-old row must not be counted');
  assert.equal(s.getCount({ robotID: ROBOT, intent: 'stale' }), 0);
  assert.equal(s.getLatest({ robotID: ROBOT }).intent, 'recent');
  assert.deepEqual(s.skillLaunches.map((r) => r.sessionID), ['recent'], 'and it must be evicted, not just filtered');
});

test('retention boundary: a row inside the window is kept; one past it is evicted', () => {
  const s = new HistoryStore();
  const t = Date.now();
  launch(s, { sessionID: 'inside', timestamp: t - SKILL_LAUNCH_RETENTION_MS + 60000 });
  launch(s, { sessionID: 'outside', timestamp: t - SKILL_LAUNCH_RETENTION_MS - 60000 });
  assert.equal(s.getCount({ robotID: ROBOT }), 1);
  assert.equal(s.getLatest({ robotID: ROBOT }).sessionID, 'inside');
});

test('retention does not touch speech records (the reference speech schema has no expires)', () => {
  const s = new HistoryStore();
  const id = s.addSpeech({ robotID: ROBOT, transID: 't-old', timestamp: Date.now() - 400 * 86400000 });
  s.getCount({ robotID: ROBOT }); // trigger a prune pass
  assert.ok(s.speech.has(id), 'an old speech record is retained indefinitely');
});
