// Synthetic fixtures; staged September gateway hardening re-port.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';

import { ListenTransaction } from '../src/listenTransaction.js';
import {
  GoogleASRProvider,
  createMockRecognizerStream,
  setRecognizerFactory,
} from '../src/asr/googleProvider.js';
import { GoogleASRSession } from '../src/asr/googleSession.js';
import { ParakeetASRSession } from '../src/asr/parakeetSession.js';
import * as parakeetTransport from '../src/asr/parakeetTransport.js';
const truncateUtf8ByBytes = (...args) => parakeetTransport.truncateUtf8ByBytes(...args);
import { ProactiveTransaction } from '../src/proactive/proactiveTransaction.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const GOOGLE_MAX_FRAME_BYTES = 64 * 1024;
const GOOGLE_MAX_TOTAL_AUDIO_BYTES = 4 * 1024 * 1024;
const GOOGLE_MAX_OUTBOUND_BUFFER_BYTES = 512 * 1024;
const GOOGLE_QUEUE_FRAME_BYTES = 16 * 1024;
const GOOGLE_MAX_INBOUND_BUFFER_BYTES = 512 * 1024;
const PARakeet_OVERSIZED_RESPONSE_BYTES = 8 * 1024 * 1024;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function waitFor(promise, ms = 1500) {
  let timer;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function expectReject(promise, predicate) {
  let error;
  try {
    await promise;
  } catch (value) {
    error = value;
  }
  assert.ok(error, 'the operation must reject');
  if (predicate) assert.equal(predicate(error), true);
  return error;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function closeNetServer(server, sockets = []) {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}

function contextMessage() {
  return {
    type: 'CONTEXT',
    data: {
      general: { accountID: 'gateway-resource-account', robotID: 'gateway-resource-robot', lang: 'en', release: '2.0.1' },
      runtime: { perception: { speaker: null, peoplePresent: [] }, loop: { users: [] } },
      skill: {},
    },
  };
}

function makeTransaction(overrides = {}) {
  const frames = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: { id: 'gateway-resource-account', friendlyId: 'gateway-resource-robot' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false, recordSpeechHistory: false },
      skillConfigManager: { isOnRobotSkill: () => false },
      intentRouter: { getSkillIDFromNLU: () => null },
      parser: { handleNLU: async () => ({ intent: null, rules: [], entities: {} }) },
      skillClient: { launchOrUpdate: async () => ({ response: { type: 'SKILL_ACTION', data: {} } }), launch: async () => ({ response: { type: 'SKILL_ACTION', data: {} } }) },
      historyClient: { writeSkillLaunch: () => Promise.resolve(), saveSpeechRecord: () => Promise.resolve() },
      ...overrides,
    },
    { write: (frame) => frames.push(frame) },
    log,
  );
  return { tx, frames };
}

function eventStream({ write = () => true } = {}) {
  const stream = new EventEmitter();
  stream.write = write;
  stream.end = () => { stream.ended = true; };
  stream.destroy = () => { stream.destroyed = true; };
  stream.ended = false;
  stream.destroyed = false;
  return stream;
}

function listenMessage(mode) {
  return { type: 'LISTEN', data: { lang: 'en-US', rules: [], hotphrase: false, mode } };
}

async function responseServer(status, body, { contentLength = true } = {}) {
  const responseClosed = deferred();
  const server = http.createServer((req, res) => {
    req.resume();
    req.once('end', () => {
      res.once('close', () => responseClosed.resolve());
      const headers = { 'content-type': 'application/json' };
      if (contentLength) headers['content-length'] = String(body.length);
      res.writeHead(status, headers);
      res.end(body);
    });
  });
  await listen(server);
  return { server, responseClosed };
}

// --- Google stream lifecycle -------------------------------------------------

test('Google abort destroys the stream and detaches every transaction listener', async () => {
  const stream = eventStream();
  const session = new GoogleASRSession(stream, { lang: 'en-US' }, log);
  const start = session.start();

  assert.equal(stream.listenerCount('error'), 1);
  assert.equal(stream.listenerCount('data'), 1);
  assert.equal(stream.listenerCount('end'), 1);

  session.abort();

  assert.equal(stream.destroyed, true);
  assert.equal(stream.listenerCount('error'), 0);
  assert.equal(stream.listenerCount('data'), 0);
  assert.equal(stream.listenerCount('end'), 0);
  assert.equal(await start, undefined);
});

test('Google stop remains graceful and ends without destroying the stream', async () => {
  const stream = eventStream();
  const session = new GoogleASRSession(stream, { lang: 'en-US' }, log);
  const start = session.start();

  session.stop();

  assert.equal(stream.ended, true);
  assert.equal(stream.destroyed, false);
  assert.equal(await start, undefined);
});

