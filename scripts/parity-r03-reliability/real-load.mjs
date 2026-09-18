// R-03 evidence lane: real gateway WebSockets + local HTTP parser/skill peers.
// This is a bounded measurement harness, not a release-wide performance claim.
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { jwt } from '@phoenix/common';
import { Timeouts } from '@phoenix/contracts';
import { createGateway } from '../../packages/gateway/src/index.js';
import { ListenTransaction } from '../../packages/gateway/src/listenTransaction.js';
import { AUDIO_DECODER_LIMITS, AUDIO_ENCODINGS, AudioDecodeError, StreamingAudioDecoder } from '../../packages/gateway/src/asr/audioDecoder.js';

const SECRET = 'r03-local-synthetic-secret';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sabotage = process.env.R03_SABOTAGE || '';

function percentile(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, p50: rank(50), p95: rank(95), max: sorted.at(-1) };
}

function tokenFor(id) {
  return jwt.sign({ id: `account-${id}`, friendlyId: `robot-${id}` }, SECRET);
}

function contextFrame(id) {
  return {
    type: 'CONTEXT',
    msgID: `context-${id}`,
    ts: Date.now(),
    data: {
      general: { accountID: `account-${id}`, robotID: `robot-${id}`, lang: 'en-US', release: '2.0.1' },
      runtime: { loop: { users: [] }, dialog: {} },
      skill: {},
    },
  };
}

function listenClientAsr(id) {
  return {
    type: 'LISTEN',
    msgID: `listen-${id}`,
    ts: Date.now(),
    data: { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules: ['launch'] },
  };
}

function clientAsr(id) {
  return {
    type: 'CLIENT_ASR',
    msgID: `asr-${id}`,
    ts: Date.now(),
    data: { text: `synthetic-${id}` },
  };
}

function listenServerAsr(id) {
  return {
    type: 'LISTEN',
    msgID: `listen-${id}`,
    ts: Date.now(),
    data: { lang: 'en-US', hotphrase: false, rules: ['launch'] },
  };
}

