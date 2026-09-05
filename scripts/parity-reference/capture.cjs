// Executes ORIGINAL Pegasus modules. Fixture services supply only upstream
// inputs; no Phoenix implementation participates in the expected responses.
// Node 8.9.4 compatible; run inside the network-none container in run.py.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const cp = require('child_process');
const assert = require('assert');
const Module = require('module');
const ref = path.resolve(process.argv[2]);
const out = path.resolve(process.argv[3]);
const original = name => require(path.join(ref, 'packages', name));
const dependency = name => require(path.join(ref, 'node_modules', name));
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const realDate = Date;
const now = Date.UTC(2018, 4, 30, 12, 0, 0);
global.Date = class FixtureDate extends realDate {
  constructor() { const args = Array.prototype.slice.call(arguments); super(...(args.length ? args : [now])); }
  static now() { return now; }
};
let seed = 0x50454741, nextID = 0;
Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
process.env.TZ = 'UTC';
process.env.ETCO_server_hubTokenSecret = 'parity-fixture-secret';
process.env.ETCO_server_logLevel = 'error';
process.env.ETCO_server_structuredLogs = 'true';
process.env.ETCO_server_name = 'original-parity-fixture';

// The original ASR factory imports/constructs the Google client at module load.
// CLIENT_ASR is an original public mode used below. These inert provider shims
// prevent native gRPC loading and credential lookup; any actual provider call
// fails the fixture instead of contacting a historical endpoint.
const load = Module._load;
const providerImports = [];
Module._load = function(request, parent, isMain) {
  if (request === '@google-cloud/speech') {
    providerImports.push(request);
    return { SpeechClient: class {
      streamingRecognize() { throw new Error('Live Google ASR is outside this fixture'); }
    } };
  }
  if (request === 'grpc') {
    providerImports.push(request);
    return { credentials: { createInsecure: () => ({ fixture: true }) } };
  }
  return load.call(this, request, parent, isMain);
};
const common = original('utils-common');
common.getUUID = () => '00000000-0000-4000-8000-' + (++nextID).toString(16).padStart(12, '0');
const utils = original('utils');
const WebSocket = dependency('ws');
const jwt = dependency('jsonwebtoken');
const BaseService = utils.service.BaseService;
const BaseHttpHandler = utils.service.BaseHttpHandler;
const token = jwt.sign({ id: 'fixture-account', friendlyId: 'fixture-robot', exp: now / 1000 + 3600 }, process.env.ETCO_server_hubTokenSecret, { noTimestamp: true });
const auth = { authorization: 'Bearer ' + token, 'x-jibo-robotid': 'fixture-robot', 'x-jibo-transid': 'fixture-transaction' };
const transactions = [], sideEffects = [], checks = [], services = [];
const record = {
  referenceRevision: JSON.parse(fs.readFileSync(path.join(ref, 'parity-prepared.json'))).referenceRevision,
  runtime: process.version,
  basis: 'Original source modules under TypeScript 2.5.3 emission adapter; original NLU 2.8.3 CLI',
  fixture: { clock: new Date().toISOString(), timezone: 'UTC', mathRandomSeed: '0x50454741',
    uuid: 'Sequential fixture IDs through the original utils-common export', asr: 'Original CLIENT_ASR wire mode; Google/grpc imports inert',
    network: 'Docker --network none; all HTTP/WS peers use loopback inside this container' },
  adapterSha256: sha(fs.readFileSync(__filename)), providerImports, transactions, sideEffects, checks,
  exclusions: ['Original Gulp/browserify release build and type checking', 'Live Google streaming ASR/gRPC and Dialogflow',
    'Mongo/Redis durability, OAuth/live providers, GQA process', 'Complete skill sessions, proactivity, firmware/hardware and full corpora'],
};
function check(name, fn) { fn(); checks.push(name); }
function elapsed(start) { const d = process.hrtime(start); return d[0] * 1000 + d[1] / 1e6; }
function request(port, method, route, raw, headers) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime();
    const wireHeaders = Object.assign({ connection: 'close' }, headers || {});
    if (raw !== undefined) wireHeaders['content-length'] = Buffer.byteLength(raw);
    const req = http.request({ host: '127.0.0.1', port, path: route, method, headers: wireHeaders }, res => {
      const chunks = [];
      res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(body); } catch (_) {}
        resolve({ request: { method, path: route, headers: wireHeaders, body: raw },
          response: { status: res.statusCode, headers: res.headers, body, json }, elapsedMs: elapsed(start) });
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject); req.end(raw);
  });
}
async function httpCase(name, port, method, route, body, headers) {
  const result = await request(port, method, route, body, headers);
  transactions.push(Object.assign({ name, transport: 'HTTP' }, result)); return result.response;
}
function socketCase(name, port, route, messages, headers) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime(), received = [];
    const result = { name, transport: 'WS', request: { path: route, headers: headers || {}, frames: messages }, frames: received };
    let settled = false;
    const ws = new WebSocket('ws://127.0.0.1:' + port + route, { headers: headers || {} });
    const finish = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      result.elapsedMs = elapsed(start);
      transactions.push(result);
      if (error) { result.error = error.message; reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => { finish(new Error('WebSocket fixture timed out: ' + name)); ws.terminate(); }, 5000);
    ws.on('open', () => messages.forEach(message => ws.send(typeof message === 'string' ? message : JSON.stringify(message))));
    ws.on('message', raw => {
      const text = raw.toString(); let json; try { json = JSON.parse(text); } catch (_) {}
      received.push({ body: text, json });
      if (name.indexOf('hub-listen-') === 0 && json && json.final === true) {
        // The original hub leaves its connection open after a transaction.
        // This fixture closes explicitly; it does not claim server-side closure.
        const close = () => { result.clientCloseAfterFinal = true; ws.close(1000, 'fixture complete'); };
        if (name === 'hub-listen-launch') {
          setTimeout(() => {
            result.observedOpenAfterFinalMs = 50;
            result.connectionOpenAfterFinal = ws.readyState === WebSocket.OPEN;
            close();
          }, 50);
        } else close();
      }
    });
    ws.on('close', (code, reason) => { result.close = { code, reason: reason.toString() }; finish(); });
    ws.on('unexpected-response', (req, res) => {
      result.upgrade = { status: res.statusCode, headers: res.headers, body: '' };
      res.on('data', b => { result.upgrade.body += b.toString(); });
      res.on('end', () => { finish(); ws.terminate(); });
    });
    ws.on('error', error => { if (!settled) finish(error); });
  });
}
async function start(service) { services.push(service); await service.init(0); return service.server.address().port; }

