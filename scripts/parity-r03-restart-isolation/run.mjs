#!/usr/bin/env node
// R-03 evidence lane: restart the real native full stack repeatedly, drive real WebSocket
// transactions for two synthetic accounts, inspect only harness-owned stores, and prove that
// a held listener makes the port-release check fail.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import { jwt, signSigV4 } from '@phoenix/common';
import { Store } from '../../packages/account/src/store.js';
import {
  CONTRACT_SERVICES,
  chooseOffset,
  gitDirty,
  gitRev,
  hermeticEnv,
  offsetPorts,
  parseLauncherPids,
  readJson,
  rebindAll,
  rebindFailureName,
  rebindPort,
  removePath,
  repo,
  sleep,
  spawnStack,
  stopStack,
  waitReady,
  writeJson,
} from './lib.mjs';

const DEFAULT_RUN_DIR = join(repo, '.parity', 'runs', 'r03-restart-isolation');
const DEFAULT_CYCLES = 5;
const TOKEN_SECRET = 'r03-loopback-token-secret';
const LLM_DELAY_MS = 250;
const SOCKET_TIMEOUT_MS = 8000;

function parseArgs(argv) {
  const args = {
    command: 'run',
    runDir: DEFAULT_RUN_DIR,
    offset: null,
    cycles: DEFAULT_CYCLES,
    timeoutMs: 60000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'run' || arg === 'falsify') args.command = arg;
    else if (arg === '--run-dir') args.runDir = resolve(argv[++i]);
    else if (arg === '--offset') args.offset = Number(argv[++i]);
    else if (arg === '--cycles') args.cycles = Number(argv[++i]);
    else if (arg === '--timeout') args.timeoutMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.cycles) || args.cycles < 1 || args.cycles > 20) throw new Error('--cycles must be 1..20');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 5000) throw new Error('--timeout must be >=5000 ms');
  if (args.offset !== null && !Number.isInteger(args.offset)) throw new Error('--offset must be an integer');
  const root = `${repo}${requirePathSep()}`;
  if (!args.runDir.startsWith(root)) throw new Error('--run-dir must stay inside this Phoenix worktree');
  return args;
}

function requirePathSep() {
  return process.platform === 'win32' ? '\\' : '/';
}

const IDENTITIES = Object.freeze([
  {
    key: 'a',
    accountId: 'r03-account-a',
    robotId: 'r03-robot-a',
    accessKeyId: 'R03FIXTUREKEYA',
    secretAccessKey: 'r03-fixture-secret-a',
    loopId: 'r03-loop-a',
    speaker: 'r03-speaker-a',
  },
  {
    key: 'b',
    accountId: 'r03-account-b',
    robotId: 'r03-robot-b',
    accessKeyId: 'R03FIXTUREKEYB',
    secretAccessKey: 'r03-fixture-secret-b',
    loopId: 'r03-loop-b',
    speaker: 'r03-speaker-b',
  },
]);

function identityToken(identity) {
  return jwt.sign({
    id: identity.accountId,
    friendlyId: identity.robotId,
    accessKeyId: identity.accessKeyId,
  }, TOKEN_SECRET);
}

function seedAccountStore(file) {
  const store = new Store(file);
  for (const identity of IDENTITIES) {
    store.accounts.set(identity.accountId, {
      _id: identity.accountId,
      email: `${identity.key}@r03.invalid`,
      friendlyId: identity.robotId,
      accessKeyId: identity.accessKeyId,
      secretAccessKey: identity.secretAccessKey,
      isActive: true,
      isDeleted: false,
    });
    store.loops.set(identity.loopId, {
      _id: identity.loopId,
      name: `${identity.robotId} loop`,
      owner: identity.accountId,
      robot: identity.accountId,
      members: [{ accountId: identity.accountId, status: 'ACCEPTED' }],
      isSuspended: false,
      created: Date.now(),
    });
  }
  store.flush();
}

