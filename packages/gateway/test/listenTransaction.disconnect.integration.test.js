import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket from 'ws';
import { createGateway } from '../src/index.js';
import { ListenTransaction } from '../src/listenTransaction.js';
import { HistoryClient } from '../src/historyClient.js';
import { jwt } from '@phoenix/common';

function waitFor(predicate, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for controlled lifecycle event'));
      setTimeout(poll, 2);
    };
    poll();
  });
}

test('actual listen close waits for delayed skill completion and records the side effect', async () => {
  const transactionEvents = [];
  const historyWrites = [];
  const originalResolve = ListenTransaction.prototype.resolve;
  const originalReject = ListenTransaction.prototype.reject;
  const originalHistoryWrite = HistoryClient.prototype.writeSkillLaunch;
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 60000 ? 250 : ms, ...args);
  ListenTransaction.prototype.resolve = function (...args) {
    transactionEvents.push({ kind: 'resolve', at: Date.now(), state: this.state });
    return originalResolve.apply(this, args);
  };
  ListenTransaction.prototype.reject = function (error, ...args) {
    transactionEvents.push({ kind: 'reject', at: Date.now(), code: error && error.code, state: this.state });
    return originalReject.call(this, error, ...args);
  };
  HistoryClient.prototype.writeSkillLaunch = function (data) {
    historyWrites.push(data);
    return Promise.resolve();
  };

  const requests = [];
  let requestDone;
  const requestSeen = new Promise(resolve => { requestDone = resolve; });
  const peer = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push(body);
      requestDone();
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ type: 'SKILL_ACTION', msgID: 'integration-peer', ts: 1700000000000, data: { skill: { id: 'source', session: { id: 'integration-session' } }, action: { kind: 'delayed' } } }));
      }, 30);
    });
  });
  await new Promise((resolve, reject) => { peer.once('error', reject); peer.listen(0, '127.0.0.1', resolve); });
  const gateway = await createGateway({
    skills: [{ id: 'source', URL: `http://127.0.0.1:${peer.address().port}/v1/main`, intents: [{ name: 'launch-intent' }] }],
    parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
    disableAuth: false, hubTokenSecret: 'h04-integration-secret', recordLaunchHistory: true,
    recordSpeechHistory: false, asrProvider: 'none',
  });
  try {
    await gateway.service.listen(0);
    const port = gateway.service.server.address().port;
    const client = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, { headers: { authorization: `Bearer ${jwt.sign({ id: 'account-h04', friendlyId: 'robot-h04' }, 'h04-integration-secret')}` } });
    const frames = [];
    const opened = new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    const closed = new Promise(resolve => client.once('close', resolve));
    client.on('message', value => frames.push(JSON.parse(value.toString())));
    await opened;
    const message = (type, data) => JSON.stringify({ type, msgID: `integration-${type}`, ts: 1700000000000, data });
    client.send(message('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] }), () => {
      client.send(message('CONTEXT', { general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' }, runtime: { perception: { speaker: 'integration-person', peoplePresent: [] }, dialog: {}, loop: { users: [] } }, skill: {} }), () => {
        client.send(message('CLIENT_NLU', { intent: 'launch-intent', rules: ['launch'], entities: {}, external: {} }));
      });
    });
    await requestSeen;
    const closeAt = Date.now();
    // Abort the transport at the same provider-request boundary as the source
    // EventEmitter close control; a graceful close can wait for the peer's
    // delayed response before the server observes the close event.
    client.terminate();
    await closed;
    await new Promise(resolve => realSetTimeout(resolve, 10));
    assert.equal(transactionEvents.some(event => event.kind === 'resolve' || event.kind === 'reject'), false, 'close must not settle an unfinished listen');
    await waitFor(() => historyWrites.length === 1);
    assert.equal(transactionEvents.filter(event => event.kind === 'resolve').length, 1);
    assert.equal(transactionEvents[0].kind, 'resolve');
    assert.ok(transactionEvents[0].at > closeAt);
    assert.deepEqual(requests.map(request => request.type), ['LISTEN_LAUNCH']);
    assert.deepEqual(frames.map(frame => frame.type), ['SOS', 'EOS', 'LISTEN']);
    assert.equal(historyWrites[0].sessionID, 'integration-session');
  } finally {
    ListenTransaction.prototype.resolve = originalResolve;
    ListenTransaction.prototype.reject = originalReject;
    HistoryClient.prototype.writeSkillLaunch = originalHistoryWrite;
    global.setTimeout = realSetTimeout;
    await new Promise(resolve => gateway.service.server.close(resolve));
    await new Promise(resolve => peer.close(resolve));
  }
});
