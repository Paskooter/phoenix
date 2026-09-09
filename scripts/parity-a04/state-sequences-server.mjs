import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const candidateRoot = process.env.CANDIDATE_ROOT
  || '/home/shell/work/phoenix/.parity/worktrees/a04-auth-deployment-20260911';
const evidenceRoot = process.env.EVIDENCE_ROOT
  || join(candidateRoot, '.parity/reviews/a04-auth-deployment-20260911');
const candidateRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: candidateRoot, encoding: 'utf8',
}).trim();
const readyPath = join(evidenceRoot, 'server-ready.json');
const restartReadyPath = join(evidenceRoot, 'restart-ready.json');
const capturesPath = join(evidenceRoot, 'server-captures.json');
const preRestartPath = join(evidenceRoot, 'pre-restart.json');
const postRestartPath = join(evidenceRoot, 'post-restart.json');
const productFiles = [
  'packages/account/src/loopMembership.js',
  'packages/account/src/membershipEvents.js',
  'packages/account/src/loopUpdatedOutbox.js',
  'packages/account/src/loopCreation.js',
  'packages/account/src/invitationDeployment.js',
  'packages/account/src/loopAgreements.js',
  'packages/account/src/robotFace.js',
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
    firstName: actor.firstName,
    lastName: actor.lastName,
  };
}

function listenTcp(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function smtpFixture() {
  const messages = [];
  const server = createNetServer((socket) => {
    let buffer = '';
    let dataMode = false;
    let message = '';
    const reply = (line) => socket.write(`${line}\r\n`);
    reply('220 fixture.smtp ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        message += buffer.slice(0, end);
        buffer = buffer.slice(end + 5);
        dataMode = false;
        messages.push(message);
        message = '';
        reply('250 queued');
      }
      while (!dataMode) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) reply('250-fixture.smtp\r\n250 OK');
        else if (upper.startsWith('MAIL FROM') || upper.startsWith('RCPT TO')) reply('250 OK');
        else if (upper === 'DATA') {
          dataMode = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
          return;
        } else if (upper === 'QUIT') reply('221 Bye');
        else reply('250 OK');
      }
    });
  });
  return { server, messages };
}

function eventFixture() {
  const events = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      events.push({
        method: req.method,
        path: req.url,
        headers: { ...req.headers },
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));
    });
  });
  return { server, events };
}