test('Google mock recognizer abort closes an allow-half-open TCP peer', async (t) => {
  const sockets = [];
  const connected = deferred();
  const server = net.createServer((socket) => {
    sockets.push(socket);
    connected.resolve(socket);
  });
  const port = await listen(server);
  t.after(() => closeNetServer(server, sockets));

  const stream = createMockRecognizerStream({ address: '127.0.0.1', port }, { lang: 'en-US' });
  const session = new GoogleASRSession(stream, { lang: 'en-US' }, log);
  const start = session.start();
  const peer = await waitFor(connected.promise);
  const peerClosed = waitFor(once(peer, 'close'));

  session.abort();

  await peerClosed;
  assert.equal(await start, undefined);
  assert.equal(stream.socket.destroyed, true);
});

// --- Google constructor and memory bounds -----------------------------------

test('Google provider validates earlyEOS before opening a recognizer socket', async (t) => {
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket));
  const port = await listen(server);
  t.after(() => closeNetServer(server, sockets));
  const savedAddress = process.env.ETCO_server_gspeechMockAddress;
  const savedPort = process.env.ETCO_server_gspeechMockPort;
  t.after(() => {
    if (savedAddress === undefined) delete process.env.ETCO_server_gspeechMockAddress;
    else process.env.ETCO_server_gspeechMockAddress = savedAddress;
    if (savedPort === undefined) delete process.env.ETCO_server_gspeechMockPort;
    else process.env.ETCO_server_gspeechMockPort = savedPort;
    setRecognizerFactory(null);
  });

  delete process.env.ETCO_server_gspeechMockAddress;
  delete process.env.ETCO_server_gspeechMockPort;
  process.env.ETCO_server_gspeechMockAddress = '127.0.0.1';
  process.env.ETCO_server_gspeechMockPort = String(port);
  setRecognizerFactory(null);

  assert.throws(
    () => GoogleASRProvider.startSession({ lang: 'en-US', earlyEOS: [')'] }, log),
    /Invalid regular expression|Unmatched/,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sockets.length, 0, 'invalid configuration must not create an unowned socket');
});

test('Google session honors write backpressure and bounds total audio input', async () => {
  let blocked = true;
  let writes = 0;
  const stream = eventStream({
    write: () => {
      writes += 1;
      return !blocked;
    },
  });
  const session = new GoogleASRSession(stream, { lang: 'en-US' }, log);
  const start = session.start();
  const frame = Buffer.alloc(GOOGLE_MAX_FRAME_BYTES);

  session.provideAudio(frame);
  session.provideAudio(frame);
  assert.equal(writes, 1, 'audio after a false write waits for drain');

  blocked = false;
  stream.emit('drain');
  await tick();
  assert.equal(writes, 2, 'queued audio resumes after drain');

  for (let index = 2; index < (GOOGLE_MAX_TOTAL_AUDIO_BYTES / GOOGLE_MAX_FRAME_BYTES); index += 1) {
    session.provideAudio(frame);
  }
  assert.throws(
    () => session.provideAudio(frame),
    /total audio|input limit|audio limit/i,
  );
  await assert.rejects(start, /total audio|input limit|audio limit/i);
});

test('Google mock recognizer sends config before audio queued before TCP connect', async (t) => {
  const messages = [];
  const received = deferred();
  const sockets = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let index;
      while ((index = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, index).toString('utf8');
        buffer = buffer.subarray(index + 1);
        if (!line) continue;
        messages.push(JSON.parse(line));
        if (messages.length === 2) received.resolve();
      }
    });
  });
  const port = await listen(server);
  t.after(() => closeNetServer(server, sockets));

  const stream = createMockRecognizerStream({ address: '127.0.0.1', port }, { lang: 'en-US' });
  const frame = Buffer.from([1, 2, 3, 4]);
  stream.write(frame);
  await waitFor(received.promise);

  assert.equal(messages[0].type, 'config');
  assert.equal(messages[1].type, 'audio');
  assert.deepEqual(Buffer.from(messages[1].data, 'base64'), frame);
  stream.destroy();
});

