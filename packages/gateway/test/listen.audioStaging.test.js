// R-03 criterion 2 (bounded memory): what does a transaction retain from audio it
// will never consume, and what bounds it?
//
// Source contract (pinned jiboV2/pegasus@5c0a7390),
// packages/hub/src/listen/ListenTransactionHandler.ts:
//
//   private audioStream = new AudioBuffer();          // Duplex, live from construction
//   protected async handleAudio(buffer) {
//       if (this.audioStream) { this.audioStream.write(buffer); }
//       else { this.logger.debug('Got audio packet but audio stream is closed'); }
//   }
//   private async stopASR() {
//       if (this.asrSession) { this.asrSession.stop(); this.asrSession = null; }
//       if (this.audioStream) { this.audioStream.end(); this.audioStream = null; }
//       this.clearSOSTimeout(); this.clearMaxSpeechTimeout();
//   }
//
// Two facts follow, and they are the whole bound:
//
//  1. The audio path exists from construction, so audio that arrives before a
//     session does is KEPT (it reaches the Duplex's readable side and is emitted
//     to whatever reader attaches later). Neither implementation may drop it.
//  2. Leaving the ASR state calls stopASR(), which ends AND NULLS the stream, so
//     every later packet is dropped. A turn that never enters ASR (CLIENT_ASR,
//     CLIENT_NLU) never calls it, so on that path the reference buffers until the
//     socket itself goes away.
//
// There is no byte cap in the source. What bounds the retained set is therefore the
// socket's lifetime, which the gateway limits with closeAfterFinal once a turn has
// written its final frame. The tests below pin both halves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';

const { createGateway } = await import('@phoenix/gateway');
const { ListenTransaction } = await import('../src/listenTransaction.js');

const SECRET = 'r03-staging-secret';
const BASE = {
  hubTokenSecret: SECRET,
  disableAuth: false,
  accountUrl: '',
  parserURL: 'http://127.0.0.1:9',
  historyURL: 'http://127.0.0.1:9',
  skills: [],
};
const token = () => jwt.sign({ id: 'acct-stage', friendlyId: 'robot-stage' }, SECRET);

// 4096 bytes == 128 ms of 16 kHz mono linear16.
const FRAME = Buffer.alloc(4096, 0x11);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function unitTransaction() {
  const frames = [];
  const tx = new ListenTransaction(
    { _jiboHeaders: {}, _auth: { id: 'acct-unit', friendlyId: 'robot-unit' }, _remoteAddress: '127.0.0.1' },
    {
      config: { recordLaunchHistory: false, recordSpeechHistory: false },
      skillConfigManager: { isOnRobotSkill: () => true },
      intentRouter: { getSkillIDFromNLU: () => ({ skillID: 'on-robot-skill' }) },
    },
    { write: (frame) => frames.push(frame) },
    quiet,
  );
  return { tx, frames };
}

test('audio arriving before a session exists is kept, as the reference keeps it', () => {
  const { tx } = unitTransaction();
  tx.handleMessage({ audio: FRAME });
  tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, 2, 'pre-session audio must not be dropped');
});

test('audio after stopASR is dropped, and after abandon too', () => {
  const { tx } = unitTransaction();
  tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, 1);

  // What leaving the ASR state does in the reference: end and null the stream.
  tx._stopASR();
  for (let i = 0; i < 100; i += 1) tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, 1, 'audio after stopASR is dropped, not retained');

  tx.abandon();
  const afterAbandon = tx.audioChunks.length;
  for (let i = 0; i < 100; i += 1) tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, afterAbandon, 'audio after abandon is dropped');
});

test('a fresh ASR phase reopens the audio path', () => {
  const { tx } = unitTransaction();
  tx._stopASR();
  tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, 0, 'closed path drops');
  // _performASR reopens it, so a later turn on the same transaction still stages.
  tx.audioStreamClosed = false;
  tx.handleMessage({ audio: FRAME });
  assert.equal(tx.audioChunks.length, 1);
});

test('the socket stays open after the final frame, so the client close is the outer bound', async () => {
  // Documented parity decision (responseWrapper.js:7-15): the wrapper deliberately
  // does NOT close the socket. The reference initializes `closed = true` while only
  // socket.onclose ever sets it, so its close-by-timeout is dead code, and the
  // captured original shows connectionOpenAfterFinal:true then
  // clientCloseAfterFinal:true -- the CLIENT closes on the final frame
  // (hub-client/src/session/ClientSession.ts:21-26,49-51).
  //
  // This matters for the bound: with no server-side close, what a streaming robot
  // can leave in the transaction is bounded by (a) the drop after stopASR and
  // (b) the client closing. This test pins (b)'s premise so a future accidental
  // server-side close is a deliberate change rather than a silent one.
  const http = await import('node:http');
  const parser = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { intent: 'staging-intent', rules: ['launch'], entities: {} } }));
    });
  });
  await new Promise((resolve) => parser.listen(0, '127.0.0.1', resolve));

  const gateway = await createGateway({ ...BASE, parserURL: `http://127.0.0.1:${parser.address().port}` });
  await gateway.service.listen(0);
  const port = gateway.service.server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/listen`, { headers: { Authorization: `Bearer ${token()}` } });
  const received = [];
  let closedAt = null;
  try {
    await once(ws, 'open');
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      received.push(message);
      if (message.final) { for (let i = 0; i < 50; i += 1) ws.send(FRAME); }
    });
    ws.on('close', () => { closedAt = Date.now(); });
    ws.send(JSON.stringify({ type: 'LISTEN', data: { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules: ['launch'] } }));
    ws.send(JSON.stringify({ type: 'CONTEXT', data: { general: {}, runtime: { loop: {} } } }));
    ws.send(JSON.stringify({ type: 'CLIENT_ASR', data: { text: 'staging probe' } }));

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(received.map((m) => m.type), ['SOS', 'EOS', 'LISTEN']);
    // 250 binary frames were pushed after the final write and the turn is over:
    // they produce no output at all, and the server leaves the socket to the client.
    assert.equal(closedAt, null, 'the server does not close after final; the client does');
    assert.equal(received.length, 3, 'post-turn audio produces no further frames');
  } finally {
    try { ws.close(); } catch { /* already closed */ }
    await new Promise((resolve) => gateway.wss.close(() => resolve()));
    await new Promise((resolve, reject) => gateway.service.server.close((e) => (e ? reject(e) : resolve())));
    await new Promise((resolve) => parser.close(resolve));
  }
});
