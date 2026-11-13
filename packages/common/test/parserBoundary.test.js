// Synthetic privacy/volume controls for the Parser-only diagnostic projector.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createParserBoundary, recentLogs } from '../src/index.js';

const PRIVATE = 'SYNTHETIC_DIAGNOSTIC_SECRET_8c23';
const cursor = () => recentLogs({ limit: 1 }).cursor;
const records = since => recentLogs({ since, limit: 200 }).events.filter(row => row.msg === 'parser_boundary');

test('only the dedicated bounded peer-token format is adopted; caller identity forms are replaced', () => {
  const since = cursor();
  const invalid = [undefined, null, PRIVATE, '87f6dc66-e601-44c6-ae5b-e96d10fac822',
    `p1_${'f'.repeat(33)}`, `p1_${'A'.repeat(32)}`, `${PRIVATE}\r\n${'x'.repeat(10000)}`, ['p1_' + 'a'.repeat(32)]];
  const ids = invalid.map(value => {
    const boundary = createParserBoundary('parser', value);
    boundary.complete('ok');
    return boundary.requestId;
  });
  assert.equal(new Set(ids).size, invalid.length);
  assert.ok(ids.every(id => /^p1_[0-9a-f]{32}$/.test(id)));
  const token = `p1_${'ab'.repeat(16)}`;
  const boundary = createParserBoundary('parser', token);
  assert.equal(boundary.requestId, token);
  assert.equal(Object.isFrozen(boundary), true);
  assert.throws(() => { boundary.requestId = PRIVATE; }, TypeError);
  boundary.complete('ok');
  assert.equal(JSON.stringify(records(since)).includes(PRIVATE), false);
});

test('diagnostic volume and values are capped even for repeated events and hostile inputs', () => {
  const since = cursor();
  const hostile = { toJSON() { throw Error('must not serialize'); }, toString() { throw Error('must not coerce'); } };
  const boundary = createParserBoundary(PRIVATE, hostile);
  assert.equal(createParserBoundary('gateway', boundary), boundary, 'owning wait shares only a minted immutable observer');
  boundary.interrupt(PRIVATE); // Invalid values cannot consume the interruption slot.
  boundary.interrupt(hostile);
  for (let i = 0; i < 20; i++) {
    boundary.interrupt(i ? 'request_deadline' : 'wait_timeout');
    boundary.complete(hostile, hostile);
    boundary.response(i ? 503 : hostile);
  }
  const rows = records(since);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete', 'response']);
  assert.ok(rows.every(row => row.side === 'gateway'));
  assert.equal(rows[1].interruption, 'wait_timeout');
  assert.equal(rows[2].outcome, 'error');
  assert.equal(rows[2].status, 0);
  assert.equal(rows[2].late, 1);
  assert.equal(rows[3].status, 0);
  assert.equal(JSON.stringify(rows).includes(PRIVATE), false);
});

test('elapsed values are monotonic-clock integers with finite zero and upper-bound fallbacks', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const since = cursor();
  const cases = [[NaN, 0], [Infinity, 0], [-Infinity, 0], [-20, 0], [12.9, 12], [1e20, 2_147_483_647]];
  for (const [value, expected] of cases) {
    now = 0;
    const boundary = createParserBoundary('gateway');
    now = value;
    boundary.complete('ok', value);
    const row = records(since).at(-1);
    assert.equal(row.elapsedMs, expected);
    assert.equal(row.status, 0);
  }
});

test('a diagnostic sink exception is not allowed to throw into the request path', (t) => {
  const original = process.stdout.write;
  const sink = t.mock.method(process.stdout, 'write', () => { throw new Error(PRIVATE); });
  let error;
  try {
    const boundary = createParserBoundary('gateway');
    boundary.interrupt('cancelled');
    boundary.complete('aborted');
    boundary.response(200);
  } catch (value) { error = value; }
  finally { sink.mock.restore(); }
  assert.equal(process.stdout.write, original);
  assert.equal(error, undefined);
});
