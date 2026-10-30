import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { FreeChat } from '../src/freeChat/broker.js';
import { InferenceLedger, initializeInferenceLedger } from '../src/agentInference/ledger.js';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccountService } from '../src/index.js';
import { Store } from '../src/store.js';
import { createSession } from '../src/sessions.js';
import { signSigV4, recentLogs } from '@phoenix/common';

const originalFetch = globalThis.fetch;
const originalHttpRequest = http.request, originalHttpsRequest = https.request;
let calls = 0, rawCalls = 0;
before(() => {
  for (const [module, original] of [[http, originalHttpRequest], [https, originalHttpsRequest]]) module.request = (input, ...rest) => {
    const hostname = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host;
    assert.equal(hostname, '127.0.0.1', 'raw HTTP egress must also be loopback');
    rawCalls++; return original.call(module, input, ...rest);
  };
  syncBuiltinESMExports();
  globalThis.fetch = (input, options) => {
    assert.equal(new URL(typeof input === 'string' ? input : input.url).hostname, '127.0.0.1', 'all egress is loopback');
    calls++;
    return originalFetch(input, options);
  };
});
after(() => { globalThis.fetch = originalFetch; http.request = originalHttpRequest; https.request = originalHttpsRequest; syncBuiltinESMExports(); assert.ok(calls + rawCalls > 0); });
const counters = () => ({ day: '', dayRequests: 0, dayMicroUsd: 0, minute: 0, minuteRequests: 0 });
const body = { text: 'Synthetic conversation sentinel', detail: 'short', history: [] };
async function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'free-chat-'));
  const requests = []; let responder; let clock = Date.now();
  const mock = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    res.setHeader('connection', 'close');
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
  const call = (path, method = 'GET', data, headers = {}) => fetch(base + path, { method, signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', connection: 'close', ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const cookie = { cookie: 'phx_session=' + session._id };
  return { root, store, requests, config, cookie, call,
    rawSigned(bytes) {
      const path = '/api/free-chat/robot/complete'; const account = store.accounts.get('robot-one');
      const headers = signSigV4({ method: 'POST', path, body: bytes, headers: { host: new URL(base).host, 'content-type': 'application/json' }, accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
      return fetch(base + path, { method: 'POST', headers, body: bytes });
    }, get base() { return base; }, get service() { return service; },
    responder(fn) { responder = fn; }, advance(ms) { clock += ms; },
    async restart() { service.server.closeAllConnections(); await new Promise(r => service.server.close(r)); await start(); },
    robot(operation = 'complete', data = body, id = 'one') {
      const path = '/api/free-chat/robot/' + operation; const text = JSON.stringify(data);
      const account = store.accounts.get('robot-' + id);
      const headers = signSigV4({ method: 'POST', path, headers: { host: new URL(base).host, 'content-type': 'application/json' },
        body: text, accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
      return fetch(base + path, { method: 'POST', headers, body: text, signal: AbortSignal.timeout(60000) });
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
  assert.deepEqual(paid.provider, { allow_fallbacks: false, require_parameters: true, data_collection: 'allow', zdr: false,
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
  f.advance(60000); const freeAgain = await f.robot(); assert.equal(freeAgain.status, 200, JSON.stringify(await freeAgain.json()));
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

test('revocation and ownership transfer during provider wait suppress late answers', { timeout: 30000 }, async t => {
  const f = await fixture(t); let entered; const waiting = new Promise(r => { entered = r; });
  f.responder((_req, res) => { entered(res); });
  const pending = f.robot(); const response = await waiting;
  assert.equal((await f.call('/api/free-chat', 'PUT', { enabled: false }, f.cookie)).status, 200);
  response.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Late forbidden answer","keepTalking":true}' }, finish_reason: 'stop' }] }));
  assert.equal((await pending).status, 499);
  assert.deepEqual(await (await f.robot()).json(), { mode: 'classic' });
});

test('provider tool replies, invalid JSON, oversized output and timeout fail without storing bodies', async t => {
  const f = await fixture(t, { maxResponseBytes: 1024 });
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

test('real Classic ingress forwards signed robot chat privately to Account', async t => {
  const f = await fixture(t);
  const { createClassicEntrypoint } = await import('../../classic/src/index.js');
  const previous = process.env.NET_account; process.env.NET_account = f.base;
  const classic = createClassicEntrypoint({ notificationFile: join(f.root, 'notifications.json'),
    backup: { dir: join(f.root, 'backup') }, log: { dir: join(f.root, 'log') },
    gqa: { attributionFile: join(f.root, 'attribution.json') }, ifttt: { file: join(f.root, 'ifttt.json') } });
  t.after(async () => { classic.server.closeAllConnections(); await new Promise(r => classic.server.close(r));
    if (previous === undefined) delete process.env.NET_account; else process.env.NET_account = previous; });
  await classic.listen(0, '127.0.0.1');
  const base = 'http://127.0.0.1:' + classic.server.address().port;
  const path = '/api/free-chat/robot/complete'; const bytes = JSON.stringify(body); const account = f.store.accounts.get('robot-one');
  const headers = signSigV4({ method: 'POST', path, body: bytes, headers: { host: new URL(base).host, 'content-type': 'application/json' },
    accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
  const response = await fetch(base + path, { method: 'POST', headers, body: bytes });
  assert.equal(response.status, 200); assert.equal((await response.json()).mode, 'ai');
  assert.equal((await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bytes })).status, 401);
  assert.equal(f.requests.length, 1);
});


test('private malformed, oversized and slow input never spends or exposes speech in parser logs', async t => {
  const f = await fixture(t, { bodyTimeoutMs: 100 });
  assert.equal((await f.rawSigned('{"private-malformed-chat-sentinel":')).status, 400);
  assert.equal((await f.rawSigned(JSON.stringify({ text: 'x'.repeat(17000) }))).status, 413);
  const status = await new Promise((resolve, reject) => {
    const path = '/api/free-chat/robot/complete', account = f.store.accounts.get('robot-one');
    const headers = signSigV4({ method: 'POST', path, body: '{}', headers: { host: new URL(f.base).host, 'content-type': 'application/json' },
      accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
    const req = httpRequest(f.base + path, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => { clearTimeout(deadline); resolve(res.statusCode); }); });
    const deadline = setTimeout(() => { req.destroy(); resolve('client-deadline'); }, 2000);
    req.on('error', () => {}); req.write('{'); t.after(() => { clearTimeout(deadline); req.destroy(); });
  });
  assert.equal(status, 408); assert.equal(f.requests.length, 0);
  assert.ok(!JSON.stringify(recentLogs()).includes('private-malformed-chat-sentinel'));
});

test('ownership transfer and account deactivation during a provider wait cannot deliver another owner answer', { timeout: 30000 }, async t => {
  const f = await fixture(t); let enter;
  const arrived = new Promise(r => { enter = r; });
  f.responder((_req, res) => enter(res));
  const pending = f.robot(); const response = await arrived;
  f.store.loops.get('loop-one').owner = 'two';
  response.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Late private answer","keepTalking":false}' }, finish_reason: 'stop' }] }));
  assert.equal((await pending).status, 401);
  f.store.accounts.get('two').isActive = false;
  assert.equal((await f.robot()).status, 403);
  assert.equal(f.requests.length, 1);
});

test('missing or corrupt ledger and a second writer fail closed without resetting counters', async t => {
  const f = await fixture(t); const file = join(f.root, 'usage.json');
  assert.throws(() => initializeInferenceLedger(file), /EEXIST/);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {InferenceLedger} from ${JSON.stringify(new URL('../src/agentInference/ledger.js', import.meta.url).href)}; try { new InferenceLedger(process.argv[1]); process.exit(8); } catch(e) { if(e.code!=='EEXIST')process.exit(9); }`, file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr); f.service.freeChat.close();
  const saved = readFileSync(file); writeFileSync(file, '{"version":1,"dayRequests":-1}');
  assert.throws(() => new InferenceLedger(file), /inference_ledger_invalid/);
  writeFileSync(file, saved); rmSync(file);
  assert.throws(() => new InferenceLedger(file), /ENOENT/);
});

test('SIGKILL after real paid reservation preserves spending and leaves exclusive lock', async t => {
  const f = await fixture(t, { lifetimeCapMicroUsd: 52685 }); f.service.freeChat.close();
  const script = `import {FreeChat} from ${JSON.stringify(new URL('../src/freeChat/broker.js', import.meta.url).href)};
    import {Store} from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
    const options=JSON.parse(process.argv[1]); options.encryptionKey=Buffer.alloc(32,7); const store=new Store(process.argv[2]);
    const broker=new FreeChat(store,options); broker.reserve(store.accounts.get('one'),true); process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script,
    JSON.stringify({ ...f.config, encryptionKey: undefined }), join(f.root, 'account.json')], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(JSON.parse(readFileSync(join(f.root, 'usage.json'))).lifetimeMicroUsd, 52685);
  assert.throws(() => new FreeChat(f.store, f.config), /EEXIST/);
  rmSync(join(f.root, 'usage.json.lock'), { recursive: true }); // exact reaped fixture writer only
  await f.restart();
  f.responder((_req, res) => { res.statusCode = 503; res.end(); });
  assert.equal((await f.robot()).status, 503);
  assert.equal(f.requests.length, 1, 'only a zero-price free attempt; no paid request after crash');
});

test('one in-flight owner request and global concurrency admission are bounded', { timeout: 30000 }, async t => {
  const f = await fixture(t, { globalConcurrency: 1 }); let enter;
  const arrived = new Promise(r => { enter = r; });
  f.responder((_req, res) => enter(res)); const pending = f.robot(); const response = await arrived;
  assert.equal((await f.robot()).status, 429);
  assert.equal((await f.robot('complete', body, 'two')).status, 503);
  response.end(JSON.stringify({ choices: [{ message: { content: '{"text":"Bounded answer","keepTalking":false}' }, finish_reason: 'stop' }] }));
  assert.equal((await pending).status, 200); assert.equal(f.requests.length, 1);
});


test('robot ownership changed while its body arrives cannot charge the new account', async t => {
  const f = await fixture(t); const bytes = JSON.stringify(body); const path = '/api/free-chat/robot/complete';
  const account = f.store.accounts.get('robot-one');
  const headers = signSigV4({ method: 'POST', path, body: bytes, headers: { host: new URL(f.base).host, 'content-type': 'application/json' },
    accessKeyId: account.accessKeyId, secretAccessKey: account.secretAccessKey, region: 'fixture' }).headers;
  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(f.base + path, { method: 'POST', headers }, res => { res.resume(); res.on('end', () => { clearTimeout(deadline); resolve(res.statusCode); }); });
    const deadline = setTimeout(() => { req.destroy(); reject(Error('client-deadline')); }, 10000);
    req.on('error', reject); t.after(() => { clearTimeout(deadline); req.destroy(); });
    const lookup = f.store.accountByAccessKeyId.bind(f.store); let queued = false;
    f.store.accountByAccessKeyId = key => {
      const account = lookup(key);
      if (!queued) { queued = true; queueMicrotask(() => { f.store.loops.get('loop-one').owner = 'two'; req.end(bytes.slice(1)); }); }
      return account;
    };
    req.write(bytes.slice(0, 1));
  });
  assert.equal(response, 401); assert.equal(f.requests.length, 0);
  f.store.loops.get('loop-one').owner = 'one';
  assert.equal((await f.robot()).status, 200, 'unchanged owner still authenticates');
  assert.equal(f.requests.length, 1);
});

test('explicit ledger CLI initializes once and refuses to overwrite existing spend', async t => {
  const root = mkdtempSync(join(tmpdir(), 'chat-init-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'usage.json'), script = new URL('../../../scripts/init-free-chat-usage.mjs', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [script, file], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run().status, 0); const original = readFileSync(file, 'utf8');
  assert.equal(run().status, 1); assert.equal(readFileSync(file, 'utf8'), original);
});

test('failed durable reservation refuses dispatch and latches the writer unavailable', async t => {
  const f = await fixture(t); const moved = f.root + '-moved'; renameSync(f.root, moved);
  try {
    assert.equal((await f.robot()).status, 503); assert.equal((await f.robot()).status, 503); assert.equal(f.requests.length, 0);
  } finally { renameSync(moved, f.root); }
});
