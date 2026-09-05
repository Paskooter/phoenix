import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../src/normalize.js';
import { diffStreams } from '../src/diff.js';

test('normalization preserves complete sessions, identifiers and timing fields', () => {
  const m = {
    type: 'SKILL_ACTION',
    msgID: 'uuid-123',
    ts: 1770000000000,
    timings: { total: 42 },
    data: { skill: { id: 'answer-skill', session: { id: 's1', nodeID: 7, data: { x: 1 }, trace: [] } } },
  };
  const n = normalizeMessage(m);
  assert.deepEqual(n, m);
  assert.notEqual(n.data.skill.session, m.data.skill.session);
});

test('stream comparison does not silently erase identifiers and timestamps', () => {
  const ref = [
    { type: 'SOS', msgID: 'a', ts: 1, data: null, timings: { total: 1 } },
    { type: 'EOS', msgID: 'b', ts: 2, data: null, timings: { total: 2 } },
    { type: 'LISTEN', msgID: 'c', ts: 3, final: false, data: { nlu: { intent: 'who', rules: ['launch'], entities: {} } } },
  ];
  const neu = [
    { type: 'SOS', msgID: 'x', ts: 99, data: null, timings: { total: 7 } },
    { type: 'EOS', msgID: 'y', ts: 100, data: null, timings: { total: 8 } },
    { type: 'LISTEN', msgID: 'z', ts: 101, final: false, data: { nlu: { intent: 'who', rules: ['launch'], entities: {} } } },
  ];
  assert.ok(diffStreams(ref, neu).length > 0);
});

test('D1 catches a wrong message-type sequence', () => {
  const ref = [{ type: 'SOS', data: null }, { type: 'EOS', data: null }, { type: 'LISTEN', data: {} }];
  const neu = [{ type: 'SOS', data: null }, { type: 'LISTEN', data: {} }];
  const diffs = diffStreams(ref, neu, { level: 'D1' });
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /D1 type-sequence/);
});

test('D2 catches a payload divergence (different intent)', () => {
  const ref = [{ type: 'LISTEN', data: { nlu: { intent: 'who', rules: ['launch'], entities: {} } } }];
  const neu = [{ type: 'LISTEN', data: { nlu: { intent: 'what', rules: ['launch'], entities: {} } } }];
  const diffs = diffStreams(ref, neu);
  assert.equal(diffs.length, 1);
  assert.match(diffs[0], /D2 \/0\/data\/nlu\/intent:/);
});

test('stream comparison preserves port numbers unless a trace policy explicitly binds an endpoint', () => {
  const ref = [{ type: 'X', data: { url: 'http://answer-skill:8080/v1/main' } }];
  const neu = [{ type: 'X', data: { url: 'http://answer-skill:7099/v1/main' } }];
  assert.ok(diffStreams(ref, neu).length > 0);
});

test('JSON object key order is insignificant; missing fields are significant', () => {
  assert.deepEqual(diffStreams([{ a: 1, b: null }], [{ b: null, a: 1 }]), []);
  assert.ok(diffStreams([{ field: undefined }], [{}]).length > 0);
});
