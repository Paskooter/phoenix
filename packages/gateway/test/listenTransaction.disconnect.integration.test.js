import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import { createGateway } from '../src/index.js';
import { ListenTransaction } from '../src/listenTransaction.js';
import { jwt } from '@phoenix/common';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

// Real transports and a held HTTP response make the sequence deterministic:
// no provider can finish before the test observes the server's socket close.
// Only the production transaction deadline is triggered by the test clock.
for (const scenario of ['close before input', 'provider finishes after close', 'provider finishes after timeout']) {
  test(`listen lifecycle: ${scenario}`, { timeout: 5000 }, async t => {
    const realSetTimeout = global.setTimeout;
    let deadline;
    global.setTimeout = (fn, ms, ...args) => {
      const timer = realSetTimeout(fn, ms, ...args);
      if (ms === 60000) {
        assert.equal(deadline, undefined, 'one whole-transaction deadline');
        deadline = () => { clearTimeout(timer); fn(...args); };
      }
      return timer;
    };
    t.after(() => { global.setTimeout = realSetTimeout; });

    const descriptor = Object.getOwnPropertyDescriptor(ListenTransaction.prototype, 'done');
    let transaction;
    let outer;
    let internal;
    const outerSettled = deferred();
    const internalSettled = deferred();
    Object.defineProperty(ListenTransaction.prototype, 'done', {
      ...descriptor,
      get() {
        transaction = this;
        const promise = descriptor.get.call(this);
        promise.then(
          () => { outer = { outcome: 'resolved' }; outerSettled.resolve(); },
          error => { outer = { outcome: 'rejected', error }; outerSettled.resolve(); },
        );
        this._handle.promise.then(
          () => { internal = { outcome: 'resolved' }; internalSettled.resolve(); },
          error => { internal = { outcome: 'rejected', error }; internalSettled.resolve(); },
        );
        return promise;
      },
    });
    t.after(() => Object.defineProperty(ListenTransaction.prototype, 'done', descriptor));

    const requestSeen = deferred();
    const releaseProvider = deferred();
    const providerFinished = deferred();
    const requests = [];
    const peer = http.createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      requests.push(JSON.parse(raw));
      requestSeen.resolve();
      await releaseProvider.promise;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'SKILL_ACTION', msgID: 'integration-peer', ts: 1700000000000,
        data: { skill: { id: 'source', session: { id: 'integration-session' } }, action: { kind: 'delayed' } } }));
      providerFinished.resolve();
    });
    peer.listen(0, '127.0.0.1');
    await once(peer, 'listening');
    t.after(async () => {
      releaseProvider.resolve();
      peer.closeAllConnections();
      await new Promise(resolve => peer.close(resolve));
    });

    const gateway = await createGateway({
      skills: [{ id: 'source', URL: `http://127.0.0.1:${peer.address().port}/v1/main`, intents: [{ name: 'launch-intent' }] }],
      parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
      disableAuth: false, hubTokenSecret: 'h04-integration-secret', recordLaunchHistory: true,
      recordSpeechHistory: false, asrProvider: 'none',
    });
    const history = [];
    gateway.components.historyClient.writeSkillLaunch = async data => { history.push(data); };
    t.after(async () => {
      clearTimeout(transaction?._txTimer);
      for (const socket of gateway.wss.clients) socket.terminate();
      await new Promise(resolve => gateway.service.server.close(resolve));
    });
    const connection = once(gateway.wss, 'connection');
    await gateway.service.listen(0);
    const client = new WebSocket(`ws://127.0.0.1:${gateway.service.server.address().port}/v1/listen`, {
      headers: { authorization: `Bearer ${jwt.sign({ id: 'account-h04', friendlyId: 'robot-h04' }, 'h04-integration-secret')}` },
    });
    t.after(() => client.terminate());
    const frames = [];
    const initialFrames = deferred();
    client.on('message', value => {
      frames.push(JSON.parse(value.toString()));
      if (frames.length === 3) initialFrames.resolve();
    });
    await once(client, 'open');
    const [serverSocket] = await connection;
    const serverClosed = once(serverSocket, 'close');
    const clientClosed = once(client, 'close');
    assert.equal(typeof deadline, 'function');

    if (scenario !== 'close before input') {
      const send = (type, data) => client.send(JSON.stringify({ type, msgID: `integration-${type}`, ts: 1700000000000, data }));
      send('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] });
      send('CONTEXT', {
        general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' },
        runtime: { perception: { speaker: 'integration-person', peoplePresent: [] }, dialog: {}, loop: { users: [] } }, skill: {},
      });
      send('CLIENT_NLU', { intent: 'launch-intent', rules: ['launch'], entities: {}, external: {} });
      await Promise.all([requestSeen.promise, initialFrames.promise]);
    }
    client.terminate();
    await Promise.all([serverClosed, clientClosed]);
    // The close listeners and promise continuations have run by this point.
    assert.equal(outer, undefined, 'disconnect must not settle the outer transaction');
    assert.equal(internal, undefined, 'disconnect must not settle the internal transaction');
    assert.deepEqual(history, []);

    if (scenario !== 'provider finishes after close') {
      deadline();
      await outerSettled.promise;
      assert.equal(outer.outcome, 'rejected');
      assert.ok(outer.error instanceof Error);
      assert.equal(outer.error.code, undefined, 'source transaction deadline has no HubError code');
      assert.equal(internal, undefined, 'outer deadline must not stop the internal transaction');
    }
    if (scenario !== 'close before input') {
      releaseProvider.resolve();
      await Promise.all([providerFinished.promise, internalSettled.promise, outerSettled.promise]);
      assert.equal(internal.outcome, 'resolved');
      assert.equal(outer.outcome, scenario === 'provider finishes after close' ? 'resolved' : 'rejected');
      assert.deepEqual(requests.map(request => request.type), ['LISTEN_LAUNCH']);
      assert.deepEqual(history, [{ robotID: 'robot-h04', sessionID: 'integration-session', skillID: 'source', intent: 'launch-intent', personIDs: ['integration-person'] }]);
      assert.deepEqual(frames.map(frame => frame.type), ['SOS', 'EOS', 'LISTEN']);
    } else {
      assert.deepEqual(requests, []);
      assert.deepEqual(frames, []);
    }
  });
}