test('Google mock recognizer bounds its outbound socket queue while the peer is paused', async (t) => {
  const sockets = [];
  const connected = deferred();
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.pause();
    connected.resolve(socket);
  });
  const port = await listen(server);
  t.after(() => closeNetServer(server, sockets));

  const stream = createMockRecognizerStream({ address: '127.0.0.1', port }, { lang: 'en-US' });
  const clientConnected = once(stream.socket, 'connect');
  const peer = await waitFor(connected.promise);
  await clientConnected;
  assert.ok(peer);
  const frame = Buffer.alloc(GOOGLE_QUEUE_FRAME_BYTES);
  let limitError = null;
  for (let index = 0; index < 1000; index += 1) {
    try {
      stream.write(frame);
    } catch (error) {
      limitError = error;
      break;
    }
  }

  assert.ok(limitError, 'a paused peer must hit the bounded transport queue');
  assert.equal(limitError.code, 'ERR_GOOGLE_OUTBOUND_LIMIT');
  assert.ok(stream.writableLength <= GOOGLE_MAX_OUTBOUND_BUFFER_BYTES);
  stream.destroy();
});

test('Google mock recognizer rejects an unterminated oversized inbound frame', async (t) => {
  const sockets = [];
  const connected = deferred();
  const server = net.createServer((socket) => {
    sockets.push(socket);
    connected.resolve(socket);
  });
  const port = await listen(server);
  t.after(() => closeNetServer(server, sockets));

  const stream = createMockRecognizerStream({ address: '127.0.0.1', port }, { lang: 'en-US' });
  const session = new GoogleASRSession(stream, { lang: 'en-US' }, log);
  const start = session.start();
  const peer = await waitFor(connected.promise);
  peer.write(Buffer.alloc(GOOGLE_MAX_INBOUND_BUFFER_BYTES + 1, 0x78));

  await expectReject(waitFor(start), (error) => /inbound|protocol|buffer/i.test(error.message));
  assert.equal(stream.socket.destroyed, true);
});

// --- Transaction audio lifecycle --------------------------------------------

test('completed CLIENT_ASR and CLIENT_NLU transactions clear pre-LISTEN audio', async (t) => {
  for (const mode of ['CLIENT_ASR', 'CLIENT_NLU']) {
    const { tx } = makeTransaction();
    t.after(() => clearTimeout(tx._txTimer));
    tx.handleMessage({ audio: Buffer.alloc(1024 * 1024) });
    await tx._handleListen(listenMessage(mode));
    tx._handleContext(contextMessage());
    if (mode === 'CLIENT_ASR') {
      await tx._handleClientASR({ data: { text: 'client transcript' } });
    } else {
      await tx._handleClientNLU({ data: { intent: null, rules: [], entities: {}, external: {} } });
    }
    await tx.done;
    assert.equal(tx.audioChunks.length, 0, `${mode}: pre-LISTEN chunks released at terminal state`);
    assert.equal(tx.audioBufferedBytes, 0, `${mode}: pre-LISTEN byte count released at terminal state`);
  }
});

test('server ASR flushes pre-LISTEN audio before terminal cleanup', async (t) => {
  const received = [];
  const audio = Buffer.from('first utterance audio');
  const session = {
    onStartOfSpeech() {},
    onEndOfSpeech() {},
    provideAudio(chunk) { received.push(Buffer.from(chunk)); },
    start() { return Promise.resolve({ text: 'first utterance', confidence: 0.9 }); },
    stop() {},
    getLastIncremental() { return { text: '', confidence: 0 }; },
  };
  const { tx } = makeTransaction({ asrProvider: () => session });
  t.after(() => clearTimeout(tx._txTimer));
  tx.handleMessage({ audio });
  tx.handleMessage({ json: listenMessage(undefined) });
  await tick();
  tx.handleMessage({ json: contextMessage() });
  await tx.done;

  assert.deepEqual(received, [audio]);
  assert.equal(tx.audioChunks.length, 0);
  assert.equal(tx.audioBufferedBytes, 0);
});

// --- withTimeout rejection cleanup ------------------------------------------

test('withTimeout clears its timer when the wrapped promise rejects', async (t) => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let timeoutTimer;
  let timeoutCleared = false;
  global.setTimeout = (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === 10_000) timeoutTimer = timer;
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer === timeoutTimer) timeoutCleared = true;
    return realClearTimeout(timer);
  };
  t.after(() => {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    if (timeoutTimer) realClearTimeout(timeoutTimer);
  });

  const { tx } = makeTransaction({
    parser: { handleNLU: () => Promise.reject(new Error('parser rejected')) },
  });
  t.after(() => clearTimeout(tx._txTimer));
  tx.listenMessage = { data: { rules: [] } };
  tx.asrData = { text: 'timer cleanup' };
  tx.contextPr.resolve(contextMessage());

  await assert.rejects(tx._performNLU(), /parser rejected/);
  assert.ok(timeoutTimer, 'parser timeout timer was installed');
  assert.equal(timeoutCleared, true, 'rejection clears the parser timeout');
});

