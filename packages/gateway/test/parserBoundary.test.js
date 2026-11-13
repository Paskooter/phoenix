// Invented offline fixtures only. No production, ASR, model or robot requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { EventEmitter, getEventListeners } from 'node:events';
import { Timeouts, HubErrorCode } from '@phoenix/contracts';
import { createService, recentLogs } from '@phoenix/common';
import { ParserClient } from '../src/parserClient.js';
import { ListenTransaction } from '../src/listenTransaction.js';
import { start } from '../../nlu/src/index.js';
import { observeParserRoute } from '../../nlu/src/parserBoundary.js';

process.env.PHOENIX_BIND_HOST = '127.0.0.1';
process.env.PHOENIX_NLU_EXTERNAL = 'disabled';
process.env.ETCO_parser_decisionEngine = 'off';
process.env.ETCO_parser_layaEnabled = 'false';
process.env.ETCO_parser_layaSecondaryFallback = 'none';
delete process.env.PHOENIX_NLU_RUNTIME;

const HEADER = 'x-phoenix-parser-request-id';
const PRIVATE = 'SYNTHETIC_PRIVATE_PAYLOAD_7f91';
const trace = {
  transId: `${PRIVATE}_transaction`, robotId: `${PRIVATE}_robot`,
  loggingConfig: JSON.stringify({ 'gateway.parser': 'error', 'nlu.parser': 'error' }),
  parserRequestId: `${PRIVATE}_caller_correlation`,
};
const input = {
  text: `${PRIVATE}\n\"forged log\"`, rules: [],
  loop: { users: [{ id: `${PRIVATE}_member`, firstName: PRIVATE, lastName: PRIVATE }] },
};
const cursor = () => recentLogs({ limit: 1 }).cursor;
const records = (since) => recentLogs({ since, limit: 200 }).events.filter(row => row.msg === 'parser_boundary');
const keys = [
  't', 'level', 'ns', 'msg', 'seq', 'requestId', 'side', 'phase', 'outcome',
  'interruption', 'elapsedMs', 'status', 'late',
].sort();
function safeRecords(rows) {
  assert.ok(rows.length > 0, 'boundary observations must exist');
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), keys, 'only fixed diagnostic fields');
    assert.match(row.requestId, /^p1_[0-9a-f]{32}$/);
    assert.ok(['gateway', 'parser'].includes(row.side));
    assert.ok(['start', 'interrupt', 'complete', 'response'].includes(row.phase));
    assert.ok(['pending', 'ok', 'http_error', 'transport_error', 'decode_error', 'aborted', 'error', 'sent'].includes(row.outcome));
    assert.ok(['none', 'wait_timeout', 'cancelled', 'request_deadline', 'peer_disconnect'].includes(row.interruption));
    assert.ok(Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 2_147_483_647);
    assert.ok(row.status === 0 || (Number.isInteger(row.status) && row.status >= 100 && row.status <= 599));
    assert.ok(row.late === 0 || row.late === 1);
  }
  assert.equal(JSON.stringify(rows).includes(PRIVATE), false, 'no text, identity, caller trace or exception content');
}

async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

test('success joins the real Parser HTTP boundary with a fresh request-only correlation', async (t) => {
  const since = cursor();
  const server = await start(0);
  t.after(() => close(server));
  const parser = new ParserClient(`http://127.0.0.1:${server.address().port}`);
  const result = await parser.handleNLU(input, trace);
  assert.deepEqual(result, { rules: [], intent: null, entities: null });
  const rows = records(since);
  safeRecords(rows);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
  assert.deepEqual(rows.filter(row => row.side === 'gateway').map(row => row.phase), ['start', 'complete']);
  assert.deepEqual(rows.filter(row => row.side === 'parser').map(row => row.phase), ['start', 'complete', 'response']);
  assert.equal(rows.find(row => row.side === 'gateway' && row.phase === 'complete').status, 200);
  assert.equal(rows.find(row => row.phase === 'response').status, 200);
  assert.ok(rows.every(row => row.outcome === 'pending' || row.outcome === 'ok' || row.outcome === 'sent'));
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100_000 });
  t.mock.method(performance, 'now', () => Date.now());
}

