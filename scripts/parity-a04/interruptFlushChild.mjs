#!/usr/bin/env node
// Child used by loopFlushInterruption.test.js. It loads a prepared Account
// store, injects a flush or LoopCreated-publisher interrupt, and SIGKILLs
// itself so the parent can inspect durable bytes without in-process rollback.
// Lives outside packages/*/test so `node --test` does not execute it.
import { readFileSync, writeFileSync } from 'node:fs';
import { Store } from '../../packages/account/src/store.js';
import { LoopUpdatedOutbox } from '../../packages/account/src/loopUpdatedOutbox.js';
import { InvitationEventOutbox } from '../../packages/account/src/invitationEventOutbox.js';
import { createLoopFromApi, removeMember, updateLoop } from '../../packages/account/src/loopMembership.js';

const COLLECTIONS = ['accounts', 'loops', 'tokens', 'sessions', 'settings', 'notificationOutbox'];

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write('interruptFlushChild: missing config path\n');
  process.exit(2);
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));

function snapshotMaps(store) {
  const out = {};
  for (const name of COLLECTIONS) out[name] = [...store[name].values()];
  return out;
}

function killNow() {
  process.kill(process.pid, 'SIGKILL');
}

try {
  const store = new Store(config.file);
  const originalFlush = store.flush.bind(store);
  // CreateLoop's source Account.save for the robot runs before Loop.save.
  // skipFlushes lets the child interrupt the loop/outbox snapshot rather than
  // the earlier independent robot-account write.
  let remainingSkips = Number(config.skipFlushes || 0);
  const interruptFlush = () => {
    if (remainingSkips > 0) {
      remainingSkips -= 1;
      return originalFlush();
    }
    if (config.mode === 'flush-before-rename') {
      writeFileSync(config.interruptedSnapshot, `${JSON.stringify(snapshotMaps(store), null, 2)}\n`);
      killNow();
      return undefined;
    }
    if (config.mode === 'flush-after-rename') {
      originalFlush();
      killNow();
      return undefined;
    }
    return originalFlush();
  };
  if (config.mode === 'flush-before-rename' || config.mode === 'flush-after-rename') {
    store.flush = interruptFlush;
  } else if (config.mode !== 'event-publisher') {
    throw new Error(`unknown interrupt mode: ${config.mode}`);
  }

  const eventPublisher = config.mode === 'event-publisher'
    ? () => { killNow(); }
    : null;
  const eventSender = config.eventFile
    ? new InvitationEventOutbox(config.eventFile, { publisher: eventPublisher })
    : { send() { return Promise.resolve(); } };
  const outbox = new LoopUpdatedOutbox(store, { publisher: null });
  const providers = { eventSender };

  // The membership writers defer their store mutation to a setImmediate batch
  // (source Loop.save() is per-request), so these calls are async. Await them
  // or the child returns before the injected flush interrupt can fire.
  if (config.op === 'UpdateLoop') {
    await updateLoop(store, {
      ownerId: config.ownerId,
      loopId: config.loopId,
      name: config.name,
    }, outbox);
  } else if (config.op === 'CreateLoop') {
    await createLoopFromApi(store, {
      ownerId: config.ownerId,
      name: config.name,
      robotId: config.robotId,
    }, outbox, { invitationProviders: providers });
  } else if (config.op === 'RemoveLoopMember') {
    await removeMember(store, {
      ownerId: config.ownerId,
      loopId: config.loopId,
      id: config.memberId,
    }, outbox, { invitationProviders: providers });
  } else {
    throw new Error(`unknown op: ${config.op}`);
  }

  writeFileSync(config.errorFile, 'child returned without SIGKILL\n');
  process.exit(3);
} catch (error) {
  try {
    writeFileSync(config.errorFile, `${error?.stack || error}\n`);
  } catch { /* parent treats a missing error file as a clean SIGKILL */ }
  process.exit(1);
}
