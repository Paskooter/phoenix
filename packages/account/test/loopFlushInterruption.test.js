// A-04 gate 3 injection point 1: process interruption while an Account
// membership or loop mutation is being flushed. The child SIGKILLs itself
// inside Store.flush (or the LoopCreated publisher) so recovery inspects
// durable bytes rather than the killed process's in-memory rollback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.js';
import { createOwnerAccount, createLoop, MEMBER_STATUS, newId } from '../src/model.js';
import { LoopUpdatedOutbox } from '../src/loopUpdatedOutbox.js';
import { InvitationEventOutbox } from '../src/invitationEventOutbox.js';
import { createLoopFromApi, updateLoop } from '../src/loopMembership.js';

const CHILD = join(dirname(fileURLToPath(import.meta.url)), '../../../scripts/parity-a04/interruptFlushChild.mjs');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function household(directory) {
  const file = join(directory, 'account.json');
  const eventFile = join(directory, 'events.json');
  const store = new Store(file);
  const owner = createOwnerAccount(store, {
    email: `owner-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Interrupt',
  });
  const guest = createOwnerAccount(store, {
    email: `guest-${newId()}@synthetic.invalid`,
    password: 'synthetic-password',
    firstName: 'Guest',
  });
  const { loop, robot } = createLoop(store, { owner, robotId: `robot-${newId()}` });
  const memberId = newId();
  loop.members.push({
    _id: memberId,
    accountId: guest._id,
    status: MEMBER_STATUS.ACCEPTED,
    enrolled: { face: false, voice: false },
    created: Date.now(),
  });
  store.flush();
  return {
    file,
    eventFile,
    store,
    owner,
    guest,
    loop,
    robot,
    memberId,
    committed: readFileSync(file),
  };
}

function runChild(directory, config) {
  const configPath = join(directory, 'interrupt-config.json');
  const errorFile = join(directory, 'child-error.txt');
  const interruptedSnapshot = join(directory, 'interrupted-snapshot.json');
  writeFileSync(configPath, `${JSON.stringify({ ...config, errorFile, interruptedSnapshot }, null, 2)}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, configPath], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '../../..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout,
        stderr,
        errorText: existsSync(errorFile) ? readFileSync(errorFile, 'utf8') : '',
        interruptedSnapshot: existsSync(interruptedSnapshot)
          ? JSON.parse(readFileSync(interruptedSnapshot, 'utf8'))
          : null,
      });
    });
  });
}

async function assertKilled(result) {
  assert.equal(result.signal, 'SIGKILL', `expected SIGKILL, got code=${result.code} signal=${result.signal} stderr=${result.stderr} error=${result.errorText}`);
  assert.equal(result.code, null);
  assert.equal(result.errorText, '');
}

