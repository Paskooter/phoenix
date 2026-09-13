#!/usr/bin/env node

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { capture } = createRequire(import.meta.url)('./protocol.cjs');

test('protocol preserves non-finite, undefined, negative zero, functions, and cycles', async () => {
  const cycle = {};
  cycle.self = cycle;
  const outcome = await capture(() => ({ undefined: undefined, nan: NaN, positiveInfinity: Infinity, negativeInfinity: -Infinity, negativeZero: -0, function: function named() {}, cycle }));
  assert.equal(outcome.status, 'fulfilled');
  assert.deepEqual(outcome.value, {
    cycle: { self: { $type: 'cycle' } },
    function: { $type: 'function', name: 'named' },
    nan: { $type: 'number', value: 'NaN' },
    negativeInfinity: { $type: 'number', value: '-Infinity' },
    negativeZero: { $type: 'number', value: '-0' },
    positiveInfinity: { $type: 'number', value: 'Infinity' },
    undefined: { $type: 'undefined' },
  });
});

test('protocol tags rejected promises and encoding failures explicitly', async () => {
  const rejected = await capture(() => Promise.reject(Object.assign(new Error('fixture failure'), { code: 'E_FIXTURE' })));
  assert.deepEqual(rejected, { status: 'rejected', error: { name: 'Error', message: 'fixture failure', code: 'E_FIXTURE' } });

  const getter = {};
  Object.defineProperty(getter, 'bad', { enumerable: true, get() { throw new TypeError('getter failure'); } });
  const encodingFailure = await capture(() => getter);
  assert.deepEqual(encodingFailure, { status: 'rejected', error: { name: 'TypeError', message: 'getter failure' } });
});