function createHttpPeer(name, { delayMs = 2, response }) {
  let mode = 'fast';
  let responseDelayMs = delayMs;
  let sequence = 0;
  let sabotageUsed = false;
  const pending = new Map();
  const records = [];
  const counters = { total: 0, settled: 0, success: 0, failures: 0, active: 0, maxActive: 0 };

  function reset() {
    assert.equal(pending.size, 0, `${name} peer has no released requests before reset`);
    records.length = 0;
    for (const key of Object.keys(counters)) counters[key] = 0;
  }

  function stats() {
    return {
      ...counters,
      pending: pending.size,
      records: records.map((record) => ({ ...record })),
    };
  }

  function releaseAll() {
    for (const request of [...pending.values()]) request.finish();
  }

  const server = http.createServer(async (req, res) => {
    const id = `${name}-${sequence++}`;
    const trace = {
      transId: String(req.headers['x-jibo-transid'] ?? ''),
      robotId: String(req.headers['x-jibo-robotid'] ?? ''),
      loggingConfig: String(req.headers['x-jibo-logging-config'] ?? ''),
    };
    const record = { id, ...trace, startedAt: performance.now(), status: null, settledAt: null };
    records.push(record);
    counters.total += 1;
    counters.active += 1;
    counters.maxActive = Math.max(counters.maxActive, counters.active);
    let done = false;
    const settle = (status, body) => {
      if (done) return;
      done = true;
      pending.delete(id);
      counters.active -= 1;
      counters.settled += 1;
      if (status >= 200 && status < 300) counters.success += 1;
      else counters.failures += 1;
      record.status = status;
      record.settledAt = performance.now();
      if (!res.writableEnded) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }
    };
    res.on('close', () => {
      // A timeout probe deliberately keeps this response pending. If the client
      // aborts it, do not leave the peer's active count or pending map lying.
      if (!done && res.destroyed) settle(499, { message: 'client closed' });
    });

    // Drain the real HTTP request body. We retain headers and timings only, not
    // transcript/context payloads, so the evidence file contains no household data.
    for await (const _chunk of req) { /* measured transport only */ }

    const body = response();
    if (mode === 'hang') {
      pending.set(id, { finish: () => settle(200, body) });
      return;
    }
    if (mode === 'fail') {
      setTimeout(() => settle(503, { message: `${name} synthetic outage` }), responseDelayMs);
      return;
    }
    let output = body;
    if (sabotage === 'wrong-skill-type' && name === 'skill' && !sabotageUsed) {
      sabotageUsed = true;
      output = { ...body, type: 'SABOTAGED_NOT_SKILL_ACTION' };
    }
    setTimeout(() => settle(200, output), responseDelayMs);
  });

  return {
    name,
    server,
    setMode(value) { assert.ok(['fast', 'hang', 'fail'].includes(value)); mode = value; },
    setDelay(value) { assert.ok(Number.isFinite(value) && value >= 0); responseDelayMs = value; },
    reset,
    releaseAll,
    stats,
    async listen() {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      releaseAll();
      server.closeAllConnections?.();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

function expectedTrace(id) {
  return { transId: `r03-${id}`, robotId: `robot-${id}`, loggingConfig: '{}' };
}

function assertTraceRecords(peer, ids) {
  const expected = new Map(ids.map((id) => [expectedTrace(id).transId, expectedTrace(id)]));
  const mismatches = peer.stats().records.filter((record) => {
    const wanted = expected.get(record.transId);
    return !wanted || record.robotId !== wanted.robotId || record.loggingConfig !== wanted.loggingConfig;
  });
  assert.equal(mismatches.length, 0, `${peer.name} trace mismatch: ${JSON.stringify(mismatches.slice(0, 2))}`);
  return { records: peer.stats().records.length, mismatches: mismatches.length };
}

/**
 * Open a real robot-facing WebSocket. The transaction is resolved on the final
 * wire frame, and the caller may hold the socket open to observe late peer work.
 */
function startWireTurn({ port, id, kind = 'normal', closeOnFinal = true, maxWaitMs = 20_000 }) {
  const startedAt = performance.now();
  const frames = [];
  let finalRecord;
  let finalSettled = false;
  let closedSettled = false;
  let resolveFinal;
  let rejectFinal;
  let resolveClosed;
  let rejectClosed;
  const final = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  const timer = setTimeout(() => fail(new Error(`${id}: no final frame within ${maxWaitMs}ms`)), maxWaitMs);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
    headers: {
      authorization: `Bearer ${tokenFor(id)}`,
      'x-jibo-transid': `r03-${id}`,
      'x-jibo-robotid': `robot-${id}`,
      'x-jibo-logging-config': '{}',
    },
  });

  function safeClose() {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  }
  function fail(error) {
    clearTimeout(timer);
    if (!finalSettled) {
      finalSettled = true;
      rejectFinal(error);
    }
    safeClose();
  }
  function onFinal(frame) {
    if (finalSettled) return;
    finalSettled = true;
    clearTimeout(timer);
    finalRecord = {
      id,
      kind,
      ok: frame.type === 'SKILL_ACTION',
      finalType: frame.type,
      code: frame.data?.code ?? null,
      finalAt: performance.now(),
      elapsedMs: performance.now() - startedAt,
      frames: frames.map((item) => item.type),
    };
    resolveFinal(finalRecord);
    if (closeOnFinal) setImmediate(safeClose);
  }

  ws.on('open', () => {
    if (kind === 'asr-timeout') {
      ws.send(JSON.stringify(listenServerAsr(id)));
      return;
    }
    ws.send(JSON.stringify(listenClientAsr(id)));
    if (kind !== 'context-timeout') ws.send(JSON.stringify(contextFrame(id)));
    ws.send(JSON.stringify(clientAsr(id)));
  });
  ws.on('message', (data) => {
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); }
    catch (error) { return fail(new Error(`${id}: invalid response JSON: ${error.message}`)); }
    frames.push({ type: frame.type, final: !!frame.final, code: frame.data?.code ?? null });
    if (frame.final) onFinal(frame);
  });
  ws.on('error', (error) => {
    if (!finalSettled) fail(new Error(`${id}: websocket error: ${error.message}`));
  });
  ws.on('close', () => {
    clearTimeout(timer);
    if (!closedSettled) {
      closedSettled = true;
      resolveClosed();
    }
    if (!finalSettled) {
      finalSettled = true;
      rejectFinal(new Error(`${id}: socket closed before final frame`));
    }
  });

  return {
    final,
    closed,
    frames,
    get finalRecord() { return finalRecord; },
    close: safeClose,
    port,
  };
}