function accountSnapshot(file) {
  const raw = readJson(file) || {};
  const rows = Array.isArray(raw.notificationOutbox) ? raw.notificationOutbox : [];
  const loops = Array.isArray(raw.loops) ? raw.loops : [];
  return {
    accountCount: Array.isArray(raw.accounts) ? raw.accounts.length : 0,
    loopCount: loops.length,
    loops: Object.fromEntries(loops.map((loop) => [loop._id, {
      robot: loop.robot,
      isSuspended: loop.isSuspended === true,
      updated: loop.updated ?? null,
    }])),
    outboxCount: rows.length,
    outbox: rows.map((row) => ({
      id: row._id,
      accountId: row.accountId,
      skillId: row.skillId,
      name: row.notification?.name ?? null,
      robot: row.notification?.payload?.robot ?? null,
      attempts: row.attempts ?? 0,
      lastError: row.lastError ?? null,
    })),
  };
}

function historySnapshot(file) {
  const raw = readJson(file) || {};
  return {
    launchCount: Array.isArray(raw.skillLaunches) ? raw.skillLaunches.length : 0,
    speechCount: Array.isArray(raw.speech) ? raw.speech.length : 0,
    launches: Array.isArray(raw.skillLaunches) ? raw.skillLaunches.map((row) => ({
      robotID: row.robotID,
      skillID: row.skillID,
      intent: row.intent,
      personIDs: row.personIDs,
      sessionID: row.sessionID,
    })) : [],
    speech: Array.isArray(raw.speech) ? raw.speech.map((row) => ({
      id: row.id,
      accountID: row.accountID,
      robotID: row.robotID,
      transID: row.transID,
      nluIntent: row.nlu?.intent ?? null,
      matchSkill: row.match?.skillID ?? null,
    })) : [],
  };
}

