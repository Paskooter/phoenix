import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const candidateRoot = process.env.CANDIDATE_ROOT
  || '/home/shell/work/phoenix/.parity/worktrees/a04-state-sequences-20260910';
const evidenceRoot = process.env.EVIDENCE_ROOT
  || join(candidateRoot, '.parity/reviews/a04-state-sequences-20260910');
const candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: candidateRoot, encoding: 'utf8',
}).trim();
const readyPath = join(evidenceRoot, 'server-ready.json');
const capturesPath = join(evidenceRoot, 'server-captures.json');
const productFiles = [
  'packages/account/src/loopMembership.js',
  'packages/account/src/membershipEvents.js',
  'packages/account/src/loopUpdatedOutbox.js',
  'packages/account/src/loopCreation.js',
  'packages/classic/src/index.js',
  'packages/classic/src/router.js',
];

mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });

const { Store } = await import(`${candidateRoot}/packages/account/src/store.js`);
const { createOwnerAccount } = await import(`${candidateRoot}/packages/account/src/model.js`);
const { createAccountService } = await import(`${candidateRoot}/packages/account/src/index.js`);
const { createClassicEntrypoint } = await import(`${candidateRoot}/packages/classic/src/index.js`);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function redactHeaders(headers) {
  const result = {};
  for (const key of Object.keys(headers || {}).sort()) {
    const lower = key.toLowerCase();
    result[key] = lower === 'authorization' || lower === 'x-amz-credentials'
      ? '[synthetic-redacted]' : headers[key];
  }
  return result;
}

function captureHttp(server, face, captures) {
  server.on('request', (req, res) => {
    const requestChunks = [];
    const responseChunks = [];
    const record = {
      face,
      method: req.method,
      url: req.url,
      headers: redactHeaders(req.headers),
      target: req.headers['x-amz-target'] || null,
    };
    req.on('data', (chunk) => requestChunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const body = Buffer.concat(requestChunks);
      record.bodySha256 = sha256(body);
      record.bodyLength = body.length;
    });
    const oldWrite = res.write;
    const oldEnd = res.end;
    res.write = function write(chunk, ...args) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      }
      return oldWrite.call(this, chunk, ...args);
    };
    res.end = function end(chunk, ...args) {
      if (chunk !== undefined && chunk !== null && typeof chunk !== 'function') {
        responseChunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
      }
      return oldEnd.call(this, chunk, ...args);
    };
    res.on('finish', () => {
      const body = Buffer.concat(responseChunks);
      record.response = {
        status: res.statusCode,
        headers: redactHeaders(res.getHeaders()),
        bodySha256: sha256(body),
        bodyLength: body.length,
        body: body.toString('utf8'),
      };
      captures.push(record);
    });
  });
}

function publicActor(actor) {
  return {
    id: actor._id,
    accessKeyId: actor.accessKeyId,
    secretAccessKey: actor.secretAccessKey,
    email: actor.email,
  };
}

async function buildFace(label, captures) {
  const lower = label.toLowerCase();
  const store = new Store(join(evidenceRoot, `${lower}-store.json`));
  const owner = createOwnerAccount(store, {
    email: `${lower}-owner@synthetic.invalid`,
    password: 'fixture-password',
    firstName: `${label} Owner`,
  });
  const acceptGuest = createOwnerAccount(store, {
    email: `${lower}-accept@synthetic.invalid`,
    password: 'fixture-password',
    firstName: `${label} Accept`,
  });
  const declineGuest = createOwnerAccount(store, {
    email: `${lower}-decline@synthetic.invalid`,
    password: 'fixture-password',
    firstName: `${label} Decline`,
  });
  const admin = createOwnerAccount(store, {
    email: `${lower}-admin@synthetic.invalid`,
    password: 'fixture-password',
    firstName: `${label} Admin`,
  });
  admin.isAdmin = true;
  store.flush();

  const events = [];
  const loopUpdated = [];
  const invitationProviders = {
    portalUrl: 'http://portal.synthetic.invalid',
    invitation: { send() { return Promise.resolve(); } },
    invitationExistingUser: { send() { return Promise.resolve(); } },
    eventSender: {
      send(event) {
        events.push({
          eventKey: event.payload?.eventKey || event.constructor?.name,
          payload: { ...event.payload },
        });
        return Promise.resolve();
      },
    },
  };
  const robotReadClient = {
    async getRobot(friendlyId) { return { payload: { suspended: false, friendlyId } }; },
  };

  let classic = null;
  const account = createAccountService({
    store,
    invitationProviders,
    robotReadClient,
    notificationPublisher: async (request) => {
      loopUpdated.push({
        accountId: request?.accountId ?? null,
        skillId: request?.skillId ?? null,
        name: request?.notification?.name ?? null,
        payloadRobot: request?.notification?.payload?.robot ?? null,
        payloadOwner: request?.notification?.payload?.owner ?? null,
      });
      if (classic) classic.hub.enqueueNotification(request);
      return { accepted: true };
    },
  });
  const server = await account.listen(0);
  captureHttp(server, `${lower}-account`, captures);
  return {
    label,
    store,
    owner,
    acceptGuest,
    declineGuest,
    admin,
    account,
    server,
    events,
    loopUpdated,
    setClassic(value) { classic = value; },
    robotIdInvite: `${lower}-seq-invite-robot`,
    robotIdClear: `${lower}-seq-clear-robot`,
    robotIdRemove: `${lower}-seq-remove-robot`,
  };
}