async function runWireTurn(options) {
  const turn = startWireTurn(options);
  const result = await turn.final;
  if (options.closeOnFinal === false) turn.close();
  await turn.closed;
  return result;
}

async function runBatch({ port, count, concurrency, prefix }) {
  assert.ok(Number.isInteger(count) && count > 0);
  assert.ok(Number.isInteger(concurrency) && concurrency > 0);
  const startedAt = performance.now();
  const results = new Array(count);
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= count) return;
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        results[index] = await runWireTurn({ port, id: `${prefix}-${index}` });
      } finally {
        inFlight -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => worker()));
  const elapsedMs = performance.now() - startedAt;
  const failed = results.filter((result) => !result?.ok);
  assert.equal(failed.length, 0, `${prefix}: failed turns ${JSON.stringify(failed.slice(0, 2))}`);
  return {
    count,
    concurrency,
    peakInFlight,
    elapsedMs,
    throughputPerSecond: count * 1000 / elapsedMs,
    latencyMs: percentile(results.map((result) => result.elapsedMs)),
    finalTypes: [...new Set(results.map((result) => result.finalType))],
    results,
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function measureQueueSaturation(stack, turns = Number(process.env.R03_QUEUE_TURNS || 64)) {
  assert.ok(Number.isInteger(turns) && turns > 0 && turns <= 256);
  stack.parser.setMode('hang');
  stack.skill.setMode('fast');
  stack.parser.setDelay(2);
  stack.skill.setDelay(2);
  stack.parser.reset();
  stack.skill.reset();
  const handles = Array.from({ length: turns }, (_, index) => startWireTurn({
    port: stack.port,
    id: `queue-${index}`,
    closeOnFinal: false,
    maxWaitMs: Timeouts.parser + 3000,
  }));
  await waitFor(() => stack.parser.stats().total === turns, 2000, `${turns} parser requests to arrive`);
  const parserAtHold = stack.parser.stats();
  assert.equal(parserAtHold.pending, turns, 'held parser peer sees every request pending');
  assert.equal(parserAtHold.active, turns, 'held parser peer observes all active requests');
  stack.parser.releaseAll();
  const results = await Promise.all(handles.map(async (handle) => {
    const result = await handle.final;
    handle.close();
    await handle.closed;
    return result;
  }));
  assert.equal(results.filter((result) => !result.ok).length, 0, 'all held turns eventually settle');
  assert.equal(stack.parser.stats().settled, turns);
  assert.equal(stack.skill.stats().total, turns);
  return {
    turns,
    parserPendingAtHold: parserAtHold.pending,
    parserActiveAtHold: parserAtHold.active,
    parserMaxActive: parserAtHold.maxActive,
    parserSettled: stack.parser.stats().settled,
    skillRequestsAfterRelease: stack.skill.stats().total,
    dropsOrErrors: 0,
    conclusion: 'no rejection/drop observed while turns equal the tested hold size; this is not an unbounded-cap proof',
  };
}

function memorySnapshot(stack) {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
    gatewaySockets: stack.gateway.wss.clients.size,
    parserActive: stack.parser.stats().active,
    skillActive: stack.skill.stats().active,
  };
}

async function collectAfterGC(stack) {
  assert.equal(typeof global.gc, 'function', 'run with node --expose-gc for memory evidence');
  await sleep(25);
  global.gc();
  await sleep(0);
  global.gc();
  return memorySnapshot(stack);
}

function memoryDeltas(baseline, samples) {
  const fields = ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'];
  return Object.fromEntries(fields.map((field) => [field, {
    baseline: baseline[field],
    max: Math.max(...samples.map((sample) => sample[field])),
    maxDelta: Math.max(...samples.map((sample) => sample[field] - baseline[field])),
    final: samples.at(-1)[field],
  }]));
}