async function run() {
  class FixtureHTTP extends BaseHttpHandler {
    constructor() {
      super();
      this.addGetHandler('/null', async () => null);
      this.addGetHandler('/undefined', async () => undefined);
      this.addGetHandler('/query', async query => query);
      this.addPostHandler('/echo', async body => body);
      this.addGetHandler('/error', async () => { throw new utils.http.HttpError('fixture teapot', 418); });
    }
  }
  const base = new BaseService('fixture');
  base.addHttpHandler('/fixture', { handler: new FixtureHTTP() });
  base.addHttpHandler('/protected', { handler: new FixtureHTTP(), authenticationRequired: true });
  base.addSocketHandler('/echo', { handler: { handleSocket: ws => new Promise(resolve => {
    ws.once('message', raw => { ws.send(raw.toString()); ws.close(); resolve(); });
  }) } });
  base.addSocketHandler('/error', { handler: { handleSocket: () => Promise.reject(new Error('fixture socket failure')) } });
  const port = await start(base);
  const health = await httpCase('base-health', port, 'GET', '/healthcheck');
  check('BaseService health response', () => assert.equal(health.body, 'ok'));
  const nul = await httpCase('base-null', port, 'GET', '/fixture/null');
  check('BaseHttpHandler preserves JSON null', () => assert.strictEqual(nul.body, 'null'));
  await httpCase('base-undefined', port, 'GET', '/fixture/undefined');
  await httpCase('base-head', port, 'HEAD', '/fixture/null');
  await httpCase('base-query', port, 'GET', '/fixture/query?a=one&a=two&nested%5Bb%5D=c');
  await httpCase('base-json-echo', port, 'POST', '/fixture/echo', '{"value":false,"empty":null}', { 'content-type': 'application/json' });
  await httpCase('base-json-invalid', port, 'POST', '/fixture/echo', '{', { 'content-type': 'application/json' });
  await httpCase('base-form-echo', port, 'POST', '/fixture/echo', 'a=one&a=two', { 'content-type': 'application/x-www-form-urlencoded' });
  const missing = await httpCase('base-not-found', port, 'GET', '/missing');
  check('BaseService not-found status/envelope', () => { assert.equal(missing.status, 404); assert.equal(missing.json.data.message, 'URL not found: /missing'); });
  await httpCase('base-error', port, 'GET', '/fixture/error');
  const unauth = await httpCase('base-auth-required', port, 'GET', '/protected/null');
  check('BaseService HTTP auth boundary', () => assert.equal(unauth.status, 401));
  await httpCase('base-auth-valid', port, 'GET', '/protected/null', undefined, auth);
  await socketCase('base-ws-echo', port, '/echo', [{ value: 'original websocket' }], auth);
  await socketCase('base-ws-error', port, '/error', [], auth);
  await socketCase('base-ws-auth-required', port, '/echo', [], {});
  await socketCase('base-ws-not-found', port, '/missing', [], auth);

  const fake = http.createServer((req, res) => {
    const chunks = []; req.on('data', b => chunks.push(b));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString(); let body; try { body = JSON.parse(raw); } catch (_) {}
      const entry = { method: req.method, path: req.url, headers: req.headers, body: raw, json: body };
      sideEffects.push(entry);
      let response = {};
      if (req.url === '/v1/parse') {
        if (body.data.text === 'provider failure') { res.statusCode = 503; response = { message: 'fixture NLU unavailable' }; }
        else response = { type: 'NLU', data: { intent: body.data.text === 'no matching intent' ? null : body.data.text === 'local answer' ? 'decoyIntent' : 'matchingIntent', entities: {}, rules: ['launch'] } };
      } else if (req.url === '/skill') {
        response = { type: 'DONE', data: { skill: { id: 'skill1', session: { id: 'fixture-session', turn: body.type === 'LISTEN_UPDATE' ? 2 : 1 } }, fixturePayload: { esml: '<speak>Fixture answer.</speak>', requestType: body.type } } };
      } else if (req.headers['x-amz-target'] === 'Settings_20160801.GetSettings') {
        response = [{ skillId: 'report-skill', data: { weatherEnabled: { value: true } } }];
      }
      entry.response = { status: res.statusCode, json: response };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
    });
  });
  await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
  services.push({ close: () => new Promise(resolve => fake.close(resolve)) });
  const peer = 'http://127.0.0.1:' + fake.address().port;
  record.fixture.peerURL = peer;
  const reportManifest = JSON.parse(fs.readFileSync(path.join(ref, 'packages/hub/pegasus-skills/report_skill_manifest.json')));
  reportManifest.URL = peer + '/skill';
  const skillConfigs = [{ id: 'skill1', URL: peer + '/skill', intents: [{ name: 'matchingIntent', memo: 'fixture memo' }] }, reportManifest];
  const HubService = require(path.join(ref, 'packages/hub/lib/HubService')).HubService;
  const hub = new HubService({ disableAuth: false, skills: skillConfigs, parser: { baseURL: peer }, history: { baseURL: peer },
    settings: { baseURL: peer }, hubSettings: { recordLaunchHistory: true } });
  const hubPort = await start(hub);
  for (const route of ['/skills/fixture-robot', '/v1/skills/fixture-robot', '/skills/settings/fixture-robot', '/v1/skills/settings/fixture-robot']) {
    const response = await httpCase('hub-' + route, hubPort, 'GET', route);
    check('Original hub serves ' + route, () => { assert.equal(response.status, 200); assert.equal(response.json.skills.length, route.includes('/settings/') ? 1 : 2); });
  }
  const context = { general: { accountID: 'fixture-account', robotID: 'fixture-robot' }, runtime: { perception: { speaker: null } }, skill: {} };
  const message = (type, data) => ({ type, data, msgID: 'fixture-' + type, ts: now });
  const frames = (text, ctx) => [message('LISTEN', { rules: ['launch'], mode: 'CLIENT_ASR', lang: 'en-US' }), message('CONTEXT', ctx || context), message('CLIENT_ASR', { text })];
  const launch = await socketCase('hub-listen-launch', hubPort, '/v1/listen', frames('matched utterance'), auth);
  check('Original listen launches through ordered SOS/EOS/LISTEN/DONE frames', () => assert.deepEqual(launch.frames.map(f => f.json.type), ['SOS', 'EOS', 'LISTEN', 'DONE']));
  check('Original hub leaves the socket open after a final transaction frame', () => assert.strictEqual(launch.connectionOpenAfterFinal, true));
  const nextContext = JSON.parse(JSON.stringify(context));
  nextContext.skill = launch.frames[3].json.data.skill;
  const relaunch = await socketCase('hub-listen-relaunch', hubPort, '/v1/listen', frames('matched utterance', nextContext), auth);
  check('A matching global intent launches again despite the existing session', () => assert.equal(relaunch.frames[3].json.data.fixturePayload.requestType, 'LISTEN_LAUNCH'));
  const update = await socketCase('hub-listen-update', hubPort, '/v1/listen', frames('local answer', nextContext), auth);
  check('Original hub sends a skill continuation', () => assert.equal(update.frames[3].json.data.fixturePayload.requestType, 'LISTEN_UPDATE'));
  await socketCase('hub-listen-no-match', hubPort, '/listen', frames('no matching intent'), auth);
  await socketCase('hub-listen-provider-failure', hubPort, '/listen', frames('provider failure'), auth);
  await socketCase('hub-listen-auth-required', hubPort, '/listen', [], {});

  const SettingsClient = require(path.join(ref, 'packages/hub/lib/utils/SettingsClient')).SettingsClient;
  const settingsClient = new SettingsClient(peer);
  const settings = await settingsClient.getSettings('fixture-account', 'fixture-loop', 'fixture-trans', ['report-skill'], new utils.logging.Log('FixtureSettings'));
  transactions.push({ name: 'hub-settings-client', transport: 'module', request: { accountId: 'fixture-account', loopId: 'fixture-loop', skills: ['report-skill'] }, result: Array.from(settings) });
  check('Original Settings client reaches legacy target with original payload', () => {
    const call = sideEffects.find(e => e.headers['x-amz-target'] === 'Settings_20160801.GetSettings');
    assert(call); assert.equal(call.json.loopId, 'fixture-loop'); assert.deepEqual(call.json.skills, ['report-skill']);
  });

  const ParseRequestHandler = require(path.join(ref, 'packages/parser/lib/handlers/ParseRequestHandler')).ParseRequestHandler;
  const parserInputs = [];
  const parser = new BaseService('fixture-parser');
  parser.addHttpHandler('/v1/parse', { handler: new ParseRequestHandler({
    getRobustParserNLUResult: async data => { parserInputs.push({ provider: 'robust', data: JSON.parse(JSON.stringify(data)) });
      return data.text === 'robust match' ? { priority: 'HIGH', nlu: { intent: 'matchingIntent', entities: { value: 5 }, rules: data.rules || ['launch'] } } : null; },
    getDialogflowNLUResult: async data => { parserInputs.push({ provider: 'dialogflow', data: JSON.parse(JSON.stringify(data)) }); return null; },
  }) });
  const parserPort = await start(parser);
  const jsonHeaders = { 'content-type': 'application/json' };
  const empty = await httpCase('parser-empty', parserPort, 'POST', '/v1/parse', JSON.stringify(message('NLU', { text: '  ', rules: ['launch'] })), jsonHeaders);
  check('Original parser empty request result', () => assert.deepEqual(empty.json.data, { intent: null, entities: null, rules: [] }));
  await httpCase('parser-malformed', parserPort, 'POST', '/v1/parse', '{}', jsonHeaders);
  await httpCase('parser-no-match', parserPort, 'POST', '/v1/parse', JSON.stringify(message('NLU', { text: 'no match', rules: ['shared.yes_no'] })), jsonHeaders);
  await httpCase('parser-robust-match', parserPort, 'POST', '/v1/parse', JSON.stringify(message('NLU', { text: 'robust match', rules: ['clock.timer_set_value'], loop: { users: [] } })), jsonHeaders);
  record.parserInputs = parserInputs;

  const AbstractRelay = require(path.join(ref, 'packages/lasso/lib/relay/AbstractRelayRequestHandler')).AbstractRelayRequestHandler;
  const cache = new Map(), relayEffects = [];
  const redis = {
    get: (key, callback) => { relayEffects.push({ operation: 'redis.get', key }); callback(null, cache.get(key)); },
    set: (key, value, ex, ttl, callback) => { relayEffects.push({ operation: 'redis.set', key, value, ex, ttl }); cache.set(key, value); callback(null, 'OK'); },
  };
  class FixtureRelay extends AbstractRelay {
    constructor() { super('fixture-credentials', redis); this.name = 'FixtureCalendar'; this.cacheSecondsToLive = 60; }
    validateAndExtractInputs(req) { if (!req.query.key) throw new Error('fixture key required'); return { key: req.query.key }; }
    createRedisKey(input) { return 'fixture:' + input.key; }
    async fetchFromExternal(input) {
      relayEffects.push({ operation: 'provider.fetch', input });
      if (input.key === 'failure') throw new Error('fixture provider unavailable');
      if (input.key === 'empty') return null;
      return { events: [] };
    }
  }
  const relay = new BaseService('fixture-lasso');
  relay.addHttpHandler('/v1/calendar', { handler: new FixtureRelay() });
  const relayPort = await start(relay);
  const relayMiss = await httpCase('relay-cache-miss', relayPort, 'GET', '/v1/calendar?key=calendar');
  check('Original relay wraps an empty calendar in relayData', () => assert.deepEqual(relayMiss.json, { relayData: { events: [] }, lassoDataFromRedis: false }));
  const relayHit = await httpCase('relay-cache-hit', relayPort, 'GET', '/v1/calendar?key=calendar');
  check('Original relay cache marks the response and insertion time', () => { assert.strictEqual(relayHit.json.lassoDataFromRedis, true); assert.equal(relayHit.json.lassoInsertedIntoRedisAt, new Date().toISOString()); });
  await httpCase('relay-skip-cache-string-false', relayPort, 'GET', '/v1/calendar?key=calendar&skipCache=false');
  const head = await httpCase('relay-head-prefetch', relayPort, 'HEAD', '/v1/calendar?key=prefetch');
  check('Original relay HEAD succeeds with an empty body', () => { assert.equal(head.status, 200); assert.equal(head.body, ''); });
  await httpCase('relay-invalid-input', relayPort, 'GET', '/v1/calendar');
  await httpCase('relay-provider-failure', relayPort, 'GET', '/v1/calendar?key=failure');
  await httpCase('relay-empty-provider', relayPort, 'GET', '/v1/calendar?key=empty');
  record.relayEffects = relayEffects;

  const nluRoot = path.join(ref, 'packages/parser/robust-parser');
  const utterances = ['tell me a joke', 'set a timer for five minutes', 'purple dishwasher giraffe'];
  const textFile = path.join(path.dirname(out), 'nlu-input.txt');
  fs.writeFileSync(textFile, utterances.join('\n') + '\n');
  const fst = path.join(nluRoot, 'rules_fst/launch.fst');
  const binary = path.join(nluRoot, 'build/bin/parse');
  const binaryResult = cp.spawnSync(binary, ['--fst', fst, '--txt', textFile, '--json'], {
    cwd: nluRoot, env: Object.assign({}, process.env, { LD_LIBRARY_PATH: path.join(nluRoot, 'build/lib') }), timeout: 20000, encoding: 'utf8',
  });
  record.nluBinary = { command: [binary, '--fst', fst, '--txt', textFile, '--json'], input: utterances,
    binarySha256: sha(fs.readFileSync(binary)), fstSha256: sha(fs.readFileSync(fst)), exitCode: binaryResult.status,
    stdout: binaryResult.stdout, stderr: binaryResult.stderr, error: binaryResult.error && binaryResult.error.message };
  check('Original NLU 2.8.3 CLI executes against the original launch FST', () => { assert.equal(binaryResult.status, 0); assert.equal(binaryResult.stdout.trim().split('\n').length, utterances.length); });
  // Let original fire-and-forget history writes settle; measure them separately
  // from the client transaction. This does not certify history persistence.
  await new Promise(resolve => setTimeout(resolve, 50));
  check('Original hub produced launch history calls', () => assert(sideEffects.some(e => e.path === '/v1/skill/launch')));
}

run().then(() => { record.result = 'pass'; }, error => {
  record.result = 'fail'; record.failure = { message: error.message, stack: error.stack }; process.exitCode = 1;
}).then(async () => {
  for (const service of services.reverse()) await service.close();
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
  console.log(JSON.stringify({ result: record.result, transactions: transactions.length, checks: checks.length, sideEffects: sideEffects.length, failure: record.failure && record.failure.message }));
}).catch(error => { console.error(error.stack); process.exitCode = 1; });