function heldTransaction(t) {
  clock(t);
  const gate = deferred();
  const entered = deferred();
  let clientPromise;
  let signal;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    calls++;
    signal = options.signal;
    entered.resolve();
    return gate.promise; // Deliberately non-cooperative transport, to expose late completion.
  });
  const frames = [];
  const parser = new ParserClient(`http://synthetic.invalid/${PRIVATE}`);
  const tx = new ListenTransaction({ _jiboHeaders: {}, _auth: null }, {
    config: { recordSpeechHistory: false, recordLaunchHistory: false },
    parser: { handleNLU(...args) { clientPromise = parser.handleNLU(...args); return clientPromise; } },
  }, { write(frame) { frames.push(frame); } }, { info() {}, debug() {}, warn() {}, error() {} });
  tx.trace = trace;
  tx.listenMessage = { data: { rules: [] } };
  tx.asrData = { text: input.text, confidence: 1 };
  tx.contextPr.resolve({ data: { general: {}, runtime: { loop: { users: input.loop.users } }, skill: {} } });
  tx.state = 'NLU';
  const done = tx.done.catch(error => error);
  t.after(() => { tx.abandon(); clearTimeout(tx._txTimer); });
  return { tx, frames, gate, entered: entered.promise, done, client: () => clientPromise, signal: () => signal, calls: () => calls };
}

function response(status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => ({ data: { rules: [], intent: null, entities: null } }) };
}