function runPreSessionAudioProbe() {
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const tx = new ListenTransaction(
    {
      _auth: { id: 'r03-audio-account', friendlyId: 'r03-audio-robot' },
      _jiboHeaders: { 'x-jibo-transid': 'r03-audio-pre-session' },
      _remoteAddress: '127.0.0.1',
    },
    {
      config: { recordLaunchHistory: false, recordSpeechHistory: false },
      parser: { handleNLU: async () => ({}) },
      skillClient: { launchOrUpdate: async () => ({}) },
      skillConfigManager: { isOnRobotSkill() { return false; } },
      intentRouter: { getSkillIDFromNLU() { return null; } },
    },
    { write() {} },
    log,
  );
  const chunkBytes = 64 * 1024;
  const chunks = 33;
  for (let index = 0; index < chunks; index += 1) tx.handleMessage({ audio: Buffer.alloc(chunkBytes) });
  const retained = {
    chunks: tx.audioChunks.length,
    bytes: tx.audioChunks.reduce((total, chunk) => total + chunk.length, 0),
  };
  clearTimeout(tx._txTimer);
  tx.audioChunks.length = 0;
  return {
    chunksSentBeforeListen: chunks,
    chunkBytes,
    bytesSentBeforeListen: chunks * chunkBytes,
    retained,
    rejected: false,
    conclusion: 'pre-session ListenTransaction staging retained every tested chunk; no hard cap was observed before an ASR session existed',
  };
}

function runQueueProbe() {
  const decoder = new StreamingAudioDecoder({ encoding: AUDIO_ENCODINGS.OGG_OPUS, log: { error() {} } });
  const limit = AUDIO_DECODER_LIMITS.maxPendingInputBytes;
  let error = null;
  try {
    decoder.write(Buffer.alloc(limit + 1));
  } catch (caught) {
    error = caught;
  } finally {
    decoder.abort();
  }
  assert.ok(error instanceof AudioDecodeError, 'encoded-input overflow must reject with AudioDecodeError');
  assert.equal(error.code, 'ERR_AUDIO_DECODE');
  assert.match(error.message, new RegExp(String(limit)));
  return {
    scope: 'Phoenix StreamingAudioDecoder encoded-input queue',
    maxPendingInputBytes: limit,
    attemptedBytes: limit + 1,
    rejected: true,
    errorCode: error.code,
    errorMessageShape: 'Audio decoder input queue exceeded <limit> bytes',
    queuedBytesAfterAbort: decoder.queuedBytes,
    childAfterAbort: decoder.child !== null,
  };
}

function createHangingAsrTracker() {
  const tracker = { starts: 0, stops: 0 };
  const provider = () => ({
    onStartOfSpeech() {},
    onEndOfSpeech() {},
    start() { tracker.starts += 1; return new Promise(() => {}); },
    provideAudio() {},
    stop() { tracker.stops += 1; },
  });
  return { provider, tracker };
}

function checkBudget(result, kind, budgetMs) {
  assert.equal(result.finalType, 'ERROR', `${kind}: timeout must be an ERROR frame`);
  assert.ok(result.elapsedMs >= budgetMs - 250, `${kind}: early timeout ${result.elapsedMs}ms`);
  assert.ok(result.elapsedMs <= budgetMs + 2500, `${kind}: late timeout ${result.elapsedMs}ms`);
}

