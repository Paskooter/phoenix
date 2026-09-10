// H-02: listen-transaction wire behaviour over a real WebSocket gateway.
//
// Everything here runs against the real `ws` transport, the real gateway router
// (index.js writes the failing transaction's ERROR frame exactly like the pinned
// ListenHandler.ts:46-60) and real peers, so the observed frames are what a robot
// receives. Covers: both endpoint aliases, SOS/EOS ordering, close timing after
// the terminal frame, no late writes, malformed input, every reachable error code
// and the disconnect-free failure paths.
//
// Reference citations are file:line into the pinned Pegasus tree
// 5c0a7390539663ba749d360de348a428c088505c, packages/hub/src/.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../src/index.js';
import { jwt } from '@phoenix/common';

const SECRET = 'h02-listen-secret';
const token = () => jwt.sign({ id: 'acct-h02', friendlyId: 'robot-h02', accessKeyId: 'k' }, SECRET);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const contextFrame = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-h02', robotID: 'robot-h02', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: {},
  },
});
const listenClientAsr = () => ({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], hotphrase: true, mode: 'CLIENT_ASR' } });
const listenClientNlu = () => ({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], mode: 'CLIENT_NLU' } });
const listenServerAsr = () => ({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'] } });

/** Parser peer: no-match (200), failing (503) or hanging (never answers). */
async function startParser(mode) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (mode === 'hang') return;
    if (mode === 'fail') { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ message: 'down' })); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { intent: null, rules: ['launch'], entities: {} } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function startGateway(t, { parserURL = 'http://127.0.0.1:1' } = {}) {
  const gateway = await createGateway({
    skills: [],
    parserURL,
    historyURL: 'http://127.0.0.1:1',
    disableAuth: false,
    hubTokenSecret: SECRET,
    recordLaunchHistory: false,
    recordSpeechHistory: false,
    asrProvider: 'none',
  });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  t.after(async () => {
    for (const socket of gateway.wss.clients) socket.terminate();
    gateway.wss.close();
    await new Promise((resolve) => gateway.service.server.close(resolve));
  });
  return { gateway, port };
}

/** Open a listen socket and record every frame plus the close time. */
function openSocket(t, port, path = '/v1/listen') {
  const state = { frames: [], closedAt: null };
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:h02' },
  });
  ws.on('message', (data) => state.frames.push(JSON.parse(data.toString())));
  ws.on('close', () => { state.closedAt = Date.now(); });
  t.after(() => { try { ws.terminate(); } catch { /* already gone */ } });
  return { ws, state };
}

/** Resolve once a terminal frame has arrived (or the socket closed). */
function finalFrame(state, ms = 20000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + ms;
    const poll = () => {
      const terminal = state.frames.find((frame) => frame.final);
      if (terminal) return resolve(terminal);
      if (Date.now() > deadline) return reject(new Error(`no terminal frame; got ${JSON.stringify(state.frames.map((f) => f.type))}`));
      setTimeout(poll, 5);
    };
    poll();
  });
}

const types = (state) => state.frames.map((frame) => frame.type);

for (const path of ['/listen', '/v1/listen']) {
  test(`${path}: CLIENT_ASR turn emits SOS, EOS, one terminal LISTEN`, async (t) => {
    const parser = await startParser('nomatch');
    t.after(() => { parser.server.closeAllConnections(); parser.server.close(); });
    const { port } = await startGateway(t, { parserURL: parser.url });
    const { ws, state } = openSocket(t, port, path);
    await once(ws, 'open');
    ws.send(JSON.stringify(listenClientAsr()));
    ws.send(JSON.stringify(contextFrame()));
    ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'blurf gnax' } }));
    const terminal = await finalFrame(state);

    assert.deepEqual(types(state), ['SOS', 'EOS', 'LISTEN']);
    assert.deepEqual(state.frames.map((frame) => frame.final === true), [false, false, true]);
    assert.equal(terminal.type, 'LISTEN');
    assert.equal(terminal.data.match, null);
    assert.equal(terminal.data.asr.text, 'blurf gnax');
    assert.equal(state.frames[0].data, null);
    assert.equal(state.frames[1].data, null);
    assert.equal(state.frames[0].timings.total, -1, 'client-supplied turn fakes SOS timings');
    assert.equal(state.frames[1].timings.total, -1, 'client-supplied turn fakes EOS timings');
    ws.close();
    await once(ws, 'close');
  });
}

