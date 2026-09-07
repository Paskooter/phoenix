import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { bindTransactionClose } from '../src/index.js';

test('a listen socket close does not resolve an unfinished transaction', () => {
  const socket = new EventEmitter();
  let resolved = 0;
  bindTransactionClose(socket, { resolve() { resolved += 1; } }, false);
  socket.emit('close');
  assert.equal(resolved, 0);
});

test('proactive socket close retains its existing transaction resolution hook', () => {
  const socket = new EventEmitter();
  let resolved = 0;
  bindTransactionClose(socket, { resolve() { resolved += 1; } }, true);
  socket.emit('close');
  assert.equal(resolved, 1);
});