test('UpdateLoop killed before rename leaves the prior snapshot and emits no LoopUpdated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-update-before-'));
  try {
    const state = household(directory);
    const beforeName = state.loop.name;
    const result = await runChild(directory, {
      file: state.file,
      mode: 'flush-before-rename',
      op: 'UpdateLoop',
      ownerId: state.owner._id,
      loopId: state.loop._id,
      name: 'Interrupted name',
    });
    await assertKilled(result);
    assert.equal(sha256(readFileSync(state.file)), sha256(state.committed));
    const reopened = new Store(state.file);
    assert.equal(reopened.loops.get(state.loop._id).name, beforeName);
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(result.interruptedSnapshot.loops.find((row) => row._id === state.loop._id).name, 'Interrupted name');

    const recovered = [];
    const outbox = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { recovered.push(request.notification.name); },
    });
    assert.deepEqual(await outbox.recover(), { published: 0, retained: 0 });
    assert.deepEqual(recovered, []);

    updateLoop(reopened, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      name: 'Recovered name',
    }, outbox);
    await outbox.draining;
    assert.equal(reopened.loops.get(state.loop._id).name, 'Recovered name');
    assert.deepEqual(recovered, ['LoopUpdated']);
    assert.equal(outbox.pending().length, 0);
    assert.equal(new Store(state.file).loops.get(state.loop._id).name, 'Recovered name');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('UpdateLoop killed after rename keeps the mutation and one recoverable LoopUpdated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-update-after-'));
  try {
    const state = household(directory);
    const result = await runChild(directory, {
      file: state.file,
      mode: 'flush-after-rename',
      op: 'UpdateLoop',
      ownerId: state.owner._id,
      loopId: state.loop._id,
      name: 'Durable interrupted name',
    });
    await assertKilled(result);
    assert.notEqual(sha256(readFileSync(state.file)), sha256(state.committed));
    const reopened = new Store(state.file);
    assert.equal(reopened.loops.get(state.loop._id).name, 'Durable interrupted name');
    assert.equal(reopened.notificationOutbox.size, 1);
    const pending = [...reopened.notificationOutbox.values()][0];
    assert.equal(pending.skillId, '-1');
    assert.equal(pending.accountId, state.robot._id);
    assert.equal(pending.notification.name, 'LoopUpdated');
    assert.equal(pending.notification.payload.name, 'Durable interrupted name');

    const recovered = [];
    const outbox = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { recovered.push(request); },
    });
    assert.deepEqual(await outbox.recover(), { published: 1, retained: 0 });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].notification.name, 'LoopUpdated');
    assert.equal(outbox.pending().length, 0);

    updateLoop(reopened, {
      ownerId: state.owner._id,
      loopId: state.loop._id,
      name: 'Following valid name',
    }, outbox);
    await outbox.draining;
    assert.equal(reopened.loops.get(state.loop._id).name, 'Following valid name');
    assert.equal(recovered.length, 2);
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CreateLoop killed before rename creates no loop and emits neither LoopCreated nor LoopUpdated', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-create-before-'));
  try {
    const state = household(directory);
    const robotId = `created-${newId()}`;
    const result = await runChild(directory, {
      file: state.file,
      eventFile: state.eventFile,
      mode: 'flush-before-rename',
      skipFlushes: 1,
      op: 'CreateLoop',
      ownerId: state.owner._id,
      name: 'Interrupted create',
      robotId,
    });
    await assertKilled(result);
    const reopened = new Store(state.file);
    assert.ok(reopened.accountByFriendlyId(robotId), 'the source robot Account.save precedes the Loop save');
    assert.equal(reopened.loops.size, 1, 'the uncommitted Loop save is not durable');
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(existsSync(state.eventFile), false);
    assert.ok(result.interruptedSnapshot.loops.some((row) => row.name === 'Interrupted create'));

    const created = [];
    const updated = [];
    const eventSender = new InvitationEventOutbox(state.eventFile, {
      publisher: async (event) => { created.push(event.payload.eventKey); },
    });
    const outbox = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { updated.push(request.notification.name); },
    });
    const following = createLoopFromApi(reopened, {
      ownerId: state.owner._id,
      name: 'Following create',
      robotId,
    }, outbox, { invitationProviders: { eventSender } });
    await Promise.all([outbox.draining, eventSender.draining]);
    assert.equal(following.name, 'Following create');
    assert.deepEqual(created, ['LoopCreated']);
    assert.deepEqual(updated, ['LoopUpdated']);
    assert.equal(outbox.pending().length, 0);
    assert.equal(eventSender.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CreateLoop killed after rename recovers LoopUpdated and loses LoopCreated that was never queued', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-create-after-'));
  try {
    const state = household(directory);
    const robotId = `durable-${newId()}`;
    const result = await runChild(directory, {
      file: state.file,
      eventFile: state.eventFile,
      mode: 'flush-after-rename',
      skipFlushes: 1,
      op: 'CreateLoop',
      ownerId: state.owner._id,
      name: 'Durable interrupted create',
      robotId,
    });
    await assertKilled(result);
    const reopened = new Store(state.file);
    const created = [...reopened.loops.values()].find((row) => row.name === 'Durable interrupted create');
    assert.ok(created, 'the loop snapshot is durable once rename completes');
    assert.equal(reopened.notificationOutbox.size, 1);
    assert.equal(existsSync(state.eventFile), false, 'LoopCreated is after saveAndPopulate; a flush-time kill never queues it');

    const updated = [];
    const outbox = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { updated.push(request.notification.name); },
    });
    assert.deepEqual(await outbox.recover(), { published: 1, retained: 0 });
    assert.deepEqual(updated, ['LoopUpdated']);
    assert.equal(new InvitationEventOutbox(state.eventFile).pending().length, 0, 'a never-queued LoopCreated is lost, matching source fire-and-forget after populate');

    assert.equal(reopened.loops.get(created._id).isDeleted === true, false);
    updateLoop(reopened, {
      ownerId: state.owner._id,
      loopId: created._id,
      name: 'Following create name',
    }, outbox);
    await outbox.draining;
    assert.equal(reopened.loops.get(created._id).name, 'Following create name');
    assert.deepEqual(updated, ['LoopUpdated', 'LoopUpdated']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CreateLoop killed in the LoopCreated publisher recovers both pending event rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-create-event-'));
  try {
    const state = household(directory);
    const robotId = `event-${newId()}`;
    const result = await runChild(directory, {
      file: state.file,
      eventFile: state.eventFile,
      mode: 'event-publisher',
      op: 'CreateLoop',
      ownerId: state.owner._id,
      name: 'Event-publisher create',
      robotId,
    });
    await assertKilled(result);
    const reopened = new Store(state.file);
    const created = [...reopened.loops.values()].find((row) => row.name === 'Event-publisher create');
    assert.ok(created);
    assert.equal(reopened.notificationOutbox.size, 1);
    const events = new InvitationEventOutbox(state.eventFile);
    assert.equal(events.pending().length, 1);
    assert.equal(events.pending()[0].event.payload.eventKey, 'LoopCreated');
    assert.equal(events.pending()[0].event.payload.loopId, created._id);

    const createdKeys = [];
    const updated = [];
    events.publisher = async (event) => { createdKeys.push(event.payload.eventKey); };
    const outbox = new LoopUpdatedOutbox(reopened, {
      publisher: async (request) => { updated.push(request.notification.name); },
    });
    assert.deepEqual(await events.recover(), { published: 1, retained: 0 });
    assert.deepEqual(await outbox.recover(), { published: 1, retained: 0 });
    assert.deepEqual(createdKeys, ['LoopCreated']);
    assert.deepEqual(updated, ['LoopUpdated']);
    assert.equal(events.pending().length, 0);
    assert.equal(outbox.pending().length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('RemoveLoopMember killed before rename leaves membership and emits no events', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'phx-a04-flush-remove-before-'));
  try {
    const state = household(directory);
    const result = await runChild(directory, {
      file: state.file,
      eventFile: state.eventFile,
      mode: 'flush-before-rename',
      op: 'RemoveLoopMember',
      ownerId: state.owner._id,
      loopId: state.loop._id,
      memberId: state.memberId,
    });
    await assertKilled(result);
    assert.equal(sha256(readFileSync(state.file)), sha256(state.committed));
    const reopened = new Store(state.file);
    const member = reopened.loops.get(state.loop._id).members.find((row) => row._id === state.memberId);
    assert.equal(String(member.status).toLowerCase(), 'accepted');
    assert.equal(reopened.notificationOutbox.size, 0);
    assert.equal(existsSync(state.eventFile), false);
    const interrupted = result.interruptedSnapshot.loops
      .find((row) => row._id === state.loop._id)
      .members.find((row) => row._id === state.memberId);
    assert.equal(String(interrupted.status).toLowerCase(), 'removed');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
