import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { createLoopFromApi } from '../src/loopMembership.js';
import { createOwnerAccount, createLoop } from '../src/model.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';

test('CreateLoop invokes LoopCreated before the deferred LoopUpdated publisher', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-create-order-'));
  try {
    const store = new Store(join(directory, 'account.json'));
    const owner = createOwnerAccount(store, {
      email: 'a04-create-order-owner@synthetic.invalid',
      password: 'synthetic-password',
      firstName: 'Order',
    });
    const order = [];
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async (request) => {
        order.push(request.notification.name);
      },
    });

    const result = createLoopFromApi(
      store,
      { ownerId: owner._id, name: 'Source order loop', robotId: 'a04-order-robot' },
      outbox,
      {
        invitationProviders: {
          eventSender: {
            send(event) {
              order.push(event.payload.eventKey);
              return Promise.resolve();
            },
          },
        },
      },
    );

    // The controller sends LoopCreated on the current stack. The post-save
    // LoopUpdated publisher is scheduled for the next check phase.
    assert.equal(result.name, 'Source order loop');
    assert.deepEqual(order, ['LoopCreated']);
    assert.equal(outbox.pending().length, 1, 'the event is durable before publication');
    await outbox.draining;
    assert.deepEqual(order, ['LoopCreated', 'LoopUpdated']);
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a failed outbox snapshot does not schedule publication or lose the row state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-create-order-failure-'));
  try {
    const file = join(directory, 'account.json');
    const store = new Store(file);
    const owner = createOwnerAccount(store, {
      email: 'a04-create-order-failure@synthetic.invalid',
      password: 'synthetic-password',
      firstName: 'Failure',
    });
    const { loop } = createLoop(store, { owner, robotId: 'a04-order-failure-robot' });
    const before = readFileSync(file);
    let failFlush = true;
    const originalFlush = store.flush.bind(store);
    store.flush = () => {
      if (failFlush) throw new Error('synthetic outbox snapshot failure');
      return originalFlush();
    };
    let published = 0;
    const outbox = new LoopUpdatedOutbox(store, {
      publisher: async () => { published += 1; },
    });

    assert.throws(() => outbox.record({ ...loop, name: 'failed order loop' }),
      /synthetic outbox snapshot failure/);
    assert.equal(published, 0, 'publication is not scheduled after a rejected snapshot');
    assert.equal(outbox.pending().length, 0, 'the failed row is rolled back');
    assert.deepEqual(readFileSync(file), before, 'the durable snapshot is unchanged');
    assert.equal(outbox.draining, null);

    // Once persistence is healthy, a later source-compatible record can be
    // published normally; the failed attempt did not poison the outbox.
    failFlush = false;
    outbox.record({ ...loop, name: 'recovered order loop' });
    await outbox.draining;
    assert.equal(published, 1);
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