test('the hub leaves the socket open after the terminal frame (no close-after-final)', async (t) => {
  const parser = await startParser('nomatch');
  t.after(() => { parser.server.closeAllConnections(); parser.server.close(); });
  const { port } = await startGateway(t, { parserURL: parser.url });
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenClientNlu()));
  ws.send(JSON.stringify(contextFrame()));
  ws.send(JSON.stringify({ type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { intent: null, rules: ['launch'], entities: {} } }));
  const terminal = await finalFrame(state);
  const finalAt = Date.now();
  assert.equal(terminal.final, true);

  // The pinned ResponseWrapper starts with `closed = true`
  // (BaseWebsocketHandler.ts:26) and only `socket.onclose` ever clears it, so its
  // 2 s close-after-final timer and its 3 min max-duration timer can never fire.
  // The captured original agrees: hub-listen-launch records
  // connectionOpenAfterFinal true at 50 ms with clientCloseAfterFinal true.
  await wait(2500);
  assert.equal(state.closedAt, null, 'the hub must not close the socket 2 s after the terminal frame');
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(Date.now() - finalAt >= 2500, true);

  ws.close();
  await once(ws, 'close');
  assert.notEqual(state.closedAt, null, 'the client close is observed');
});

test('no writes are emitted after the terminal frame', async (t) => {
  const parser = await startParser('nomatch');
  t.after(() => { parser.server.closeAllConnections(); parser.server.close(); });
  const { port } = await startGateway(t, { parserURL: parser.url });
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenClientNlu()));
  ws.send(JSON.stringify(contextFrame()));
  ws.send(JSON.stringify({ type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { intent: null, rules: ['launch'], entities: {} } }));
  await finalFrame(state);
  const after = state.frames.length;

  // A second turn on an already-ended response is dropped by ResponseWrapper.write
  // (BaseWebsocketHandler.ts:96-99, `ended`).
  ws.send(JSON.stringify(listenClientAsr()));
  ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: 'a2', ts: Date.now(), data: { text: 'late words' } }));
  await wait(400);
  assert.equal(state.frames.length, after, 'nothing is written after the terminal frame');
  ws.close();
  await once(ws, 'close');
});

test('malformed JSON produces a terminal ERROR frame', async (t) => {
  const { port } = await startGateway(t);
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send('THIS IS NOT A JSON');
  const terminal = await finalFrame(state);
  assert.deepEqual(types(state), ['ERROR']);
  assert.equal(terminal.data.message, 'Invalid JSON arrived into socket: THIS IS NOT A JSON');
  assert.equal('code' in terminal.data, false, 'a non-HubError failure carries no code');
  ws.close();
  await once(ws, 'close');
});

test('unknown message type produces a terminal ERROR frame', async (t) => {
  const { port } = await startGateway(t);
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'LISTEN_ME', msgID: 'x', ts: Date.now(), data: {} }));
  const terminal = await finalFrame(state);
  assert.deepEqual(types(state), ['ERROR']);
  assert.equal(terminal.data.message, 'Unknown message type: LISTEN_ME');
  ws.close();
  await once(ws, 'close');
});

test('an invalid LISTEN mode produces a terminal ERROR frame', async (t) => {
  const { port } = await startGateway(t);
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], mode: 'WHATEVER' } }));
  const terminal = await finalFrame(state);
  assert.deepEqual(types(state), ['ERROR']);
  assert.equal(terminal.data.message, "Invalid value for mode 'WHATEVER'");
  ws.close();
  await once(ws, 'close');
});

