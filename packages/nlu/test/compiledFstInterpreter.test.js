import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretOutputSymbols } from '../src/compiledFstInterpreter.js';

test('evaluates literal, reference, and arithmetic RHS through the source JS path', () => {
  assert.deepEqual(interpretOutputSymbols([
    "N:{} seed = 'a'",
    'N:{} copy = seed',
    "N:{} copy += 'b'",
    'N:{} missing += seed',
    'N:{} {% count = 1; enabled = true; empty = null; total = count + 2; literal = \'a\\\\nb\'; nested = { value: \' inner \', list: [1, \' item \', null] }; %}',
  ]), {
    seed: 'a',
    copy: 'ab',
    missing: 'a',
    count: 1,
    enabled: true,
    empty: null,
    total: 3,
    literal: 'a\\nb',
    nested: { value: 'inner', list: [1, 'item', null] },
  });
});

test('keeps nested assignments on the source wrapper while exposing root references', () => {
  assert.deepEqual(interpretOutputSymbols([
    "N:{child} inner = ' inner '",
    'N:{child} same = inner',
    'N:{child} {% this.fromRaw = this.inner; exportedFromRaw = this.inner; %}',
    'N:{} fromNested = child.same',
  ]), {
    exportedFromRaw: 'inner',
    fromNested: 'inner',
  });
});

test('root `this` fields stay on the disposable wrapper', () => {
  assert.deepEqual(interpretOutputSymbols([
    'N:{} {% this.hidden = 1; visible = 2; %}',
  ]), { visible: 2 });
});

test('runs all raw blocks in one wrapper function so lexical state persists', () => {
  assert.deepEqual(interpretOutputSymbols([
    'N:{} {% var count = 1; function increment() { count += 1; } %}',
    'N:{} {% increment(); result = count; %}',
  ]), { result: 2 });
});

test('retains nested context closures across repeated context blocks', () => {
  assert.deepEqual(interpretOutputSymbols([
    'N:{child} {% var count = 2; function readNext() { return count + 1; } %}',
    'N:{child} {% result = readNext(); %}',
  ]), { result: 3 });
  assert.deepEqual(interpretOutputSymbols([
    'N:{child} {% var count = 1; seen = count; %}',
    'N:{child} {% count += 1; seen = count; %}',
  ]), { seen: 2 });
});

test('keeps native underscore result fields instead of applying a Phoenix filter', () => {
  assert.deepEqual(interpretOutputSymbols([
    "N:{} _d = 'compiler-value'",
    "N:{} intent = 'tag'",
  ]), { _d: 'compiler-value', intent: 'tag' });
});

test('propagates source JavaScript failures instead of silently producing tags', () => {
  assert.throws(
    () => interpretOutputSymbols(['N:{} {% missingFunction(); %}']),
    error => error.name === 'ReferenceError' && /missingFunction is not defined/u.test(error.message),
  );
  assert.throws(
    () => interpretOutputSymbols(['N:{} {% if ( %}']),
    error => error.name === 'SyntaxError',
  );
  assert.throws(
    () => interpretOutputSymbols(['N:{} this is not an assignment']),
    /NL return is not an assignment/u,
  );
});