async function measureTimeouts(stack) {
  const rows = [];
  stack.parser.setMode('hang');
  stack.skill.setMode('fast');
  stack.parser.reset();
  stack.skill.reset();
  let held = startWireTurn({ port: stack.port, id: 'timeout-parser', maxWaitMs: Timeouts.parser + 3000, closeOnFinal: false });
  const parserResult = await held.final;
  checkBudget(parserResult, 'parser', Timeouts.parser);
  const parserPendingAtTimeout = stack.parser.stats().pending;
  const parserFramesAtTimeout = held.frames.length;
  stack.parser.releaseAll();
  await sleep(250);
  const parserLateFrames = held.frames.length - parserFramesAtTimeout;
  held.close();
  await held.closed;
  assert.equal(parserPendingAtTimeout, 1, 'parser request remains in flight at the budget');
  assert.equal(parserLateFrames, 0, 'parser late settlement adds no wire frame');
  rows.push({ kind: 'parser', budgetMs: Timeouts.parser, result: parserResult, pendingAtTimeout: parserPendingAtTimeout, lateSettlements: 1, lateFrames: parserLateFrames, peerRequestContinuedAfterTimeout: true });

  stack.parser.setMode('fast');
  stack.skill.setMode('hang');
  stack.parser.reset();
  stack.skill.reset();
  held = startWireTurn({ port: stack.port, id: 'timeout-skill', maxWaitMs: Timeouts.skill + 3000, closeOnFinal: false });
  const skillResult = await held.final;
  checkBudget(skillResult, 'skill', Timeouts.skill);
  const skillPendingAtTimeout = stack.skill.stats().pending;
  const skillFramesAtTimeout = held.frames.length;
  stack.skill.releaseAll();
  await sleep(250);
  const skillLateFrames = held.frames.length - skillFramesAtTimeout;
  held.close();
  await held.closed;
  assert.equal(skillPendingAtTimeout, 1, 'skill request remains in flight at the budget');
  assert.equal(skillLateFrames, 0, 'skill late settlement adds no wire frame');
  rows.push({ kind: 'skill', budgetMs: Timeouts.skill, result: skillResult, pendingAtTimeout: skillPendingAtTimeout, lateSettlements: 1, lateFrames: skillLateFrames, peerRequestContinuedAfterTimeout: true });

  stack.parser.setMode('fast');
  stack.skill.setMode('fast');
  stack.parser.reset();
  stack.skill.reset();
  const contextResult = await runWireTurn({ port: stack.port, id: 'timeout-context', kind: 'context-timeout', maxWaitMs: Timeouts.context + 3000 });
  checkBudget(contextResult, 'context', Timeouts.context);
  assert.equal(stack.parser.stats().total, 0, 'context timeout occurs before parser request');
  rows.push({ kind: 'context', budgetMs: Timeouts.context, result: contextResult, pendingAtTimeout: 0, lateSettlements: 0, lateFrames: 0, peerRequestContinuedAfterTimeout: false });

  const hangingAsr = createHangingAsrTracker();
  stack.gateway.components.asrProvider = hangingAsr.provider;
  const asrResult = await runWireTurn({ port: stack.port, id: 'timeout-asr', kind: 'asr-timeout', maxWaitMs: Timeouts.asr + 3000 });
  checkBudget(asrResult, 'asr', Timeouts.asr);
  assert.equal(hangingAsr.tracker.starts, 1);
  assert.equal(hangingAsr.tracker.stops, 1, 'ASR session is stopped after the real ASR budget');
  stack.gateway.components.asrProvider = null;
  rows.push({ kind: 'asr', budgetMs: Timeouts.asr, result: asrResult, pendingAtTimeout: 0, lateSettlements: 0, lateFrames: 0, peerRequestContinuedAfterTimeout: false, asrSessionStops: hangingAsr.tracker.stops });

  return rows;
}

async function startStack() {
  const parserResponse = () => ({ type: 'NLU', msgID: 'parser-response', ts: Date.now(), data: { intent: 'launch-intent', rules: ['launch'], entities: {} } });
  const skillResponse = () => ({ type: 'SKILL_ACTION', msgID: 'skill-response', ts: Date.now(), data: { skill: { id: 'r03-skill', session: { id: 'synthetic-session' } }, action: { kind: 'synthetic' } } });
  const parser = createHttpPeer('parser', { response: parserResponse });
  const skill = createHttpPeer('skill', { response: skillResponse });
  const parserURL = await parser.listen();
  const skillURL = await skill.listen();
  const gateway = await createGateway({
    skills: [{ id: 'r03-skill', URL: `${skillURL}/v1/main`, intents: [{ name: 'launch-intent' }] }],
    parserURL,
    historyURL: 'http://127.0.0.1:1',
    settingsURL: 'http://127.0.0.1:1',
    disableAuth: false,
    hubTokenSecret: SECRET,
    recordLaunchHistory: false,
    recordSpeechHistory: false,
    asrProvider: 'none',
  });
  await gateway.service.listen(0);
  return { parser, skill, gateway, port: gateway.service.server.address().port };
}

