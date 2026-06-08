import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/store.js';
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
  s.saveSkillPayload; // no-op ref
  launch(s, { sessionID: 'a', payload: { a: 1, b: 2 } });
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