test('the real 10000-ms Gateway wait logs timeout before cancellation and late client completion', async (t) => {
  const since = cursor();
  const h = heldTransaction(t);
  let settled = false;
  const operation = h.tx._performNLU().catch(error => { settled = true; return error; });
  await h.entered;
  assert.equal(Timeouts.parser, 10000, 'the contract is not shortened for the test');
  t.mock.timers.tick(Timeouts.parser - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const error = await operation;
  assert.equal(error.code, HubErrorCode.PARSER);
  assert.equal(error.message, 'Timeout of 10000 while waiting for parser');
  h.tx.reject(error);
  assert.equal(await h.done, error);
  assert.equal(h.signal().aborted, true);
  const interrupted = records(since).find(row => row.phase === 'interrupt');
  assert.equal(interrupted?.interruption, 'wait_timeout', 'record the actual Gateway wait cutoff, not the later abort');
  assert.equal(interrupted.elapsedMs, 10000);
  t.mock.timers.tick(50);
  h.gate.resolve(response());
  await h.client();
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
  assert.deepEqual(rows.map(row => row.elapsedMs), [0, 10000, 10050]);
  assert.equal(rows.at(-1).interruption, 'wait_timeout');
  assert.equal(rows.at(-1).outcome, 'ok');
  assert.equal(rows.at(-1).late, 1);
  assert.equal(rows.at(-1).status, 200);
  assert.equal(h.calls(), 1, 'no retry');
  assert.equal(h.tx.nluData, null);
  assert.deepEqual(h.frames, []);
});

test('Gateway abandonment logs cancellation immediately and ignores the late successful result', async (t) => {
  const since = cursor();
  const h = heldTransaction(t);
  const operation = h.tx._performNLU();
  await h.entered;
  t.mock.timers.tick(37);
  h.tx.abandon();
  await h.done;
  const interrupted = records(since).find(row => row.phase === 'interrupt');
  assert.equal(interrupted?.interruption, 'cancelled', 'cancellation is observable even while fetch ignores abort');
  assert.equal(interrupted.elapsedMs, 37);
  t.mock.timers.tick(200);
  h.gate.resolve(response());
  await h.client();
  await operation;
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.deepEqual(rows.map(row => row.elapsedMs), [0, 37, 237]);
  assert.equal(rows.at(-1).interruption, 'cancelled');
  assert.equal(rows.at(-1).late, 1);
  assert.equal(rows.at(-1).outcome, 'ok');
  assert.equal(rows.at(-1).status, 200);
  assert.equal(h.calls(), 1);
  assert.equal(h.tx.nluData, null);
  assert.deepEqual(h.frames, []);
});

test('a late transport rejection after the real wait timeout remains correlated and handled', async (t) => {
  const since = cursor();
  const h = heldTransaction(t);
  const operation = h.tx._performNLU().catch(error => error);
  await h.entered;
  t.mock.timers.tick(Timeouts.parser);
  const timeout = await operation;
  assert.equal(timeout.code, HubErrorCode.PARSER);
  h.tx.reject(timeout);
  await h.done;
  const error = new Error(PRIVATE);
  const rejected = assert.rejects(h.client(), value => value === error);
  t.mock.timers.tick(20);
  h.gate.reject(error);
  await rejected;
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.equal(rows.at(-1).outcome, 'transport_error');
  assert.equal(rows.at(-1).interruption, 'wait_timeout');
  assert.equal(rows.at(-1).late, 1);
  assert.equal(rows.at(-1).status, 0);
  assert.equal(rows.at(-1).elapsedMs, 10020);
});

test('Parser response disconnect is distinct from a late handler completion and normal request close', async (t) => {
  clock(t);
  const since = cursor();
  const gate = deferred();
  const req = new EventEmitter();
  req.headers = { [HEADER]: `p1_${'12'.repeat(16)}`, 'x-jibo-transid': PRIVATE };
  const res = new EventEmitter();
  res.statusCode = 200;
  res.writableFinished = false;
  const observed = observeParserRoute(() => gate.promise);
  const operation = observed({ req, res, body: input, trace });
  req.emit('close'); // An already-read request closing does not mean a lost response.
  assert.equal(records(since).length, 1);
  t.mock.timers.tick(75);
  res.emit('close');
  res.emit('close');
  const interrupted = records(since).find(row => row.phase === 'interrupt');
  assert.equal(interrupted?.interruption, 'peer_disconnect');
  assert.equal(interrupted.status, 0, 'a default statusCode is not a delivered response');
  t.mock.timers.tick(100);
  gate.resolve({ data: PRIVATE });
  assert.deepEqual(await operation, { data: PRIVATE }, 'observation does not cancel work or alter its result');
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.deepEqual(rows.map(row => row.elapsedMs), [0, 75, 175]);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
  assert.equal(rows.at(-1).late, 1);
  assert.equal(rows.at(-1).outcome, 'ok');
  assert.equal(rows.at(-1).interruption, 'peer_disconnect');
  assert.equal(res.listenerCount('finish'), 0);
  assert.equal(res.listenerCount('close'), 0);
});

for (const kind of ['transport', 'status', 'decode']) {
  test(`${kind} failure keeps its original rejection and emits only safe outcome/status metadata`, async (t) => {
    clock(t);
    const since = cursor();
    const secretError = new Error(`${PRIVATE}_exception_with_body_and_url`);
    secretError.code = `${PRIVATE}_code`;
    secretError.stack = `${PRIVATE}_stack`;
    const seen = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      seen.push({ url, options });
      t.mock.timers.tick(23);
      if (kind === 'transport') throw secretError;
      if (kind === 'status') return { ok: false, status: 503, json() { assert.fail('error response body must not be read for diagnostics'); } };
      return { ok: true, status: 200, json: async () => { throw secretError; } };
    });
    const parser = new ParserClient(`http://synthetic.invalid/${PRIVATE}/?credential=${PRIVATE}`);
    const error = await parser.handleNLU(input, trace).catch(value => value);
    if (kind === 'status') assert.equal(error.message, 'parser 503');
    else assert.equal(error, secretError);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].options.headers['x-jibo-transid'], trace.transId, 'legacy trace forwarding is unchanged');
    assert.equal(JSON.parse(seen[0].options.body).data.text, input.text, 'the request is not altered');
    const rows = records(since);
    safeRecords(rows);
    assert.deepEqual(rows.map(row => row.phase), ['start', 'complete']);
    assert.equal(rows[1].outcome, { transport: 'transport_error', status: 'http_error', decode: 'decode_error' }[kind]);
    assert.equal(rows[1].status, { transport: 0, status: 503, decode: 200 }[kind]);
    assert.equal(rows[1].elapsedMs, 23);
    assert.equal(rows[1].requestId, seen[0].options.headers[HEADER]);
    assert.equal(rows[1].interruption, 'none');
    assert.equal(rows[1].late, 0);
  });
}

test('caller-supplied observer objects cannot inject identifiers or suppress boundary diagnostics', async (t) => {
  const since = cursor();
  let headers;
  t.mock.method(globalThis, 'fetch', async (_url, options) => { headers = options.headers; return response(); });
  await new ParserClient('http://synthetic.invalid').handleNLU(input, trace, {
    parserBoundary: { requestId: PRIVATE, complete() {}, interrupt() {} },
  });
  assert.match(headers[HEADER], /^p1_[0-9a-f]{32}$/);
  const rows = records(since);
  safeRecords(rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].requestId, headers[HEADER]);
});