async function closeStack(stack) {
  stack.gateway.components.asrProvider = null;
  for (const socket of stack.gateway.wss.clients) socket.terminate();
  stack.gateway.wss.close();
  if (stack.gateway.service.server.listening) await new Promise((resolve) => stack.gateway.service.server.close(resolve));
  await stack.parser.close();
  await stack.skill.close();
}

function sourceContracts() {
  return {
    queue: {
      url: 'https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/parser/src/utils/ConcurrentQueue.ts#L11-L39',
      quote: '"This queue guarantees that maxConcurrent handlers are running in parallel"; when activeCount is full, pending work is returned by promiseToProcess; only pendingCount > 10 * maxConcurrent emits a warning.',
      implication: 'The pinned parser queue has a concurrency limit and a warning threshold, not a hard pending-work rejection/drop rule.',
    },
    timeout2: {
      url: 'https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/utils/PromiseUtils.ts#L19-L32',
      quote: 'timeout2 resolves the string "TIMEOUT" at timeoutMs; the original promise is still attached with then/catch and is not cancelled.',
    },
    budgets: {
      url: 'https://pvindex.org/gitea/jiboV2/pegasus/src/commit/5c0a7390539663ba749d360de348a428c088505c/packages/hub/src/listen/ListenTransactionHandler.ts#L38-L44',
      quote: 'TIMEOUT_ASR = 40 * 1000; TIMEOUT_PARSER = 10 * 1000; TIMEOUT_CONTEXT = 5 * 1000; TIMEOUT_SKILL = 10 * 1000.',
      parserAndSkill: 'The parser path calls timeout2 at lines 307-322 and the skill path at lines 397-414.',
    },
    phoenixQueueSources: {
      decoder: 'packages/gateway/src/asr/audioDecoder.js#L13-L16 and #L357-L382',
      decoderQuote: 'MAX_PENDING_INPUT_BYTES = 2 * 1024 * 1024; write() throws AudioDecodeError when queuedBytes + chunk.length exceeds it.',
      preSession: 'packages/gateway/src/listenTransaction.js#L129-L165',
      preSessionQuote: 'audioChunks starts as [] and handleMessage pushes every audio buffer while asrSession is absent; this staging path has no byte check in the cited lines.',
    },
  };
}

