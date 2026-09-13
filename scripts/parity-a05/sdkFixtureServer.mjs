#!/usr/bin/env node

// Process fixture for the installed original @jibo/jibo-server-client matrix.
//
// The parent runner starts this file twice.  The first process creates two
// independent faces (Account and Classic) over one durable Store.  The second
// process opens the same Store and serves the same fixture identities.  The
// control endpoint is deliberately separate from the SDK faces so a shutdown
// can be requested after the client has finished without killing the process.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACCESS_TOKEN_LIFETIME_MS, createLoop, createOwnerAccount, mintSetupToken } from '../../packages/account/src/model.js';
import { Store } from '../../packages/account/src/store.js';
import { createAccountService } from '../../packages/account/src/index.js';
import { createClassicEntrypoint } from '../../packages/classic/src/index.js';

const [storeFile, metadataFile] = process.argv.slice(2);
if (!storeFile || !metadataFile) {
  process.stderr.write('usage: sdkFixtureServer.mjs <store-file> <metadata-file>\n');
  process.exit(2);
}

const metadataExists = fs.existsSync(metadataFile);
const store = new Store(storeFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const candidateRevision = process.env.A05_CANDIDATE_REVISION || 'unknown';

function createFixtures() {
  const fixtures = [];
  for (const face of ['account', 'classic']) {
    const owner = createOwnerAccount(store, {
      email: `a05-${face}-owner@matrix.invalid`,
      password: 'matrix-owner-password',
      firstName: `A05${face}`,
      lastName: 'Owner',
    });
    const admin = createOwnerAccount(store, {
      email: `a05-${face}-admin@matrix.invalid`,
      password: 'matrix-admin-password',
      firstName: `A05${face}`,
      lastName: 'Admin',
    });
    admin.isAdmin = true;
    store.flush();

    const live = createLoop(store, { owner, robotId: `a05-${face}-live-robot` });
    const suspended = createLoop(store, { owner, robotId: `a05-${face}-suspended-old` });
    suspended.loop.isSuspended = true;
    store.flush();

    // Every token below has a distinct account/loop pair.  In particular, the
    // unbound setup token is minted last so PrepareRobot cannot refresh it.
    const expired = mintSetupToken(store, owner._id, `a05-${face}-expired-loop`);
    expired.created = Date.now() - ACCESS_TOKEN_LIFETIME_MS - 1000;
    store.flush();
    const reconnect = mintSetupToken(store, owner._id, `a05-${face}-reconnect-loop`);
    const liveToken = mintSetupToken(store, owner._id, live.loop._id);
    const replacementToken = mintSetupToken(store, owner._id, suspended.loop._id);
    const setup = mintSetupToken(store, owner._id, null);

    fixtures.push({
      face,
      owner: { accessKeyId: owner.accessKeyId, secretAccessKey: owner.secretAccessKey },
      admin: { accessKeyId: admin.accessKeyId, secretAccessKey: admin.secretAccessKey },
      setupToken: setup._id,
      expiredToken: expired._id,
      reconnectToken: reconnect._id,
      liveToken: liveToken._id,
      replacementToken: replacementToken._id,
      liveLoopId: live.loop._id,
      suspendedLoopId: suspended.loop._id,
      liveRobotId: `a05-${face}-live-robot`,
      ordinaryRobotId: `a05-${face}-ordinary-robot`,
      replacementRobotId: `a05-${face}-replacement-robot`,
      serviceRobotId: `a05-${face}-service-robot`,
    });
  }
  store.flush();
  return fixtures;
}

let prior;
if (metadataExists) {
  prior = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  if (!Array.isArray(prior.fixtures) || prior.fixtures.length !== 2) {
    throw new Error('metadata does not contain the two A-05 fixtures');
  }
} else {
  prior = { fixtures: createFixtures() };
}

// The fixture must never attempt an external robot read or mail/event delivery.
const invitationProviders = {
  invitation: { send: async () => {} },
  invitationExistingUser: { send: async () => {} },
  eventSender: { send: async () => {} },
};
const robotReadClient = { getRobot: async () => ({ payload: { suspended: false } }) };
const notificationFile = path.join(path.dirname(storeFile), 'notifications.json');
const iftttFile = path.join(path.dirname(storeFile), 'ifttt.json');
const account = await createAccountService({
  store,
  invitationProviders,
  robotReadClient,
}).listen(0);
process.env.NET_account = `http://127.0.0.1:${account.address().port}`;
const classic = await createClassicEntrypoint({
  notificationFile,
  notificationPollIntervalMs: -1,
  ifttt: { file: iftttFile },
}).listen(0);

const control = http.createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('connection', 'close');
  if (req.url === '/snapshot') {
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (req.url === '/shutdown') {
    res.end(JSON.stringify({ shuttingDown: true }));
    // Let the response flush before closing the service listeners.  The
    // close callback is the process-level orderly-restart receipt.
    setImmediate(async () => {
      try {
        await closeServer(account);
        await closeServer(classic);
        await closeServer(control);
        process.exit(0);
      } catch (error) {
        process.stderr.write(`orderly shutdown failed: ${error.stack || error}\n`);
        process.exit(1);
      }
    });
    return;
  }
  res.writeHead(404);
  res.end('{}');
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(0, '127.0.0.1', resolve);
});

const phase = metadataExists ? 'restart' : 'initial';
const nextMetadata = {
  schema: 1,
  phase,
  candidateRevision,
  candidateRoot: root,
  node: process.version,
  storeFile,
  controlEndpoint: `http://127.0.0.1:${control.address().port}`,
  accountEndpoint: `http://127.0.0.1:${account.address().port}`,
  classicEndpoint: `http://127.0.0.1:${classic.address().port}`,
  accountPort: account.address().port,
  classicPort: classic.address().port,
  fixtures: prior.fixtures,
};
writePrivate(metadataFile, `${JSON.stringify(nextMetadata, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ready: true, phase, accountPort: account.address().port, classicPort: classic.address().port })}\n`);

function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server || !server.listening) return resolve();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function collectionDigest(map) {
  return JSON.stringify([...map.entries()]);
}

function snapshot() {
  const reopened = new Store(store.file);
  const collections = ['accounts', 'loops', 'tokens', 'sessions', 'settings', 'notificationOutbox', 'emailResets', 'phoneVerifications', 'oauthClients'];
  const collectionMatches = Object.fromEntries(collections.map((name) => [name, collectionDigest(store[name]) === collectionDigest(reopened[name])]));
  return {
    phase,
    accounts: store.accounts.size,
    robots: [...store.accounts.values()].filter((account) => account.friendlyId).length,
    serviceAccounts: [...store.accounts.values()].filter((account) => String(account.email || '').startsWith('service-mode-owner-')).length,
    loops: store.loops.size,
    suspendedLoops: [...store.loops.values()].filter((loop) => loop.isSuspended === true).length,
    tokens: store.tokens.size,
    collectionMatches,
    allCollectionsMatchDisk: Object.values(collectionMatches).every(Boolean),
  };
}

async function orderlyClose() {
  await closeServer(account);
  await closeServer(classic);
  await closeServer(control);
}

process.once('SIGINT', () => { orderlyClose().then(() => process.exit(0), () => process.exit(1)); });
process.once('SIGTERM', () => { orderlyClose().then(() => process.exit(0), () => process.exit(1)); });
