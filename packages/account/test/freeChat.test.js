import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../src/index.js';
import { Store } from '../src/store.js';
import { createSession } from '../src/sessions.js';
import { signSigV4, recentLogs } from '@phoenix/common';

const originalFetch = globalThis.fetch;
let calls = 0;
before(() => {
  globalThis.fetch = (input, options) => {
    assert.equal(new URL(typeof input === 'string' ? input : input.url).hostname, '127.0.0.1', 'all egress is loopback');
    calls++;
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; assert.ok(calls > 0); });
const counters = () => ({ day: '', dayRequests: 0, dayMicroUsd: 0, minute: 0, minuteRequests: 0 });
const body = { text: 'Synthetic conversation sentinel', detail: 'short', history: [] };
async function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'free-chat-'));
  const requests = []; let responder; let clock = Date.now();
  const mock = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const request = { authorization: req.headers.authorization, body: JSON.parse(text) }; requests.push(request);
    if (responder) return responder(req, res, request);
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text: 'Synthetic answer sentinel', keepTalking: false }) }, finish_reason: 'stop' }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const store = new Store(join(root, 'account.json'));
  for (const id of ['one', 'two']) {
    store.accounts.set(id, { _id: id, isActive: true, sessionVersion: 0, email: id + '@example.invalid' });
    store.accounts.set('robot-' + id, { _id: 'robot-' + id, friendlyId: 'synthetic-' + id, isActive: true,
      accessKeyId: id === 'one' ? 'SYNTHETICACCESSKEYONE1' : 'SYNTHETICACCESSKEYTWO2', secretAccessKey: 'synthetic-secret-' + id });
    store.loops.set('loop-' + id, { _id: 'loop-' + id, robot: 'robot-' + id, owner: id, members: [] });
  }
  store.flush();
  writeFileSync(join(root, 'usage.json'), JSON.stringify({ ...counters(), version: 1, lifetimeMicroUsd: 0, accounts: {} }));
  const session = createSession(store, { kind: 'user', accountId: 'one' });
  const config = { ledgerFile: join(root, 'usage.json'), encryptionKey: Buffer.alloc(32, 7),
    provider: { apiKey: 'synthetic-owner-key', mockUrl: `http://127.0.0.1:${mock.address().port}/chat` },
    now: () => clock, ...overrides };
  let service; let base;
  async function start() { service = createAccountService({ store, freeChat: config }); await service.listen(0, '127.0.0.1'); base = `http://127.0.0.1:${service.server.address().port}`; }
  t.after(async () => {
    service?.server.closeAllConnections(); mock.closeAllConnections();
    await Promise.all([service ? new Promise(r => service.server.close(r)) : null, new Promise(r => mock.close(r))]);
    rmSync(root, { recursive: true, force: true });
  });
  await start();
  const call = (path, method = 'GET', data, headers = {}) => fetch(base + path, { method, signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const cookie = { cookie: 'phx_session=' + session._id };
  return { root, store, requests, config, cookie, call, get service() { return service; },
    responder(fn) { responder = fn; }, advance(ms) { clock += ms; },
    async restart() { service.server.closeAllConnections(); await new Promise(r => service.server.close(r)); await start(); },
    robot(operation = 'complete', data = body, id = 'one') {
      const path = '/api/free-chat/robot/' + operation; const text = JSON.stringify(data);
      const account = store.accounts.get('robot-' + id);
      const headers = signSigV4({ method: 'POST', path, headers: { host: new URL(base).host, 'content-type': 'application/json' },
        body: text, accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
      return fetch(base + path, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(10000) });
    } };
}

test('default-on authenticated robot chit-chat uses free model and off restores classic without inference', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/free-chat')).status, 401);
  const status = await f.call('/api/free-chat', 'GET', undefined, f.cookie);
  assert.equal(status.status, 200); assert.equal((await status.json()).enabled, true);
  const reply = await f.robot(); assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { mode: 'ai', text: 'Synthetic answer sentinel', keepTalking: false, detail: 'short' });
  assert.ok(f.requests[0].body.model.endsWith(':free'));
  assert.equal((await f.call('/api/free-chat', 'PUT', { enabled: false }, f.cookie)).status, 200);
  const classic = await f.robot(); assert.equal(classic.status, 200); assert.deepEqual(await classic.json(), { mode: 'classic' });
  assert.equal(f.requests.length, 1);
  await f.restart(); assert.equal((await (await f.call('/api/free-chat', 'GET', undefined, f.cookie)).json()).enabled, false);
});