function loopSnapshot(store) {
  return [...store.loops.values()].map((loop) => ({
    id: loop._id,
    name: loop.name || null,
    owner: loop.owner || null,
    robot: loop.robot || null,
    isDeleted: loop.isDeleted === true,
    isSuspended: loop.isSuspended === true,
    members: (loop.members || []).map((member) => ({
      id: member._id || member.id || null,
      accountId: member.accountId || null,
      status: member.status || null,
      isChild: !!(member.memberProperties && member.memberProperties.isChild),
      agreementId: member.agreementId || null,
      legalGuardianId: member.legalGuardianId || null,
    })),
  }));
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function listenPreferred(service, preferredPort) {
  if (!preferredPort) return service.listen(0);
  return new Promise((resolve, reject) => {
    const server = service.server;
    const onError = (error) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        service.listen(0).then(resolve, reject);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(preferredPort);
  });
}

const smtp = smtpFixture();
const eventSink = eventFixture();
const smtpPort = await listenTcp(smtp.server);
const eventPort = await listenTcp(eventSink.server);
const agreementIds = new Set();
const agreementProvider = {
  async refreshToken() {},
  async send() {
    const id = `synthetic-agreement-${agreementIds.size + 1}`;
    agreementIds.add(id);
    return id;
  },
  async isSigned(id) {
    return agreementIds.has(id);
  },
};

const transports = {
  kind: 'configured-local-smtp-http',
  smtpHost: '127.0.0.1',
  smtpPort,
  mailFrom: 'local-sender@synthetic.invalid',
  portalUrl: 'http://portal.synthetic.invalid',
  eventUrl: `http://127.0.0.1:${eventPort}/events`,
};

async function buildFace(label, captures, { storeFile, eventFile, preferredPort } = {}) {
  const lower = label.toLowerCase();
  const file = storeFile || join(evidenceRoot, `${lower}-store.json`);
  const store = new Store(file);
  if (store.accounts.size === 0) {
    const owner = createOwnerAccount(store, {
      email: `${lower}-owner@synthetic.invalid`,
      password: 'fixture-password',
      firstName: `${label} Owner`,
      lastName: 'Owner',
    });
    createOwnerAccount(store, {
      email: `${lower}-accept@synthetic.invalid`,
      password: 'fixture-password',
      firstName: `${label} Accept`,
      lastName: 'Guest',
    });
    createOwnerAccount(store, {
      email: `${lower}-decline@synthetic.invalid`,
      password: 'fixture-password',
      firstName: `${label} Decline`,
      lastName: 'Guest',
    });
    const admin = createOwnerAccount(store, {
      email: `${lower}-admin@synthetic.invalid`,
      password: 'fixture-password',
      firstName: `${label} Admin`,
      lastName: 'Admin',
    });
    admin.isAdmin = true;
    store.flush();
    void owner;
  }

  const events = [];
  const loopUpdated = [];
  let classic = null;
  const robotReadClient = {
    async getRobot(friendlyId) { return { payload: { suspended: false, friendlyId } }; },
  };

  const account = createAccountService({
    store,
    agreementProvider,
    robotReadClient,
    invitationProviders: { portalUrl: transports.portalUrl },
    invitationSmtp: {
      host: transports.smtpHost,
      port: transports.smtpPort,
      ignoreTLS: true,
    },
    invitationMailFrom: transports.mailFrom,
    invitationEventFile: eventFile || join(evidenceRoot, `${lower}-invitation-events.json`),
    invitationEventUrl: transports.eventUrl,
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

  const sender = account.invitationProviders?.eventSender;
  if (sender && typeof sender.send === 'function') {
    const originalSend = sender.send.bind(sender);
    sender.send = function send(event) {
      events.push({
        eventKey: event.payload?.eventKey || event.constructor?.name,
        payload: { ...(event.payload || {}) },
      });
      return originalSend(event);
    };
  }

  const server = await listenPreferred(account, preferredPort);
  captureHttp(server, `${lower}-account`, captures);
  const owner = [...store.accounts.values()].find((row) => row.email === `${lower}-owner@synthetic.invalid`);
  const acceptGuest = [...store.accounts.values()].find((row) => row.email === `${lower}-accept@synthetic.invalid`);
  const declineGuest = [...store.accounts.values()].find((row) => row.email === `${lower}-decline@synthetic.invalid`);
  const admin = [...store.accounts.values()].find((row) => row.email === `${lower}-admin@synthetic.invalid`);
  return {
    label,
    storeFile: file,
    eventFile: eventFile || join(evidenceRoot, `${lower}-invitation-events.json`),
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
let accountFace = await buildFace('ACCOUNT', captures);
let classicFace = await buildFace('CLASSIC', captures);
const previousNet = process.env.NET_account;
process.env.NET_account = `http://127.0.0.1:${classicFace.server.address().port}`;
let classic = createClassicEntrypoint({
  notificationFile: join(evidenceRoot, 'classic-notifications.json'),
  notificationPollIntervalMs: 60_000,
});
let classicServer = await classic.listen(0);
classicFace.setClassic(classic);
captureHttp(classicServer, 'classic', captures);

function readyPayload(kind, extra = {}) {
  return {
    kind,
    candidateRevision,
    candidateRoot,
    node: process.version,
    accountPort: accountFace.server.address().port,
    classicPort: classicServer.address().port,
    transports,
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
    ...extra,
  };
}

function writeReady(path, payload) {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const initialReady = readyPayload('a04-gate6-original-sdk-candidate-controls', { restartCount: 0 });
writeReady(readyPath, initialReady);
console.log(JSON.stringify({
  readyPath,
  accountPort: initialReady.accountPort,
  classicPort: initialReady.classicPort,
  smtpPort,
  eventPort,
  pid: process.pid,
}));

async function drainFace(face) {
  await new Promise((resolve) => setImmediate(resolve));
  if (face.account?.loopUpdatedOutbox?.drain) await face.account.loopUpdatedOutbox.drain();
  const sender = face.account?.invitationProviders?.eventSender;
  if (sender?.drain) await sender.drain();
  face.store.flush();
}

function faceState(face, extra = {}) {
  return {
    events: face.events,
    loopUpdated: face.loopUpdated,
    pending: face.account.loopUpdatedOutbox.pending(),
    loops: loopSnapshot(face.store),
    invitationPending: face.account.invitationProviders?.eventSender?.pending?.() || [],
    ...extra,
  };
}

function transportState() {
  return {
    smtpMessages: smtp.messages.length,
    httpEvents: eventSink.events.length,
    smtpFrom: smtp.messages.map((message) => {
      const match = /^From: ([^\r\n]+)/m.exec(message);
      return match ? match[1] : null;
    }),
    eventKeys: eventSink.events.map((row) => row.headers['x-phoenix-event-key'] || null),
  };
}

let restartCount = 0;
let restarting = false;

async function restartServices() {
  if (restarting) return;
  restarting = true;
  const accountPort = accountFace.server.address().port;
  const classicAccountPort = classicFace.server.address().port;
  const classicPort = classicServer.address().port;
  await drainFace(accountFace);
  await drainFace(classicFace);
  const pre = {
    capturedAt: new Date().toISOString(),
    candidateRevision,
    restartCount,
    transports,
    transport: transportState(),
    account: faceState(accountFace),
    classic: faceState(classicFace, {
      classicNotifications: [...classic.hub.store.notifications.values()].map((row) => ({
        accountId: classic.hub.store.tokens.get(row.tokenId)?.accountId || null,
        skillId: row.skillId,
        payloadName: row.payload?.name || null,
      })),
    }),
    captureCount: captures.length,
    captures: captures.slice(),
  };
  writeFileSync(preRestartPath, `${JSON.stringify(pre, null, 2)}\n`, { mode: 0o600 });

  await closeServer(classicServer);
  await closeServer(classicFace.server);
  await closeServer(accountFace.server);
  await new Promise((resolve) => setTimeout(resolve, 150));

  const previousAccountEvents = accountFace.events;
  const previousAccountUpdated = accountFace.loopUpdated;
  const previousClassicEvents = classicFace.events;
  const previousClassicUpdated = classicFace.loopUpdated;

  accountFace = await buildFace('ACCOUNT', captures, {
    storeFile: accountFace.storeFile,
    eventFile: accountFace.eventFile,
    preferredPort: accountPort,
  });
  accountFace.events.push(...previousAccountEvents);
  accountFace.loopUpdated.push(...previousAccountUpdated);

  classicFace = await buildFace('CLASSIC', captures, {
    storeFile: classicFace.storeFile,
    eventFile: classicFace.eventFile,
    preferredPort: classicAccountPort,
  });
  classicFace.events.push(...previousClassicEvents);
  classicFace.loopUpdated.push(...previousClassicUpdated);

  process.env.NET_account = `http://127.0.0.1:${classicFace.server.address().port}`;
  classic = createClassicEntrypoint({
    notificationFile: join(evidenceRoot, 'classic-notifications.json'),
    notificationPollIntervalMs: 60_000,
  });
  classicServer = await listenPreferred(classic, classicPort);
  classicFace.setClassic(classic);
  captureHttp(classicServer, 'classic', captures);
  restartCount += 1;
  const ready = readyPayload('a04-gate6-post-restart-sdk-candidate-controls', { restartCount });
  writeReady(readyPath, ready);
  writeReady(restartReadyPath, ready);
  restarting = false;
  console.log(JSON.stringify({
    restarted: true,
    restartCount,
    accountPort: ready.accountPort,
    classicPort: ready.classicPort,
  }));
}

async function shutdown() {
  await drainFace(accountFace);
  await drainFace(classicFace);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    candidateRevision,
    restartCount,
    transports,
    transport: transportState(),
    captures,
    account: faceState(accountFace),
    classic: faceState(classicFace, {
      classicNotifications: [...classic.hub.store.notifications.values()].map((row) => ({
        accountId: classic.hub.store.tokens.get(row.tokenId)?.accountId || null,
        skillId: row.skillId,
        payloadName: row.payload?.name || null,
      })),
    }),
  };
  writeFileSync(capturesPath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(postRestartPath, `${JSON.stringify({
    capturedAt: snapshot.capturedAt,
    candidateRevision,
    restartCount,
    transports,
    transport: snapshot.transport,
    account: snapshot.account,
    classic: snapshot.classic,
  }, null, 2)}\n`, { mode: 0o600 });
  await closeServer(classicServer);
  await closeServer(classicFace.server);
  await closeServer(accountFace.server);
  await closeServer(smtp.server);
  await closeServer(eventSink.server);
  if (previousNet === undefined) delete process.env.NET_account;
  else process.env.NET_account = previousNet;
}

process.on('SIGUSR1', () => {
  restartServices().catch((error) => {
    console.error(error && error.stack || error);
    process.exit(1);
  });
});
process.on('SIGTERM', () => { shutdown().then(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown().then(() => process.exit(0)); });
