import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../src/normalize.js';
import { diffStreams } from '../src/diff.js';

test('normalize strips volatiles and blanks session contents', () => {
  const m = {
    type: 'SKILL_ACTION',
    msgID: 'uuid-123',
    ts: 1770000000000,
    timings: { total: 42 },
    data: { skill: { id: 'answer-skill', session: { id: 's1', nodeID: 7, data: { x: 1 }, trace: [] } } },
  };
  const n = normalizeMessage(m);
  assert.equal(n.msgID, undefined);
  assert.equal(n.ts, undefined);
  assert.equal(n.timings, undefined);
  assert.deepEqual(n.data.skill.session, { _session: true });
  assert.equal(n.data.skill.id, 'answer-skill');
});

test('two streams that differ only in volatiles + session contents match', () => {
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
  assert.deepEqual(diffStreams(ref, neu), []);
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
  assert.match(diffs[0], /D2 message\[0\]/);
});

test('port-bearing URLs are collapsed so host mappings do not cause false diffs', () => {
  const ref = [{ type: 'X', data: { url: 'http://answer-skill:8080/v1/main' } }];
  const neu = [{ type: 'X', data: { url: 'http://answer-skill:7099/v1/main' } }];
  assert.deepEqual(diffStreams(ref, neu), []);
});
