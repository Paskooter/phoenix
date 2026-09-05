// Shared production HTTP/parser/router/skill driver, executable on Node 8 and 22.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const vm = require('vm');
const URL = require('url').URL;
const { writeCapture } = require('./capture-writer.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const elapsed = start => { const d = process.hrtime(start); return d[0] * 1000 + d[1] / 1e6; };
const decode = raw => { if (raw === '') return { kind: 'empty', value: '' }; try { return { kind: 'json', value: JSON.parse(raw) }; } catch (_) { return { kind: 'text', value: raw }; } };
let fixtureNow = Date.parse('2018-05-30T12:00:00Z'), seed = 1, vmSeed = 1, clockInstalled = false;

function installClock() {
  if (clockInstalled) throw new Error('Fixture clock was installed twice');
  clockInstalled = true;
  const RealDate = Date;
  global.Date = class FixtureDate extends RealDate {
    constructor() { const args = Array.prototype.slice.call(arguments); super(...(args.length ? args : [fixtureNow])); }
    static now() { return fixtureNow; }
  };
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  // MIM conditions execute in their own V8 contexts. Seed their intrinsic RNG
  // independently; preserve explicitly supplied Math objects and all other VM
  // semantics. Application condition expressions still execute unchanged.
  const createContext = vm.createContext;
  vm.createContext = function(sandbox) {
    const context = createContext.apply(this, arguments);
    if (!sandbox || !('Math' in sandbox)) vm.runInContext('Math', context).random = () => {
      vmSeed = (Math.imul(vmSeed, 1664525) + 1013904223) >>> 0;
      return vmSeed / 0x100000000;
    };
    return context;
  };
  process.env.TZ = 'UTC';
  const writeHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function() {
    const supplied = typeof arguments[1] === 'object' ? arguments[1] : arguments[2];
    const names = Array.isArray(supplied) ? supplied.filter((_, i) => i % 2 === 0) : Object.keys(supplied || {});
    if (this.sendDate && !this.hasHeader('date') && !names.some(n => String(n).toLowerCase() === 'date')) this.setHeader('Date', new RealDate(fixtureNow).toUTCString());
    return writeHead.apply(this, arguments);
  };
}
function selectCase(definition) {
  fixtureNow = Date.parse(definition.clock);
  seed = definition.seed >>> 0;
  vmSeed = (seed ^ 0x9e3779b9) >>> 0;
  if (!Number.isFinite(fixtureNow) || !Number.isInteger(definition.seed)) throw new Error('Invalid clock or random seed');
}
function input(definition, stage, body, route) {
  const raw = JSON.stringify(body);
  return { method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw),
    connection: 'close', 'x-jibo-transid': definition.id, 'x-jibo-robotid': 'fixture-robot' }, rawBody: raw, body: decode(raw), stage };
}
function parserInput(definition, context) {
  let body;
  if (has(definition, 'parserRequest')) body = clone(definition.parserRequest);
  else {
    const data = clone(definition.parserData);
    if (definition.includeLoop) data.loop = clone(context.runtime.loop);
    body = { type: 'NLU', msgID: definition.id + ':parser-input', ts: Date.parse(definition.clock), data };
  }
  return input(definition, 'parser', body, '/v1/parse');
}
function skillPreparation(definition, context, skillID, result, step, prior) {
  const requestContext = clone(context);
  if (step) requestContext.skill = clone(prior.data.skill);
  return { type: step === 0 ? (definition.skillType || 'LISTEN_LAUNCH') : 'LISTEN_UPDATE', skillID,
    input: Object.assign({ context: requestContext }, clone(result)) };
}
function request(port, definition, limit) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime();
    const req = http.request({ host: '127.0.0.1', port, method: definition.method, path: definition.path, headers: definition.headers }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, headers: res.headers, rawBody: raw, body: decode(raw), durationMs: elapsed(start) }); });
    });
    const timer = setTimeout(() => req.destroy(new Error('Production HTTP observation timed out')), limit);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.on('close', () => clearTimeout(timer));
    req.end(definition.rawBody);
  });
}
function serializeError(error) {
  return { message: error.message, stack: error.stack, code: error.code,
    diagnostics: error.parityDiagnostics,
    errors: error.errors && error.errors.map(serializeError) };
}
async function run(adapter, suite, out) {
  const report = { schemaVersion: 2, suite: suite.id, suiteSha256: sha(JSON.stringify(suite)), driverSha256: sha(fs.readFileSync(__filename)),
    adapterSha256: sha(fs.readFileSync(adapter.moduleFile)),
    implementation: adapter.name, runtime: process.version, profile: suite.profile, captureComplete: false, cases: [], lateEffects: [], endpoints: {} };
  const owners = new Map();
  let current, activePeers = 0, subject;
  const peer = http.createServer((req, res) => {
    const start = process.hrtime(); activePeers++;
    const owner = owners.get(req.headers['x-jibo-transid']) || current;
    const chunks = [];
    req.on('data', b => chunks.push(b));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8'), url = new URL(req.url, 'http://fixture.invalid');
      const effect = { method: req.method, path: req.url, headers: req.headers, rawBody: raw, body: decode(raw),
        attribution: owners.has(req.headers['x-jibo-transid']) ? 'trace-header' : 'active-case' };
      (owner ? owner.effects : report.lateEffects).push(effect);
      let body, status = 200;
      const providers = suite.providers;
      if (req.headers['x-amz-target'] === 'Settings_20160801.GetSettings') body = providers.settings;
      else if (url.pathname === '/v1/dark_sky') body = { relayData: providers.weather };
      else if (url.pathname === '/v1/ap_news') body = { relayData: providers.news.replace(/FIXTURE_CATEGORY/g, url.searchParams.get('sourceID') || 'unknown') };
      else if (url.pathname === '/v1/google_calendar' || url.pathname === '/v1/outlook_calendar') body = { relayData: providers.calendar };
      else if (url.pathname === '/v1/google_maps') body = { relayData: providers.maps };
      else { status = 599; body = { error: 'Unexpected fixture provider request' }; effect.unexpected = true; }
      if (owner && owner.providerFailure && !effect.unexpected) { status = 503; body = { error: 'Fixture provider unavailable' }; }
      effect.response = { status, body: clone(body) };
      res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body));
      effect.durationMs = elapsed(start); activePeers--;
    });
  });
  try {
    await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
    const peerURL = 'http://127.0.0.1:' + peer.address().port; report.endpoints.peer = peerURL;
    subject = await adapter.start({ peerURL, suite });
    report.setup = subject.metadata;
    for (const definition of suite.cases) {
      selectCase(definition);
      current = { id: definition.id, effects: [], turns: [], providerFailure: !!definition.providerFailure };
      report.cases.push(current); owners.set(definition.id, current);
      const start = process.hrtime(), context = suite.contexts[definition.context];
      try {
        let skillID, result;
        if (has(definition, 'parserData') || has(definition, 'parserRequest')) {
          const req = parserInput(definition, context);
          current.parser = { input: req, response: await request(subject.parserPort, req, suite.requestTimeoutMs) };
          const body = current.parser.response.body;
          if (definition.route) {
            if (body.kind === 'json' && body.value && body.value.type === 'NLU') {
              const decision = await subject.route(clone(body.value.data));
              current.routing = decision == null ? { kind: 'no-route' } : { kind: 'match', decision: clone(decision) };
              if (decision) { skillID = decision.skillID; result = { nlu: clone(body.value.data), asr: { text: req.body.value.data.text, confidence: 1 } }; if (has(decision, 'memo')) result.memo = clone(decision.memo); }
            } else current.routing = { kind: 'parser-error' };
          }
        }
        if (definition.directSkill) { skillID = definition.directSkill.id; result = clone(definition.directSkill.result); }
        if (definition.actions) {
          if (!skillID) current.actionOutcome = 'no-route';
          else if (subject.onRobot(skillID)) current.actionOutcome = 'on-robot';
          else if (!subject.skillPorts[skillID]) { current.actionOutcome = 'unhosted-cloud-skill'; current.coverageGap = { skillID, scope: 'Cloud action service is outside this isolated fixture profile' }; }
          else {
            current.actionOutcome = 'cloud-skill';
            let previous;
            const steps = [result].concat(definition.updates || []);
            for (let step = 0; step < steps.length; step++) {
              if (step && !(previous && previous.data && previous.data.skill && previous.data.skill.session)) throw new Error('Previous skill response did not supply a continuation session');
              const preparation = skillPreparation(definition, context, skillID, steps[step], step, previous);
              const body = await subject.buildSkillRequest(clone(preparation));
              const req = input(definition, 'skill:' + step, body, '/v1/main');
              const response = await request(subject.skillPorts[skillID], req, suite.requestTimeoutMs);
              current.turns.push({ preparation, input: req, response }); previous = response.body.kind === 'json' ? response.body.value : null;
            }
          }
        }
        // Bound and attribute asynchronous prefetch requests before the next case.
        await new Promise(resolve => setTimeout(resolve, suite.effectDrainMs));
        if (activePeers) throw new Error('Provider effects still active after fixture drain window');
      } catch (error) { current.failure = serializeError(error); }
      current.durationMs = elapsed(start);
      if (report.cases.length % 100 === 0) console.log(JSON.stringify({ progress: report.cases.length, total: suite.cases.length }));
      current = null;
    }
    report.captureComplete = true;
  } catch (error) { report.failure = serializeError(error); }
  let captureWriteFailure;
  try {
    if (subject) { try { await subject.close(); } catch (error) { report.cleanupFailure = serializeError(error); report.captureComplete = false; } }
    await new Promise(resolve => peer.close(resolve));
    await writeCapture(out, report);
  } catch (error) {
    report.captureComplete = false;
    report.captureWriteFailure = serializeError(error);
    captureWriteFailure = error;
  }
  if (captureWriteFailure) {
    throw captureWriteFailure;
  }
  console.log(JSON.stringify({ complete: report.captureComplete, cases: report.cases.length, failures: report.cases.filter(c => c.failure).length, failure: report.failure }));
  return report;
}
module.exports = { installClock, selectCase, parserInput, skillPreparation, input, request, run, sha, clone, decode, serializeError };
