import test from 'node:test';
import assert from 'node:assert/strict';
import { readTrace, writeTrace } from '../src/headers.js';

test('optional turn IDs preserve the legacy trace shape and round-trip only valid IDs', () => {
  const trace = { transId: 'fixture-transaction', robotId: 'fixture-robot', loggingConfig: '{}' };
  const headers = writeTrace(trace);
  for (const value of [undefined, '', 'arbitrary caller text', ['6cb158e8-2932-45b5-b15d-fcf54c844b65']]) {
    assert.deepEqual(readTrace({ headers: { ...headers, 'x-phoenix-turn-id': value } }), trace);
  }
  const withTurn = { ...trace, turnId: '6cb158e8-2932-45b5-b15d-fcf54c844b65' };
  assert.deepEqual(readTrace({ headers: writeTrace(withTurn) }), withTurn);
});