test('null response unwrapping is a decode failure, not a successful completion', async (t) => {
  const since = cursor();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, json: async () => null }));
  await assert.rejects(new ParserClient('http://synthetic.invalid').handleNLU(input, trace), TypeError);
  const rows = records(since);
  safeRecords(rows);
  assert.equal(rows.at(-1).outcome, 'decode_error');
  assert.equal(rows.at(-1).status, 200);
});

test('a non-cooperative late HTTP failure keeps its observed status class after cancellation', async (t) => {
  const since = cursor();
  const held = deferred();
  const parent = new AbortController();
  t.mock.method(globalThis, 'fetch', () => held.promise);
  const operation = new ParserClient('http://synthetic.invalid').handleNLU(input, trace, { signal: parent.signal });
  const rejected = assert.rejects(operation, { message: 'parser 503' });
  parent.abort(new Error(PRIVATE));
  held.resolve(response(503));
  await rejected;
  const rows = records(since);
  safeRecords(rows);
  assert.equal(rows.at(-1).outcome, 'http_error');
  assert.equal(rows.at(-1).status, 503);
  assert.equal(rows.at(-1).interruption, 'cancelled');
  assert.equal(rows.at(-1).late, 1);
});

test('cancellation during held response decoding preserves the known status and records late settlement', async (t) => {
  const since = cursor();
  const parent = new AbortController();
  const decoding = deferred();
  const entered = deferred();
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200,
    json() { entered.resolve(); return decoding.promise; },
  }));
  const operation = new ParserClient('http://synthetic.invalid').handleNLU(input, trace, { signal: parent.signal });
  await entered.promise;
  parent.abort(new Error(PRIVATE));
  decoding.resolve({ data: { intent: null } });
  assert.deepEqual(await operation, { intent: null }, 'a non-cooperative decoder keeps its existing result semantics');
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.equal(rows.at(-1).interruption, 'cancelled');
  assert.equal(rows.at(-1).late, 1);
  assert.equal(rows.at(-1).outcome, 'ok');
  assert.equal(rows.at(-1).status, 200);
});

test('identical overlapping requests get independent tokens and remove settled abort listeners', async (t) => {
  const since = cursor();
  const held = [deferred(), deferred()];
  const requests = [];
  t.mock.method(globalThis, 'fetch', (_url, options) => {
    const index = requests.push(options) - 1;
    return held[index].promise;
  });
  const parent = new AbortController();
  const parser = new ParserClient('http://synthetic.invalid');
  const first = parser.handleNLU(input, trace, { signal: parent.signal });
  const second = parser.handleNLU(input, trace, { signal: parent.signal });
  assert.notEqual(requests[0].headers[HEADER], requests[1].headers[HEADER]);
  held[1].resolve(response());
  await second;
  held[0].resolve(response());
  await first;
  const rows = records(since);
  safeRecords(rows);
  assert.equal(rows.length, 4);
  for (const request of requests) {
    assert.deepEqual(rows.filter(row => row.requestId === request.headers[HEADER]).map(row => row.phase), ['start', 'complete']);
    assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  }
  parent.abort(new Error(PRIVATE));
  assert.equal(records(since).length, 4, 'cleanup cancellation after success adds no false interruption');
});

