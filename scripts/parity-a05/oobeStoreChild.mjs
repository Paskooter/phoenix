#!/usr/bin/env node
// Child used by packages/account/test/oobeRestartSIGKILL.test.js. It provisions a durable
// owner + loop + robot account through the real Store/model, writes a marker with the issued
// credentials, then keeps rewriting the snapshot until the parent SIGKILLs it mid-write.
// Lives outside packages/*/test so `node --test` does not execute it.
import { writeFileSync } from 'node:fs';
import { Store } from '../../packages/account/src/store.js';
import { createOwnerAccount, createLoop } from '../../packages/account/src/model.js';

const [file, marker] = process.argv.slice(2);
if (!file || !marker) {
  process.stderr.write('oobeStoreChild: usage: oobeStoreChild.mjs <storeFile> <markerFile>\n');
  process.exit(2);
}

const store = new Store(file);
const owner = createOwnerAccount(store, { email: 'sigkill-owner@crash.invalid', password: 'pw', firstName: 'Sigkill' });
const { loop, robot } = createLoop(store, { owner, robotId: 'sigkill-robot-alpha' });
store.flush();

writeFileSync(marker, JSON.stringify({
  ownerId: owner._id,
  robotId: robot._id,
  accessKeyId: robot.accessKeyId,
  secretAccessKey: robot.secretAccessKey,
  loopId: loop._id,
}));

// Keep the write cycle busy so the parent's SIGKILL can land mid-flush. Every flush is an
// atomic tmp+rename, so the on-disk file is always a complete snapshot.
for (;;) {
  robot.updated = Date.now();
  store.flush();
}