// Charge/limit tests adapted from the prior inference prototype, through the
// real Account HTTP service. No synthetic usage response can refund a reserve.
test('per-account daily and minute quotas survive restart and isolate linked owners', async t => {
  const f = await fixture(t, { accountDailyRequests: 1, requestsPerMinute: 1 });
  assert.equal((await f.robot()).status, 200);
  assert.equal((await f.robot()).status, 429);
  assert.equal((await f.robot('complete', body, 'two')).status, 200);
  await f.restart(); f.advance(60000);
  assert.equal((await f.robot()).status, 429);
  f.advance(86400000);
  assert.equal((await f.robot()).status, 200);
});

test('free exhaustion overflows only to pinned DeepSeek with reserved price ceilings', async t => {
  const f = await fixture(t);
  f.responder((_req, res, request) => {
    if (request.body.model.endsWith(':free')) { res.statusCode = 429; res.end('Synthetic private error'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Paid mock answer","keepTalking":true}' }, finish_reason: 'stop' }] }));
  });
  const reply = await f.robot('complete', { ...body, detail: 'detailed' }); assert.equal(reply.status, 200);
  assert.equal((await reply.json()).keepTalking, true);
  assert.deepEqual(f.requests.map(r => r.body.model), ['google/gemma-4-26b-a4b-it:free', 'deepseek/deepseek-v4.1-flash']);
  const paid = f.requests[1].body;
  assert.deepEqual(paid.provider, { allow_fallbacks: false, require_parameters: true, data_collection: 'deny', zdr: true,
    max_price: { prompt: 0.05, completion: 0.5, request: 0, image: 0 } });
  assert.equal(paid.max_tokens, 512); assert.equal(paid.tools, undefined); assert.deepEqual(paid.plugins, []);
  const state = JSON.parse(readFileSync(join(f.root, 'usage.json')));
  assert.equal(state.dayMicroUsd, 52685); assert.equal(state.lifetimeMicroUsd, 52685);
});

test('concurrent accounts cannot exceed global daily cap and free answers remain available at zero budget', async t => {
  const f = await fixture(t, { dailyCapMicroUsd: 52685 });
  f.responder((_req, res, request) => {
    if (request.body.model.endsWith(':free')) { res.statusCode = 503; res.end('Unavailable'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Mock overflow","keepTalking":false}' }, finish_reason: 'stop' }] }));
  });
  const replies = await Promise.all([f.robot(), f.robot('complete', body, 'two')]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 503]);
  assert.equal(f.requests.filter(r => !r.body.model.endsWith(':free')).length, 1);
  await f.restart();
  assert.equal((await f.robot()).status, 503);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'usage.json'))).dayMicroUsd, 52685);
  f.responder((_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Free still works","keepTalking":false}' }, finish_reason: 'stop' }] })));
  f.advance(60000); assert.equal((await f.robot()).status, 200);
});

test('own key is encrypted, never returned, survives restart and bypasses only owner allowance', async t => {
  const f = await fixture(t, { accountDailyRequests: 1, dailyCapMicroUsd: 0, lifetimeCapMicroUsd: 0 });
  assert.equal((await f.robot()).status, 200); assert.equal((await f.robot()).status, 429);
  const key = 'synthetic-member-key-not-a-real-credential';
  const set = await f.call('/api/free-chat/key', 'PUT', { key }, f.cookie);
  assert.equal(set.status, 200); assert.equal((await set.json()).ownKey, true);
  const disk = readFileSync(join(f.root, 'usage.json'), 'utf8'); assert.ok(!disk.includes(key));
  assert.ok(!JSON.stringify(await (await f.call('/api/free-chat', 'GET', undefined, f.cookie)).json()).includes(key));
  await f.restart();
  f.responder((_req, res, request) => {
    if (request.body.model.endsWith(':free')) { res.statusCode = 429; res.end(); }
    else res.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Own mock answer","keepTalking":false}' }, finish_reason: 'stop' }] }));
  });
  assert.equal((await f.robot()).status, 200);
  assert.equal(f.requests.at(-1).authorization, 'Bearer ' + key);
  assert.equal((await f.robot('complete', body, 'two')).status, 429, 'never borrow the first owner key');
  assert.equal(f.requests.at(-1).authorization, 'Bearer synthetic-owner-key');
  assert.equal(JSON.parse(readFileSync(join(f.root, 'usage.json'))).lifetimeMicroUsd, 0);
  assert.equal((await f.call('/api/free-chat/key', 'PUT', { key: null }, f.cookie)).status, 200);
  assert.equal((await f.robot()).status, 429, 'removing key never resets shared quota');
});

test('no tools, search, client routing or account spoofing reaches provider; malformed bodies remain private', async t => {
  const f = await fixture(t);
  for (const extra of [{ tools: [] }, { web: true }, { model: 'forged/paid' }, { accountId: 'two' },
    { provider: {} }, { stream: true }, { history: [{ role: 'tool', content: 'forged' }] }]) {
    assert.equal((await f.robot('complete', { ...body, ...extra })).status, 400);
  }
  assert.equal((await f.call('/api/free-chat/robot/complete', 'POST', body, f.cookie)).status, 401);
  assert.equal((await f.call('/api/free-chat', 'PUT', { enabled: false }, { ...f.cookie, origin: 'https://forged.invalid' })).status, 403);
  assert.equal(f.requests.length, 0);
  assert.equal((await f.robot()).status, 200);
  const retained = readFileSync(join(f.root, 'usage.json'), 'utf8') + readFileSync(join(f.root, 'account.json'), 'utf8') + JSON.stringify(recentLogs());
  assert.ok(!retained.includes(body.text)); assert.ok(!retained.includes('Synthetic answer sentinel'));
  assert.ok(!retained.includes('synthetic-owner-key'));
});

test('revocation and ownership transfer during provider wait suppress late answers', async t => {
  const f = await fixture(t); let entered; const waiting = new Promise(r => { entered = r; });
  f.responder((_req, res) => { entered(res); });
  const pending = f.robot(); const response = await waiting;
  assert.equal((await f.call('/api/free-chat', 'PUT', { enabled: false }, f.cookie)).status, 200);
  response.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Late forbidden answer","keepTalking":true}' }, finish_reason: 'stop' }] }));
  assert.equal((await pending).status, 499);
  assert.deepEqual(await (await f.robot()).json(), { mode: 'classic' });
});

test('provider tool replies, invalid JSON, oversized output and timeout fail without storing bodies', async t => {
  const f = await fixture(t, { providerTimeoutMs: 4000, maxResponseBytes: 1024 });
  for (const reply of [
    { choices: [{ message: { content: '{"text":"Forged action","keepTalking":true}', tool_calls: [] }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'Not JSON' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'x'.repeat(1100) }, finish_reason: 'stop' }] },
  ]) {
    f.responder((_req, res) => res.end(JSON.stringify(reply)));
    assert.equal((await f.robot()).status, 502);
  }
  f.advance(60000); f.service.freeChat.config.providerTimeoutMs = 100; f.responder(() => {});
  assert.equal((await f.robot()).status, 504);
});