export async function runEvidence({ turnsPerArm = Number(process.env.R03_TURNS_PER_ARM || 64), memoryWaves = Number(process.env.R03_MEMORY_WAVES || 6), memoryTurns = Number(process.env.R03_MEMORY_TURNS || 128), skipAsr = process.env.R03_SKIP_ASR === '1' } = {}) {
  assert.ok(Number.isInteger(turnsPerArm) && turnsPerArm > 0 && turnsPerArm <= 512);
  assert.ok(Number.isInteger(memoryWaves) && memoryWaves > 0 && memoryWaves <= 20);
  assert.ok(Number.isInteger(memoryTurns) && memoryTurns > 0 && memoryTurns <= 512);
  const stack = await startStack();
  try {
    // Warm the WebSocket/HTTP pools and JIT before the reported baseline.
    stack.parser.setMode('fast');
    stack.skill.setMode('fast');
    stack.parser.reset();
    stack.skill.reset();
    await runBatch({ port: stack.port, count: 16, concurrency: 8, prefix: 'warmup' });
    await collectAfterGC(stack);

    const load = [];
    const loadDelayMs = Number(process.env.R03_PEER_DELAY_MS || 20);
    stack.parser.setDelay(loadDelayMs);
    stack.skill.setDelay(loadDelayMs);
    for (const concurrency of [1, 8, 32, 64]) {
      stack.parser.reset();
      stack.skill.reset();
      const arm = await runBatch({ port: stack.port, count: turnsPerArm, concurrency, prefix: `load-${concurrency}` });
      const ids = Array.from({ length: turnsPerArm }, (_, index) => `load-${concurrency}-${index}`);
      const parserTrace = assertTraceRecords(stack.parser, ids);
      const skillTrace = assertTraceRecords(stack.skill, ids);
      const parserStats = stack.parser.stats();
      const skillStats = stack.skill.stats();
      assert.equal(parserStats.total, turnsPerArm);
      assert.equal(skillStats.total, turnsPerArm);
      load.push({
        concurrency,
        turns: turnsPerArm,
        peerDelayMs: loadDelayMs,
        elapsedMs: arm.elapsedMs,
        throughputPerSecond: arm.throughputPerSecond,
        latencyMs: arm.latencyMs,
        peakInFlight: arm.peakInFlight,
        finalTypes: arm.finalTypes,
        parser: { total: parserStats.total, maxActive: parserStats.maxActive, trace: parserTrace },
        skill: { total: skillStats.total, maxActive: skillStats.maxActive, trace: skillTrace },
        dropsOrErrors: 0,
      });
    }

    const queueSaturation = await measureQueueSaturation(stack);
    stack.parser.setMode('fast');
    stack.skill.setMode('fast');
    stack.parser.setDelay(2);
    stack.skill.setDelay(2);
    const memorySamples = [];
    const baseline = await collectAfterGC(stack);
    let memoryTotalTurns = 0;
    for (let wave = 0; wave < memoryWaves; wave += 1) {
      stack.parser.reset();
      stack.skill.reset();
      await runBatch({ port: stack.port, count: memoryTurns, concurrency: 32, prefix: `memory-${wave}` });
      memoryTotalTurns += memoryTurns;
      memorySamples.push(await collectAfterGC(stack));
      assert.equal(stack.gateway.wss.clients.size, 0, `memory wave ${wave}: WebSocket clients leaked`);
      assert.equal(stack.parser.stats().active, 0, `memory wave ${wave}: parser requests leaked`);
      assert.equal(stack.skill.stats().active, 0, `memory wave ${wave}: skill requests leaked`);
    }
    const memory = {
      waves: memoryWaves,
      turns: memoryTotalTurns,
      concurrency: 32,
      baseline,
      samples: memorySamples,
      deltas: memoryDeltas(baseline, memorySamples),
      finiteRunBound: 'observed after forced GC; not a proof of an all-duration heap/RSS bound',
      leakedLiveResources: false,
    };

    const queue = runQueueProbe();
    const preSessionAudio = runPreSessionAudioProbe();
    const timeouts = skipAsr ? await measureTimeoutsWithoutAsr(stack) : await measureTimeouts(stack);
    return {
      schemaVersion: 2,
      lane: 'R-03 reliability: real sockets, load, queue and memory',
      acceptance: 'bounded-evidence-only',
      capturedAt: new Date().toISOString(),
      phoenixRevision: process.env.R03_PHOENIX_REVISION || 'runtime HEAD supplied by caller',
      node: process.version,
      sabotageMode: sabotage || null,
      transport: 'real Phoenix gateway WebSocket + real local HTTP parser/skill sockets; synthetic peers and identities; no hardware/live ports',
      load,
      queueSaturation,
      queue,
      preSessionAudio,
      memory,
      timeouts,
      sourceContracts: sourceContracts(),
      unknowns: [
        'No pinned Pegasus runtime was executed in this lane; source queue and timeout semantics are cited/inferred, not source-runtime differential measurements.',
        'The load sweep bounds only the tested finite population and concurrency arms; it does not establish production capacity or an unbounded queue limit.',
        'The finite memory run checks post-GC RSS/heap observations and zero live sockets; it does not prove a formal long-running memory bound.',
        'The pre-session audio probe demonstrates retained staging at 2,162,688 bytes but does not establish behavior at larger floods, after Listen arrives, or under process/container memory pressure.',
      ],
    };
  } finally {
    await closeStack(stack);
  }
}