test('proactive withTimeout clears its timer when context rejects', async (t) => {
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  let timeoutTimer;
  let timeoutCleared = false;
  global.setTimeout = (fn, ms, ...args) => {
    const timer = realSetTimeout(fn, ms, ...args);
    if (ms === 30_000) timeoutTimer = timer;
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer === timeoutTimer) timeoutCleared = true;
    return realClearTimeout(timer);
  };
  t.after(() => {
    global.setTimeout = realSetTimeout;
    global.clearTimeout = realClearTimeout;
    if (timeoutTimer) realClearTimeout(timeoutTimer);
  });

  const tx = new ProactiveTransaction(
    { _jiboHeaders: {}, _auth: null, _remoteAddress: '127.0.0.1' },
    { config: { recordLaunchHistory: false }, skills: [] },
    { write() {} },
    log,
  );
  t.after(() => clearTimeout(tx._txTimer));
  const operation = tx._handleTrigger({ data: { triggerSource: 'SURPRISE' } });
  tx.contextPr.reject(new Error('context rejected'));

  await expectReject(operation, (error) => /context rejected/.test(error.message));
  assert.ok(timeoutTimer, 'proactive context timeout timer was installed');
  assert.equal(timeoutCleared, true, 'proactive rejection clears its timeout');
});
// --- Parakeet response bounds ------------------------------------------------

test('Parakeet caps oversized error responses and destroys the request', async (t) => {
  const body = Buffer.alloc(PARakeet_OVERSIZED_RESPONSE_BYTES, 0x45);
  const { server, responseClosed } = await responseServer(502, body, { contentLength: false });
  t.after(() => closeNetServer(server));
  const session = new ParakeetASRSession(`http://127.0.0.1:${server.address().port}`, { lang: 'en-US' }, log);

  const error = await expectReject(
    waitFor(session._postToParakeet(Buffer.from('audio')), 3000),
    (value) => value && value.code === 'ERR_PARAKEET_RESPONSE_TOO_LARGE',
  );
  assert.ok(error.message.length < 2048, 'diagnostic must not copy the response body into Error.message');
  await waitFor(responseClosed.promise);
});

test('Parakeet caps oversized success responses before parsing the transcript', async (t) => {
  const body = Buffer.from(JSON.stringify({ transcript: 'x'.repeat(PARakeet_OVERSIZED_RESPONSE_BYTES) }));
  const { server, responseClosed } = await responseServer(200, body, { contentLength: false });
  t.after(() => closeNetServer(server));
  const session = new ParakeetASRSession(`http://127.0.0.1:${server.address().port}`, { lang: 'en-US' }, log);

  await expectReject(
    waitFor(session._postToParakeet(Buffer.from('audio')), 3000),
    (value) => value && value.code === 'ERR_PARAKEET_RESPONSE_TOO_LARGE',
  );
  await waitFor(responseClosed.promise);
});

test('Parakeet diagnostic truncation counts UTF-8 bytes without splitting a code point', () => {
  const input = '🙂'.repeat(600);
  const diagnostic = truncateUtf8ByBytes(input, 1024);

  assert.equal(Buffer.byteLength(diagnostic, 'utf8'), 1024);
  assert.equal(diagnostic, '🙂'.repeat(256));
});

test('Parakeet diagnostic truncation stays bounded for malformed UTF-8 input', () => {
  const input = Buffer.concat([
    Buffer.from('prefix ', 'utf8'),
    Buffer.from([0xe2, 0x82]),
    Buffer.from(' suffix', 'utf8'),
  ]);
  const diagnostic = truncateUtf8ByBytes(input, 10);

  assert.equal(diagnostic, 'prefix �');
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 10);
});

test('Parakeet error diagnostics keep their UTF-8 byte cap and useful suffix', async (t) => {
  const body = Buffer.from('🙂'.repeat(600), 'utf8');
  const { server, responseClosed } = await responseServer(502, body, { contentLength: false });
  t.after(() => closeNetServer(server));
  const session = new ParakeetASRSession(`http://127.0.0.1:${server.address().port}`, { lang: 'en-US' }, log);

  const error = await expectReject(
    waitFor(session._postToParakeet(Buffer.from('audio')), 3000),
    (value) => value && value.message.startsWith('Parakeet returned 502: '),
  );
  const diagnostic = error.message.slice('Parakeet returned 502: '.length);

  assert.equal(Buffer.byteLength(diagnostic, 'utf8'), 1023);
  assert.equal(diagnostic.endsWith('…'), true);
  assert.equal(diagnostic.slice(0, -1), '🙂'.repeat(255));
  await waitFor(responseClosed.promise);
});