test('a parser failure keeps the reference PARSER code', async (t) => {
  const parser = await startParser('fail');
  t.after(() => { parser.server.closeAllConnections(); parser.server.close(); });
  const { port } = await startGateway(t, { parserURL: parser.url });
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenClientAsr()));
  ws.send(JSON.stringify(contextFrame()));
  ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'provider failure' } }));
  const terminal = await finalFrame(state);

  // Captured original hub-listen-provider-failure:
  // {"type":"ERROR","data":{"code":"PARSER","message":"Request failed with status code 503"},"final":true}
  assert.deepEqual(types(state), ['SOS', 'EOS', 'ERROR']);
  assert.equal(terminal.final, true);
  assert.equal(terminal.data.code, 'PARSER');
  assert.match(terminal.data.message, /503/);
  ws.close();
  await once(ws, 'close');
});

test('a parser timeout also reaches the robot as PARSER (reference re-wrap)', { timeout: 30000 }, async (t) => {
  const parser = await startParser('hang');
  t.after(() => { parser.server.closeAllConnections(); parser.server.close(); });
  const { port } = await startGateway(t, { parserURL: parser.url });
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenClientAsr()));
  ws.send(JSON.stringify(contextFrame()));
  ws.send(JSON.stringify({ type: 'CLIENT_ASR', msgID: 'a', ts: Date.now(), data: { text: 'slow parser' } }));
  const terminal = await finalFrame(state, 25000);

  // ListenTransactionHandler.ts:304-321: the TIMEOUT_PARSER throw happens inside
  // the try whose catch re-throws HubErrorCode.PARSER, so the robot sees PARSER.
  assert.deepEqual(types(state), ['SOS', 'EOS', 'ERROR']);
  assert.equal(terminal.data.code, 'PARSER');
  assert.equal(terminal.data.message, 'Timeout of 10000 while waiting for parser');
  ws.close();
  await once(ws, 'close');
});

test('a missing CONTEXT produces TIMEOUT_CONTEXT after 5 s', { timeout: 30000 }, async (t) => {
  const { port } = await startGateway(t);
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenClientNlu()));
  ws.send(JSON.stringify({ type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { intent: null, rules: ['launch'], entities: {} } }));
  const terminal = await finalFrame(state, 20000);

  assert.deepEqual(types(state), ['SOS', 'EOS', 'ERROR']);
  assert.equal(terminal.data.code, 'TIMEOUT_CONTEXT');
  assert.equal(terminal.data.message, 'Timeout of 5000 while waiting for the context message');
  ws.close();
  await once(ws, 'close');
});

test('an ASR provider failure produces ERROR code ASR', async (t) => {
  const { gateway, port } = await startGateway(t);
  gateway.components.asrProvider = () => ({
    onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {}, getLastIncremental() { return null; },
    start: async () => { throw new Error('asr backend exploded'); },
  });
  const { ws, state } = openSocket(t, port);
  await once(ws, 'open');
  ws.send(JSON.stringify(listenServerAsr()));
  const terminal = await finalFrame(state);

  // ListenTransactionHandler.ts:452-484: the outer catch re-wraps every ASR
  // failure — the reference's own TIMEOUT_ASR throw included — as ASR.
  assert.deepEqual(types(state), ['ERROR']);
  assert.equal(terminal.data.code, 'ASR');
  assert.equal(terminal.data.message, 'asr backend exploded');
  ws.close();
  await once(ws, 'close');
});

test('a query string on the listen path is rejected at the upgrade', async (t) => {
  const { port } = await startGateway(t);
  // A raw HTTP upgrade probe: the ws client keeps a rejected handshake in
  // CONNECTING and reports it through two different events, so drive the socket
  // directly and read the HTTP status off the wire.
  const { connect } = await import('node:net');
  const status = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /listen?robot=1 HTTP/1.1', 'Host: 127.0.0.1', 'Upgrade: websocket', 'Connection: Upgrade',
        `Authorization: Bearer ${token()}`, 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    let raw = '';
    socket.on('data', (chunk) => { raw += chunk.toString('utf8'); });
    socket.on('end', () => resolve(raw));
    socket.on('close', () => resolve(raw));
    socket.on('error', reject);
  });
  assert.match(status, /^HTTP\/1\.1 404 /, `expected a 404 upgrade rejection, got: ${status.split('\r\n')[0]}`);
});
