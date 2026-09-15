#!/usr/bin/env node
// A-19 conformance server. Runs the UNMODIFIED classic entrypoint with an
// injected loop-membership seam and a recording push provider.
//
// It runs in its own container on a bridge network alongside the client
// container. Host networking was tried first and the node-8 client hung against
// it with no output; container-to-container over a bridge is the configuration
// this harness proved works.
//
// Writes the recorded pushes and the run port to the shared /out volume so the
// runner can assert on them after the client finishes.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.A19_OUT || '/out';
const MEMBER = process.env.A19_MEMBER;
const ROBOT = process.env.A19_ROBOT;
const OUTSIDER = process.env.A19_OUTSIDER;
const LOOP = process.env.A19_LOOP;
const OTHER_LOOP = process.env.A19_OTHER_LOOP;

const { createClassicEntrypoint, JotStore, DeviceRegistry } = await import('/phoenix/packages/classic/src/index.js');
const { readFileSync } = await import('node:fs');

// TLS is served when a key/cert pair is mounted. The certificate must cover the
// name the client dials, so the runner generates one for the container hostname.
const tls = (process.env.A19_TLS_KEY && process.env.A19_TLS_CERT)
  ? { key: readFileSync(process.env.A19_TLS_KEY), cert: readFileSync(process.env.A19_TLS_CERT) }
  : undefined;

// Shape per jot.js getImpersonatedAccount: members[] with an accepted status and
// the id under memberId or accountId. Supplying accounts[] instead makes every
// request 403, which looks like a working gate and is not.
const member = (id) => ({ memberId: id, accountId: id, status: 'accepted' });
const loops = {
  [LOOP]: { id: LOOP, robot: ROBOT, members: [member(MEMBER), member(ROBOT)] },
  [OTHER_LOOP]: { id: OTHER_LOOP, robot: ROBOT, members: [member(OUTSIDER)] },
};

const store = new JotStore(join(OUT, 'jot-store.json'));
const registry = new DeviceRegistry(join(OUT, 'devices.json'));
registry.createDevice(MEMBER, { name: 'member-phone', pushToken: 'tok-member', type: 'ios' });

const pushes = [];
const entry = createClassicEntrypoint({
  tls,
  jot: {
    store,
    pushRegistry: registry,
    account: {
      async get(loopId) { return loops[loopId] || null; },
      async getAccountById(id) { return { firstName: 'A19', lastName: id }; },
    },
    push: {
      async send(row) {
        pushes.push({
          token: row?.device?.pushToken,
          type: row?.notification?.data?.type,
          badge: row?.notification?.badge,
          locKey: row?.notification?.locKey,
          locArgs: row?.notification?.locArgs,
          body: row?.notification?.body,
        });
        writeFileSync(join(OUT, 'pushes.json'), JSON.stringify(pushes, null, 2));
      },
    },
  },
});

const server = await entry.listen(Number(process.env.PORT) || 8080);
writeFileSync(join(OUT, 'pushes.json'), '[]');
console.log(JSON.stringify({ ready: true, port: server.address().port, tls: Boolean(tls) }));