async function waitUntil(predicate, { timeoutMs = SOCKET_TIMEOUT_MS, intervalMs = 10, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function startLoopbackLlm() {
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body = null;
    try { body = JSON.parse(raw); } catch { /* the answer service will see a normal HTTP error */ }
    requests.push({
      at: Date.now(),
      path: request.url,
      body,
      transId: request.headers['x-jibo-transid'] ?? null,
      robotId: request.headers['x-jibo-robotid'] ?? null,
    });
    await sleep(LLM_DELAY_MS);
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      choices: [{ message: { content: 'R03 loopback answer.' } }],
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    async stop() {
      server.closeAllConnections?.();
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function contextFor(identity) {
  return {
    general: {
      accountID: identity.accountId,
      robotID: identity.robotId,
      lang: 'en-US',
      release: '2.0.1',
    },
    runtime: {
      perception: { speaker: identity.speaker, peoplePresent: [] },
      dialog: {},
      loop: { users: [{ id: `${identity.key}-loop-user`, firstName: `Fixture${identity.key.toUpperCase()}`, lastName: 'R03' }] },
    },
    skill: { id: null },
  };
}

function message(type, data, suffix) {
  return JSON.stringify({ type, msgID: `r03-${suffix}-${type}`, ts: Date.now(), data });
}

function sendTurn(robot, identity, suffix) {
  robot.ws.send(message('LISTEN', {
    lang: 'en-US',
    mode: 'CLIENT_NLU',
    hotphrase: false,
    rules: ['launch'],
  }, suffix));
  robot.ws.send(message('CONTEXT', contextFor(identity), suffix));
  robot.ws.send(message('CLIENT_NLU', {
    intent: 'generalWhoQuestions',
    rules: ['launch'],
    entities: { query: `synthetic ${identity.robotId} question` },
    external: {},
  }, suffix));
}

async function openRobot(hubPort, identity, transId) {
  const frames = [];
  let closed = false;
  let open = false;
  let openFailure = null;
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/v1/listen`, {
    headers: {
      Authorization: `Bearer ${identityToken(identity)}`,
      'x-jibo-transid': transId,
      'x-jibo-robotid': identity.robotId,
    },
  });
  const opened = new Promise((resolveOpen, rejectOpen) => {
    ws.once('open', () => { open = true; resolveOpen(); });
    ws.once('unexpected-response', (_request, response) => {
      const error = new Error(`WebSocket upgrade HTTP ${response.statusCode}`);
      openFailure = error;
      rejectOpen(error);
    });
    ws.once('error', (error) => {
      if (!open) {
        openFailure = error;
        rejectOpen(error);
      }
    });
  });
  ws.on('message', (encoded) => {
    try { frames.push(JSON.parse(encoded.toString())); } catch { frames.push({ type: 'INVALID_JSON' }); }
  });
  ws.on('close', () => { closed = true; });
  ws.on('error', () => { /* close/error is recorded by the state above */ });
  try {
    await opened;
  } catch (error) {
    ws.terminate();
    throw openFailure || error;
  }
  return {
    ws,
    frames,
    get closed() { return closed; },
    get open() { return open; },
  };
}

async function closeRobot(robot) {
  if (!robot || robot.closed) return;
  robot.ws.terminate();
  try { await waitUntil(() => robot.closed, { timeoutMs: 1000, label: 'robot socket close' }); } catch { /* best effort cleanup */ }
}

async function runTurn(hubPort, identity, transId, suffix) {
  const robot = await openRobot(hubPort, identity, transId);
  try {
    sendTurn(robot, identity, suffix);
    await waitUntil(() => robot.frames.some((frame) => frame.final === true), {
      label: `${transId} final frame`,
    });
    return {
      transId,
      identity: identity.key,
      frames: structuredClone(robot.frames),
      finalCount: robot.frames.filter((frame) => frame.final === true).length,
      closedBeforeFinal: false,
    };
  } finally {
    await closeRobot(robot);
  }
}

async function runPendingContext(hubPort, identity, transId) {
  const robot = await openRobot(hubPort, identity, transId);
  sendTurn(robot, identity, `pending-${identity.key}`);
  // Remove the final NLU message from the wire after the helper has sent the common turn: the
  // pending-context probe must leave the transaction waiting, not complete a normal turn.
  // The socket cannot unsend a frame, so this path is implemented explicitly below instead.
  await closeRobot(robot);
  throw new Error('internal pending probe misuse');
}

async function openPendingContext(hubPort, identity, transId) {
  const robot = await openRobot(hubPort, identity, transId);
  robot.ws.send(message('LISTEN', {
    lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'],
  }, 'pending'));
  robot.ws.send(message('CONTEXT', contextFor(identity), 'pending'));
  await waitUntil(() => robot.frames.some((frame) => frame.type === 'SOS'), {
    label: `${transId} SOS before pending context hold`,
  });
  await waitUntil(() => robot.frames.every((frame) => frame.final !== true), {
    label: `${transId} no final frame before restart`,
  });
  return robot;
}

async function runDisconnectingTurn(hubPort, identity, transId, suffix, loopback) {
  const robot = await openRobot(hubPort, identity, transId);
  try {
    sendTurn(robot, identity, suffix);
    await waitUntil(() => robot.frames.some((frame) => frame.type === 'LISTEN' && frame.final === false), {
      label: `${transId} non-final LISTEN`,
    });
    await waitUntil(() => loopback.requests.some((request) => request.body?.messages?.at(-1)?.content?.includes(identity.robotId)), {
      label: `${transId} in-flight loopback provider request`,
    });
    const framesBeforeDisconnect = structuredClone(robot.frames);
    await sleep(20);
    robot.ws.terminate();
    await waitUntil(() => robot.closed, { label: `${transId} disconnect` });
    await sleep(LLM_DELAY_MS + 100);
    return {
      transId,
      identity: identity.key,
      framesBeforeDisconnect,
      framesAfterDisconnect: structuredClone(robot.frames),
      finalCount: robot.frames.filter((frame) => frame.final === true).length,
      providerRequestObserved: true,
      closed: robot.closed,
    };
  } finally {
    await closeRobot(robot);
  }
}

function frameIdentityCheck(result, identity) {
  const listen = result.frames.find((frame) => frame.type === 'LISTEN');
  const action = result.frames.find((frame) => frame.type === 'SKILL_ACTION');
  return {
    finalCount: result.finalCount,
    sequence: result.frames.map((frame) => frame.type),
    skillMatch: listen?.data?.match?.skillID ?? null,
    actionSkill: action?.data?.skill?.id ?? null,
    expectedRobot: identity.robotId,
    passed: result.finalCount === 1
      && listen?.data?.match?.skillID === 'answer-skill'
      && action?.data?.skill?.id === 'answer-skill',
  };
}

function historyIdentityCheck(file, results) {
  const snapshot = historySnapshot(file);
  const rows = results.map((result) => {
    const identity = IDENTITIES.find((item) => item.key === result.identity);
    const speech = snapshot.speech.find((row) => row.transID === result.transId);
    const launch = snapshot.launches.find((row) => row.robotID === identity.robotId && row.intent === 'generalWhoQuestions');
    return {
      identity: identity.key,
      transId: result.transId,
      speech: speech ?? null,
      launch: launch ?? null,
      passed: speech?.accountID === identity.accountId
        && speech?.robotID === identity.robotId
        && speech?.transID === result.transId
        && launch?.robotID === identity.robotId,
    };
  });
  return { snapshot, rows, passed: rows.every((row) => row.passed) };
}

async function verifyAccount(accountPort, identity) {
  const response = await fetch(`http://127.0.0.1:${accountPort}/api/verify?accessKeyId=${encodeURIComponent(identity.accessKeyId)}`);
  let body = null;
  try { body = await response.json(); } catch { /* preserve status only */ }
  return { status: response.status, body };
}

async function signedSuspend(accountPort, identity) {
  const body = JSON.stringify({ loopId: identity.loopId });
  const host = `127.0.0.1:${accountPort}`;
  const signed = signSigV4({
    method: 'POST',
    path: '/',
    body,
    headers: {
      Host: host,
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'Loop_20160324.SuspendLoop',
    },
    accessKeyId: identity.accessKeyId,
    secretAccessKey: identity.secretAccessKey,
    region: 'global',
    service: 'jibo',
    date: new Date(),
  });
  const response = await fetch(`http://${host}/`, {
    method: 'POST',
    headers: signed.headers,
    body,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep raw */ }
  return { status: response.status, body: parsed, raw: text };
}

async function falsifyHeldListener(ports, runDir) {
  const port = ports.hub;
  const holder = createServer();
  let holderReady = false;
  try {
    holder.listen({ port, host: '0.0.0.0', exclusive: true });
    await once(holder, 'listening');
    holderReady = true;
    let detected;
    try {
      await rebindPort(port);
      detected = { failed: false, error: null };
    } catch (error) {
      detected = { failed: true, error: rebindFailureName(error), message: error.message };
    }
    await new Promise((resolveClose) => holder.close(() => resolveClose()));
    let restored = false;
    try { await rebindPort(port); restored = true; } catch { restored = false; }
    const result = {
      mode: 'held-listener',
      port,
      holderReady,
      detected,
      restored,
      passed: holderReady && detected.failed && detected.error === 'EADDRINUSE' && restored,
    };
    writeJson(join(runDir, 'falsification.json'), result);
    return result;
  } catch (error) {
    try { holder.close(); } catch { /* already closed */ }
    const result = { mode: 'held-listener', port, holderReady, error: error.message, passed: false };
    writeJson(join(runDir, 'falsification.json'), result);
    return result;
  }
}

function check(failures, name, passed, detail) {
  if (!passed) failures.push({ name, detail });
  return passed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  removePath(args.runDir);
  mkdirSync(args.runDir, { recursive: true, mode: 0o700 });
  const stateDir = join(args.runDir, 'state');
  const logsDir = join(args.runDir, 'logs');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });

  const failures = [];
  const cycles = [];
  const probes = {
    cycle1Turns: [],
    cycle2Accounts: [],
    cycle3Pending: null,
    cycle4Disconnect: null,
    cycle5Accounts: null,
  };
  let stack = null;
  let loopback = null;
  let offsetChoice;
  let ports;
  let env;
  let accountFile;
  let historyFile;
  let activePending = null;

  const receipt = {
    schemaVersion: 1,
    task: 'R-03',
    lane: 'repeated-restarts-persistence-cross-robot-isolation',
    referenceRevision: '5c0a7390539663ba749d360de348a428c088505c',
    phoenixRevision: gitRev(),
    dirtyAtStart: gitDirty(),
    startedAt,
    command: process.argv.slice(2),
    configuration: {
      runDir: args.runDir,
      cyclesRequested: args.cycles,
      timeoutMs: args.timeoutMs,
      storesTemporary: true,
      envFile: '/dev/null',
      auth: 'JWT + temporary account store; two synthetic accounts',
      fullStack: 'scripts/run-compose-stack.sh --no-env',
    },
    cycles,
    measurements: {},
    falsification: null,
    failures,
  };

  try {
    if (args.command === 'falsify') {
      offsetChoice = args.offset === null ? await chooseOffset() : { ok: true, offset: args.offset, ports: offsetPorts(args.offset) };
      if (!offsetChoice.ok) throw new Error(`no offset: ${JSON.stringify(offsetChoice.rejected)}`);
      ports = offsetChoice.ports || offsetPorts(offsetChoice.offset);
      receipt.configuration.offset = offsetChoice.offset;
      receipt.falsification = await falsifyHeldListener(ports, args.runDir);
      receipt.ok = receipt.falsification.passed;
      receipt.finishedAt = new Date().toISOString();
      writeJson(join(args.runDir, 'receipt.json'), receipt);
      console.log(JSON.stringify({ output: join(args.runDir, 'receipt.json'), ok: receipt.ok, mode: 'falsify' }));
      process.exit(receipt.ok ? 0 : 1);
    }

    offsetChoice = args.offset === null
      ? await chooseOffset()
      : { ok: true, offset: args.offset, ports: offsetPorts(args.offset), rejected: [] };
    if (!offsetChoice.ok) throw new Error(`no free temporary port range: ${JSON.stringify(offsetChoice.rejected)}`);
    ports = offsetChoice.ports || offsetPorts(offsetChoice.offset);
    receipt.configuration.offset = offsetChoice.offset;
    receipt.configuration.ports = ports;

    loopback = await startLoopbackLlm();
    accountFile = join(args.runDir, 'stores', 'account.json');
    historyFile = join(args.runDir, 'stores', 'history.json');
    seedAccountStore(accountFile);
    env = hermeticEnv({
      home: join(args.runDir, 'home'),
      runDir: args.runDir,
      offset: offsetChoice.offset,
      ports,
      llmUrl: loopback.url,
      tokenSecret: TOKEN_SECRET,
    });

    for (let cycle = 1; cycle <= args.cycles; cycle += 1) {
      const cycleResult = { cycle, start: null, readiness: null, checks: {}, stop: null, portRebind: null };
      const startMs = Date.now();
      stack = spawnStack({ env, logPath: join(logsDir, `cycle-${cycle}.log`) });
      cycleResult.start = { launcherPid: stack.child.pid, elapsedMs: null };
      const readiness = await waitReady(ports, { timeoutMs: args.timeoutMs, startMs });
      cycleResult.start.elapsedMs = Date.now() - startMs;
      cycleResult.readiness = readiness;
      if (!readiness.ok) {
        check(failures, `cycle-${cycle}/readiness`, false, {
          timedOut: readiness.timedOut,
          launcher: stack.stdout.slice(-2000),
          stderr: stack.stderr.slice(-2000),
        });
      }

      if (readiness.ok && cycle === 1) {
        try {
          const turns = await Promise.all(IDENTITIES.map((identity) => runTurn(
            ports.hub, identity, `r03-cycle-${cycle}-${identity.key}`, `cycle-${cycle}`,
          )));
          probes.cycle1Turns = turns;
          const frameChecks = turns.map((turn) => frameIdentityCheck(turn, IDENTITIES.find((identity) => identity.key === turn.identity)));
          cycleResult.checks.concurrentTurns = frameChecks;
          check(failures, 'cycle-1/concurrent-cross-account-turns', frameChecks.every((row) => row.passed), frameChecks);
          await waitUntil(() => historySnapshot(historyFile).speechCount >= 2, {
            timeoutMs: 5000,
            label: 'cycle-1 history rows',
          });
          const identityCheck = historyIdentityCheck(historyFile, turns);
          cycleResult.checks.historyIsolation = identityCheck;
          check(failures, 'cycle-1/history-account-robot-isolation', identityCheck.passed, identityCheck);
        } catch (error) {
          check(failures, 'cycle-1/concurrent-cross-account-turns', false, error.message);
        }
        try {
          const suspend = await signedSuspend(ports.account, IDENTITIES[0]);
          const after = accountSnapshot(accountFile);
          cycleResult.checks.outboxAfterA = { suspend, store: after };
          check(failures, 'cycle-1/account-suspend-A', suspend.status === 200 && after.loops[IDENTITIES[0].loopId]?.isSuspended === true, cycleResult.checks.outboxAfterA);
          check(failures, 'cycle-1/outbox-row-retained-before-stop', after.outboxCount === 1 && after.outbox[0]?.accountId === IDENTITIES[0].accountId && after.outbox[0]?.attempts === 0, after);
        } catch (error) {
          check(failures, 'cycle-1/account-suspend-A', false, error.message);
        }
      }

      if (readiness.ok && cycle === 2) {
        try {
          const accounts = await Promise.all(IDENTITIES.map((identity) => verifyAccount(ports.account, identity)));
          const afterRestart = accountSnapshot(accountFile);
          probes.cycle2Accounts = { accounts, store: afterRestart };
          cycleResult.checks.persistenceAfterRestart = probes.cycle2Accounts;
          check(failures, 'cycle-2/account-identities-survive-restart', accounts.every((row, index) => row.status === 200 && row.body?.valid === true && row.body?.friendlyId === IDENTITIES[index].robotId), accounts);
          check(failures, 'cycle-2/outbox-A-survives-restart', afterRestart.outboxCount === 1 && afterRestart.outbox[0]?.accountId === IDENTITIES[0].accountId, afterRestart);
          const turn = await runTurn(ports.hub, IDENTITIES[0], 'r03-cycle-2-a', 'cycle-2');
          cycleResult.checks.postRestartTurn = frameIdentityCheck(turn, IDENTITIES[0]);
          check(failures, 'cycle-2/post-restart-A-turn', cycleResult.checks.postRestartTurn.passed, cycleResult.checks.postRestartTurn);
          await waitUntil(() => historySnapshot(historyFile).speech.some((row) => row.transID === turn.transId), {
            timeoutMs: 5000,
            label: 'cycle-2 post-restart history row',
          });
          const suspendB = await signedSuspend(ports.account, IDENTITIES[1]);
          const afterB = accountSnapshot(accountFile);
          cycleResult.checks.outboxAfterB = { suspend: suspendB, store: afterB };
          check(failures, 'cycle-2/account-suspend-B', suspendB.status === 200 && afterB.loops[IDENTITIES[1].loopId]?.isSuspended === true, cycleResult.checks.outboxAfterB);
          check(failures, 'cycle-2/two-account-outbox-rows', afterB.outboxCount === 2 && new Set(afterB.outbox.map((row) => row.accountId)).size === 2, afterB);
        } catch (error) {
          check(failures, 'cycle-2/persistence-and-outbox', false, error.message);
        }
      }

      if (readiness.ok && cycle === 3) {
        try {
          const before = accountSnapshot(accountFile);
          activePending = await openPendingContext(ports.hub, IDENTITIES[0], 'r03-pending-context-before-restart');
          probes.cycle3Pending = { before, framesBeforeStop: structuredClone(activePending.frames) };
          cycleResult.checks.pendingContextBeforeStop = probes.cycle3Pending;
          check(failures, 'cycle-3/pending-context-is-observable', activePending.frames.some((frame) => frame.type === 'SOS') && activePending.frames.every((frame) => frame.final !== true), probes.cycle3Pending);
        } catch (error) {
          check(failures, 'cycle-3/pending-context-is-observable', false, error.message);
        }
      }

      if (readiness.ok && cycle === 4) {
        try {
          const bTurnPromise = runTurn(ports.hub, IDENTITIES[1], 'r03-cycle-4-b', 'cycle-4-b');
          const aDisconnectPromise = runDisconnectingTurn(ports.hub, IDENTITIES[0], 'r03-cycle-4-a-disconnect', 'cycle-4-a', loopback);
          const [bTurn, aDisconnect] = await Promise.all([bTurnPromise, aDisconnectPromise]);
          const bFrameCheck = frameIdentityCheck(bTurn, IDENTITIES[1]);
          probes.cycle4Disconnect = { bTurn, bFrameCheck, aDisconnect };
          cycleResult.checks.disconnectIsolation = probes.cycle4Disconnect;
          check(failures, 'cycle-4/B-completes-while-A-disconnects', bFrameCheck.passed && aDisconnect.providerRequestObserved && aDisconnect.closed && aDisconnect.finalCount === 0, probes.cycle4Disconnect);
          await waitUntil(() => historySnapshot(historyFile).speech.some((row) => row.transID === bTurn.transId), {
            timeoutMs: 5000,
            label: 'cycle-4 B history row',
          });
          const rows = historyIdentityCheck(historyFile, [bTurn]);
          cycleResult.checks.disconnectHistory = rows;
          check(failures, 'cycle-4/B-history-is-not-A', rows.passed, rows);
        } catch (error) {
          check(failures, 'cycle-4/B-completes-while-A-disconnects', false, error.message);
        }
      }

      if (readiness.ok && cycle === 5) {
        try {
          const accounts = await Promise.all(IDENTITIES.map((identity) => verifyAccount(ports.account, identity)));
          const store = accountSnapshot(accountFile);
          probes.cycle5Accounts = { accounts, store };
          cycleResult.checks.finalPersistence = probes.cycle5Accounts;
          check(failures, 'cycle-5/account-identities-still-isolated', accounts.every((row, index) => row.status === 200 && row.body?.friendlyId === IDENTITIES[index].robotId), accounts);
          check(failures, 'cycle-5/outbox-rows-not-dropped', store.outboxCount === 2 && store.outbox.every((row) => row.attempts === 0), store);
        } catch (error) {
          check(failures, 'cycle-5/final-persistence', false, error.message);
        }
      }

      if (activePending) {
        // Keep this socket open across the actual process stop; a new process must not be able to
        // complete it. stopStack below kills the old process and the socket then closes.
      }
      const stopStarted = Date.now();
      const stopResult = await stopStack(stack);
      stack = null;
      if (activePending) {
        try { await waitUntil(() => activePending.closed, { timeoutMs: 3000, label: 'pending socket close after process stop' }); } catch { /* recorded below */ }
        await sleep(250);
        const pendingAfterStop = {
          closedAfterStop: activePending.closed,
          framesAfterStop: structuredClone(activePending.frames),
          finalCountAfterStop: activePending.frames.filter((frame) => frame.final === true).length,
        };
        cycleResult.checks.pendingContextAfterStop = pendingAfterStop;
        probes.cycle3Pending.afterStop = pendingAfterStop;
        check(failures, 'cycle-3/pending-context-does-not-survive-process-stop', pendingAfterStop.closedAfterStop && pendingAfterStop.finalCountAfterStop === 0, pendingAfterStop);
        await closeRobot(activePending);
        activePending = null;
      }
      cycleResult.stop = {
        elapsedMs: Date.now() - stopStarted,
        code: stopResult.code,
        signal: stopResult.signal,
        launcherPids: stopResult.launcherPids,
        exits: parseLauncherPids(stopResult.stdout).exits,
      };
      check(failures, `cycle-${cycle}/launcher-stop`, stopResult.code !== 'timeout' && stopResult.code !== 'kill-timeout', cycleResult.stop);
      const rebind = await rebindAll(ports);
      cycleResult.portRebind = {
        attempted: Object.keys(rebind).length,
        passed: Object.values(rebind).filter((row) => row.ok).length,
        failed: Object.entries(rebind).filter(([, row]) => !row.ok).map(([name, row]) => ({ name, ...row })),
        rows: rebind,
      };
      check(failures, `cycle-${cycle}/all-ports-immediately-rebindable`, cycleResult.portRebind.passed === CONTRACT_SERVICES.length, cycleResult.portRebind);
      cycles.push(cycleResult);
      if (!readiness.ok) break;
    }

    receipt.falsification = await falsifyHeldListener(ports, args.runDir);
    check(failures, 'falsification/held-listener-detected', receipt.falsification.passed === true, receipt.falsification);
  } catch (error) {
    failures.push({ name: 'harness-aborted', detail: error.stack || error.message });
  } finally {
    if (activePending) await closeRobot(activePending);
    if (stack) {
      try { await stopStack(stack); } catch { /* best effort */ }
      stack = null;
    }
    if (loopback) {
      try { await loopback.stop(); } catch { /* best effort */ }
    }
  }

  const completedCycles = cycles.length;
  const rebindRows = cycles.flatMap((cycle) => Object.values(cycle.portRebind?.rows || {}));
  const outboxFinal = accountFile ? accountSnapshot(accountFile) : null;
  const historyFinal = historyFile ? historySnapshot(historyFile) : null;
  receipt.measurements = {
    restartCyclesRequested: args.cycles,
    restartCyclesCompleted: completedCycles,
    starts: completedCycles,
    stops: completedCycles,
    portRebind: {
      portsPerCycle: CONTRACT_SERVICES.length,
      attempts: rebindRows.length,
      passed: rebindRows.filter((row) => row.ok).length,
      failures: rebindRows.filter((row) => !row.ok),
      elapsedMs: rebindRows.filter((row) => row.ok).map((row) => row.elapsedMs),
    },
    persistence: {
      temporaryAccountStore: accountFile ? accountFile.startsWith(args.runDir) : false,
      accountStoreAfterFinalRestart: outboxFinal,
      identitiesVerified: probes.cycle2Accounts?.accounts ?? [],
      finalIdentitiesVerified: probes.cycle5Accounts?.accounts ?? [],
    },
    stateLeakage: {
      pendingContext: probes.cycle3Pending,
      observableCheck: 'old WebSocket closed with no final frame after its process was stopped; a fresh process then served only fresh transIds',
      inFlightAsr: 'not measured: this lane used CLIENT_NLU and did not claim server-side microphone/Parakeet continuity',
    },
    crossRobotIsolation: {
      concurrentTurns: probes.cycle1Turns.map((turn) => ({ transId: turn.transId, identity: turn.identity, frames: turn.frames.map((frame) => frame.type) })),
      disconnectScenario: probes.cycle4Disconnect,
      historyStoreAfterFinalRestart: historyFinal,
    },
    queue: {
      implementationPathMeasured: 'account notificationOutbox rows written by real Loop.SuspendLoop HTTP calls',
      final: outboxFinal,
      conclusion: outboxFinal?.outboxCount === 2 && outboxFinal.outbox.every((row) => row.attempts === 0 && row.lastError === null)
        ? 'two rows for two accounts remained durable with zero attempts and no silent drop; no notification publisher was configured in this native stack'
        : 'not established',
    },
    loopbackProviderRequests: loopback?.requests.length ?? null,
  };
  receipt.completedAt = new Date().toISOString();
  receipt.ok = failures.length === 0 && completedCycles === args.cycles && receipt.falsification?.passed === true;
  writeJson(join(args.runDir, 'receipt.json'), receipt);
  console.log(JSON.stringify({
    output: join(args.runDir, 'receipt.json'),
    ok: receipt.ok,
    restartCycles: completedCycles,
    rebind: `${receipt.measurements.portRebind.passed}/${receipt.measurements.portRebind.attempts}`,
    failures: failures.length,
    falsification: receipt.falsification?.passed === true,
  }));
  process.exit(receipt.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