const captures = [];
const accountFace = await buildFace('ACCOUNT', captures);
const classicFace = await buildFace('CLASSIC', captures);
const previousNet = process.env.NET_account;
process.env.NET_account = `http://127.0.0.1:${classicFace.server.address().port}`;
const classic = createClassicEntrypoint({
  notificationFile: join(evidenceRoot, 'classic-notifications.json'),
  notificationPollIntervalMs: 60_000,
});
const classicServer = await classic.listen(0);
classicFace.setClassic(classic);
captureHttp(classicServer, 'classic', captures);

const ready = {
  kind: 'a04-gate1-original-sdk-candidate-controls',
  candidateRevision,
  candidateRoot,
  node: process.version,
  accountPort: accountFace.server.address().port,
  classicPort: classicServer.address().port,
  productHashes: Object.fromEntries(productFiles.map((path) => [
    path,
    sha256(readFileSync(join(candidateRoot, path))),
  ])),
  account: {
    owner: publicActor(accountFace.owner),
    acceptGuest: publicActor(accountFace.acceptGuest),
    declineGuest: publicActor(accountFace.declineGuest),
    admin: publicActor(accountFace.admin),
    robotIdInvite: accountFace.robotIdInvite,
    robotIdClear: accountFace.robotIdClear,
    robotIdRemove: accountFace.robotIdRemove,
  },
  classic: {
    owner: publicActor(classicFace.owner),
    acceptGuest: publicActor(classicFace.acceptGuest),
    declineGuest: publicActor(classicFace.declineGuest),
    admin: publicActor(classicFace.admin),
    robotIdInvite: classicFace.robotIdInvite,
    robotIdClear: classicFace.robotIdClear,
    robotIdRemove: classicFace.robotIdRemove,
  },
  pid: process.pid,
};
writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`, { mode: 0o600 });
chmodSync(readyPath, 0o600);
console.log(JSON.stringify({
  readyPath,
  accountPort: ready.accountPort,
  classicPort: ready.classicPort,
  pid: process.pid,
}));

async function close(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function shutdown() {
  const snapshot = {
    capturedAt: new Date().toISOString(),
    candidateRevision,
    captures,
    account: {
      events: accountFace.events,
      loopUpdated: accountFace.loopUpdated,
      pending: accountFace.account.loopUpdatedOutbox.pending(),
    },
    classic: {
      events: classicFace.events,
      loopUpdated: classicFace.loopUpdated,
      pending: classicFace.account.loopUpdatedOutbox.pending(),
      classicNotifications: [...classic.hub.store.notifications.values()].map((row) => ({
        accountId: classic.hub.store.tokens.get(row.tokenId)?.accountId || null,
        skillId: row.skillId,
        payloadName: row.payload?.name || null,
      })),
    },
  };
  writeFileSync(capturesPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  await close(classicServer);
  await close(classicFace.server);
  await close(accountFace.server);
  if (previousNet === undefined) delete process.env.NET_account;
  else process.env.NET_account = previousNet;
}

process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