for (const preAborted of [false, true]) {
  test(`parent cancellation (${preAborted ? 'pre-aborted' : 'in-flight'}) is not inferred from exception names`, async (t) => {
    const since = cursor();
    const parent = new AbortController();
    const reason = new Error(PRIVATE);
    reason.name = 'TimeoutError'; // Still a parent cancellation, not a request deadline.
    if (preAborted) parent.abort(reason);
    let signal;
    t.mock.method(globalThis, 'fetch', (_url, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const operation = new ParserClient('http://synthetic.invalid').handleNLU(input, trace, parent.signal).catch(error => error);
    if (!preAborted) parent.abort(reason);
    assert.equal(await operation, reason);
    const rows = records(since);
    safeRecords(rows);
    assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
    assert.equal(rows[1].interruption, 'cancelled');
    assert.equal(rows[2].interruption, 'cancelled');
    assert.equal(rows[2].outcome, 'aborted');
    assert.equal(rows[2].late, 1, 'late is settlement after interruption, not proof of a delivered response');
    assert.equal(rows[2].status, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });
}

test('the unchanged client deadline is distinguished from the Gateway wait timeout', async (t) => {
  const since = cursor();
  const deadline = new AbortController();
  const reason = new Error(PRIVATE);
  let timeoutMs;
  t.mock.method(AbortSignal, 'timeout', (ms) => { timeoutMs = ms; return deadline.signal; });
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  const parser = new ParserClient('http://synthetic.invalid');
  const operation = parser.handleNLU(input, trace).catch(error => error);
  assert.equal(timeoutMs, 11000, 'preserve the existing inner fetch deadline too');
  deadline.abort(reason);
  assert.equal(await operation, reason);
  const rows = records(since);
  safeRecords(rows);
  assert.deepEqual(rows.map(row => row.phase), ['start', 'interrupt', 'complete']);
  assert.equal(rows[1].interruption, 'request_deadline');
  assert.equal(rows[2].outcome, 'aborted');
});

for (const status of [400, 500]) {
  test(`actual Parser HTTP ${status} keeps its response contract and joins both boundaries`, async (t) => {
    const since = cursor();
    const server = await start(0);
    t.after(() => close(server));
    const realFetch = globalThis.fetch;
    let sent, wire;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      sent = JSON.parse(options.body);
      const result = await realFetch(url, options);
      wire = await result.clone().json();
      return result;
    });
    const parser = new ParserClient(`http://127.0.0.1:${server.address().port}`);
    // These are existing input boundaries: malformed text, or the deliberately
    // retained disabled external-agent attachment failure. Neither calls a model.
    const data = status === 400 ? { ...input, text: 42 } : { ...input, external: {} };
    await assert.rejects(parser.handleNLU(data, {}), { message: `parser ${status}` });
    assert.deepEqual(Object.keys(wire).sort(), ['data', 'final', 'msgID', 'ts', 'type']);
    assert.equal(wire.type, 'ERROR');
    assert.equal(wire.final, true);
    assert.deepEqual(wire.data, {
      message: status === 400 ? `Bad request: ${JSON.stringify(sent)}` : "Cannot read property 'external' of null",
    });
    const rows = records(since);
    safeRecords(rows);
    assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
    const client = rows.find(row => row.side === 'gateway' && row.phase === 'complete');
    assert.equal(client.outcome, 'http_error');
    assert.equal(client.status, status);
    assert.equal(rows.find(row => row.side === 'parser' && row.phase === 'complete').outcome, 'error');
    assert.equal(rows.find(row => row.phase === 'response').status, status);
    assert.equal(rows.length, 5);
  });
}

test('real loopback disconnect correlates the cancelled client and continuing Parser work', { timeout: 5000 }, async (t) => {
  const since = cursor();
  const gate = deferred();
  const entered = deferred();
  const disconnected = deferred();
  const completed = deferred();
  const observed = observeParserRoute(async ({ res }) => {
    res.once('close', disconnected.resolve);
    entered.resolve();
    return gate.promise;
  });
  const svc = createService({ name: 'synthetic-parser', routes: {
    'POST /v1/parse': async (context) => {
      const result = await observed(context);
      completed.resolve();
      return result;
    },
  } });
  const server = await svc.listen(0, '127.0.0.1');
  t.after(async () => { gate.resolve({ data: null }); await close(server); });
  const parent = new AbortController();
  const parser = new ParserClient(`http://127.0.0.1:${server.address().port}`);
  const reason = new Error(PRIVATE);
  const operation = parser.handleNLU(input, {}, { signal: parent.signal }).catch(error => error);
  await entered.promise;
  parent.abort(reason);
  assert.equal(await operation, reason);
  await disconnected.promise;
  gate.resolve({ data: { rules: [], intent: null, entities: null } });
  await completed.promise;
  const rows = records(since);
  safeRecords(rows);
  assert.equal(new Set(rows.map(row => row.requestId)).size, 1);
  assert.equal(rows.length, 6);
  assert.equal(rows.find(row => row.side === 'gateway' && row.phase === 'complete').outcome, 'aborted');
  const peer = rows.find(row => row.side === 'parser' && row.phase === 'complete');
  assert.equal(peer.outcome, 'ok');
  assert.equal(peer.interruption, 'peer_disconnect');
  assert.equal(peer.late, 1);
  assert.equal(peer.status, 0);
  assert.equal(rows.some(row => row.phase === 'response'), false, 'no claim of an HTTP response after disconnect');
});
