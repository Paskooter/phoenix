import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick();
  }
  assert.fail('timed out waiting for outbox drain');
}

function loop(id) {
  return { _id: id, robot: 'robot-account', members: [] };
}

test('an enqueue during an awaited drain schedules one follow-up pass', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a10-outbox-concurrency-'));
  try {
    const store = new Store(join(directory, 'account.json'));
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const delivered = [];
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async (request) => {
        const id = request.notification.payload.id;
        delivered.push(id);
        if (id === 'first-loop') {
          markStarted();
          await gate;
        }
      },
    });

    outbox.record(loop('first-loop'));
    await started;
    outbox.record(loop('second-loop'));
    assert.deepEqual(delivered, ['first-loop'], 'the current drain has a stable initial snapshot');
    release();

    await waitFor(() => delivered.length === 2 && outbox.draining === null
      && outbox.pending().length === 0);
    assert.deepEqual(delivered, ['first-loop', 'second-loop']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a concurrent request causes only one recovery pass after a publisher failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a10-outbox-failure-'));
  try {
    const store = new Store(join(directory, 'account.json'));
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let firstStarted = false;
    const delivered = [];
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async (request) => {
        const id = request.notification.payload.id;
        delivered.push(id);
        if (id === 'first-loop' && !firstStarted) {
          firstStarted = true;
          await gate;
        }
        if (id === 'first-loop') throw new Error('synthetic bridge failure');
      },
    });

    outbox.record(loop('first-loop'));
    await waitFor(() => firstStarted);
    outbox.record(loop('second-loop'));
    release();

    await waitFor(() => outbox.draining === null && delivered.length === 3
      && outbox.pending().length === 1);
    assert.deepEqual(delivered, ['first-loop', 'first-loop', 'second-loop']);
    assert.deepEqual(outbox.pending().map((entry) => entry.notification.payload.id), ['first-loop']);
    const attempts = delivered.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(delivered.length, attempts, 'a failed publisher does not create an automatic tight retry loop');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a concurrent request does not spin when acknowledgement persistence keeps failing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a10-outbox-ack-failure-'));
  try {
    const store = new Store(join(directory, 'account.json'));
    const originalFlush = store.flush.bind(store);
    let failFlush = false;
    store.flush = (...args) => {
      if (failFlush) throw new Error('synthetic acknowledgement failure');
      return originalFlush(...args);
    };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let firstStarted = false;
    const delivered = [];
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async (request) => {
        const id = request.notification.payload.id;
        delivered.push(id);
        if (id === 'first-loop' && !firstStarted) {
          firstStarted = true;
          await gate;
          failFlush = true;
        }
      },
    });

    outbox.record(loop('first-loop'));
    await waitFor(() => firstStarted);
    outbox.record(loop('second-loop'));
    release();

    await waitFor(() => outbox.draining === null && delivered.length === 2
      && outbox.pending().length === 2);
    assert.deepEqual(delivered, ['first-loop', 'first-loop']);
    const attempts = delivered.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(delivered.length, attempts, 'a failed acknowledgement does not spin a retry loop');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