// Kept separate so the normal timeout run can skip the 40 s ASR arm explicitly.
async function measureTimeoutsWithoutAsr(stack) {
  const rows = await measureTimeoutsPart(stack);
  return rows;
}

async function measureTimeoutsPart(stack) {
  const rows = [];
  stack.parser.setMode('hang');
  stack.skill.setMode('fast');
  stack.parser.reset();
  stack.skill.reset();
  let held = startWireTurn({ port: stack.port, id: 'timeout-parser', maxWaitMs: Timeouts.parser + 3000, closeOnFinal: false });
  const parserResult = await held.final;
  checkBudget(parserResult, 'parser', Timeouts.parser);
  const parserPendingAtTimeout = stack.parser.stats().pending;
  const parserFramesAtTimeout = held.frames.length;
  stack.parser.releaseAll();
  await sleep(250);
  const parserLateFrames = held.frames.length - parserFramesAtTimeout;
  held.close();
  await held.closed;
  assert.equal(parserPendingAtTimeout, 1);
  assert.equal(parserLateFrames, 0);
  rows.push({ kind: 'parser', budgetMs: Timeouts.parser, result: parserResult, pendingAtTimeout: parserPendingAtTimeout, lateSettlements: 1, lateFrames: parserLateFrames, peerRequestContinuedAfterTimeout: true });

  stack.parser.setMode('fast');
  stack.skill.setMode('hang');
  stack.parser.reset();
  stack.skill.reset();
  held = startWireTurn({ port: stack.port, id: 'timeout-skill', maxWaitMs: Timeouts.skill + 3000, closeOnFinal: false });
  const skillResult = await held.final;
  checkBudget(skillResult, 'skill', Timeouts.skill);
  const skillPendingAtTimeout = stack.skill.stats().pending;
  const skillFramesAtTimeout = held.frames.length;
  stack.skill.releaseAll();
  await sleep(250);
  const skillLateFrames = held.frames.length - skillFramesAtTimeout;
  held.close();
  await held.closed;
  assert.equal(skillPendingAtTimeout, 1);
  assert.equal(skillLateFrames, 0);
  rows.push({ kind: 'skill', budgetMs: Timeouts.skill, result: skillResult, pendingAtTimeout: skillPendingAtTimeout, lateSettlements: 1, lateFrames: skillLateFrames, peerRequestContinuedAfterTimeout: true });

  stack.parser.setMode('fast');
  stack.skill.setMode('fast');
  stack.parser.reset();
  stack.skill.reset();
  const contextResult = await runWireTurn({ port: stack.port, id: 'timeout-context', kind: 'context-timeout', maxWaitMs: Timeouts.context + 3000 });
  checkBudget(contextResult, 'context', Timeouts.context);
  assert.equal(stack.parser.stats().total, 0);
  rows.push({ kind: 'context', budgetMs: Timeouts.context, result: contextResult, pendingAtTimeout: 0, lateSettlements: 0, lateFrames: 0, peerRequestContinuedAfterTimeout: false });
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] || 'r03-real-load.json';
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const revision = await import('node:child_process').then(({ execFileSync }) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' }).trim());
    const report = await runEvidence({});
    report.phoenixRevision = revision;
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
      output,
      lane: report.lane,
      arms: report.load.map((arm) => ({ concurrency: arm.concurrency, turns: arm.turns, throughputPerSecond: arm.throughputPerSecond, p50: arm.latencyMs.p50, p95: arm.latencyMs.p95 })),
      queue: { maxPendingInputBytes: report.queue.maxPendingInputBytes, rejected: report.queue.rejected, pendingAtHold: report.queueSaturation.parserPendingAtHold },
      memory: { turns: report.memory.turns, maxHeapDelta: report.memory.deltas.heapUsed.maxDelta, maxRssDelta: report.memory.deltas.rss.maxDelta },
      timeouts: report.timeouts.map((row) => ({ kind: row.kind, budgetMs: row.budgetMs, elapsedMs: row.result.elapsedMs, code: row.result.code })),
    }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, sabotage, failure: error.message, stack: error.stack }));
    process.exitCode = 1;
  } finally {
    clearInterval(keepAlive);
  }
}
