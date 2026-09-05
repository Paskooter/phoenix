// One wire driver and one set of peers for both implementations. Node 8/22.
'use strict';
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const suiteBytes = fs.readFileSync(path.join(__dirname, 'suite.json'));
const suite = JSON.parse(suiteBytes);
const fixedNow = Date.parse(suite.clock);

function installClock() {
  const RealDate = Date;
  global.Date = class FixtureDate extends RealDate {
    constructor() { const args = Array.prototype.slice.call(arguments); super(...(args.length ? args : [fixedNow])); }
    static now() { return fixedNow; }
  };
  let seed = 0x50454741;
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  process.env.TZ = 'UTC';
  // Modern Node's automatic HTTP Date uses a captured internal Date constructor
  // and bypasses global.Date. Freeze that runtime-generated header too. Preserve
  // explicit application headers and sendDate=false so their behavior is tested.
  const writeHead = http.ServerResponse.prototype.writeHead;
  http.ServerResponse.prototype.writeHead = function() {
    const supplied = typeof arguments[1] === 'object' ? arguments[1] : arguments[2];
    const names = Array.isArray(supplied) ? supplied.filter((_, i) => i % 2 === 0) : Object.keys(supplied || {});
    if (this.sendDate && !this.hasHeader('date') && !names.some(name => String(name).toLowerCase() === 'date')) {
      this.setHeader('Date', new RealDate(fixedNow).toUTCString());
    }
    return writeHead.apply(this, arguments);
  };
}
const elapsed = start => { const d = process.hrtime(start); return d[0] * 1000 + d[1] / 1e6; };
const base64 = data => Buffer.from(data).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
function token(secret) {
  const data = base64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })) + '.' + base64(JSON.stringify({ id: 'fixture-account', friendlyId: 'fixture-robot', exp: fixedNow / 1000 + 3600 }));
  return data + '.' + base64(crypto.createHmac('sha256', secret).update(data).digest());
}
function headers(auth, caseID) {
  const result = { 'x-jibo-robotid': 'fixture-robot', 'x-jibo-transid': caseID, 'x-forwarded-for': '192.0.2.1' };
  if (auth === 'valid' || auth === 'invalid') result.authorization = 'Bearer ' + token(auth === 'valid' ? suite.secret : 'invalid-fixture-secret');
  return result;
}
function bodyValue(raw) {
  if (!raw.length) return { kind: 'empty', value: '' };
  try { return { kind: 'json', value: JSON.parse(raw) }; } catch (_) { return { kind: 'text', value: raw }; }
}
function request(port, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = process.hrtime();
    const req = http.request({ hostname: '127.0.0.1', port, method: input.method, path: input.path, headers: input.headers }, res => {
      const chunks = []; res.on('data', b => chunks.push(b)); res.on('error', reject);
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, rawBody: raw, body: bodyValue(raw), durationMs: elapsed(start) });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP observation timed out')));
    req.on('error', reject); req.end(input.body);
  });
}
function websocket(WebSocket, port, input, definition) {
  return new Promise(resolve => {
    const start = process.hrtime();
    const observation = { frames: [], terminalCount: 0, closeOrigin: null };
    const ws = new WebSocket('ws://127.0.0.1:' + port + input.path, { headers: input.headers });
    let done = false, holdTimer, terminalStart;
    const finish = failure => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(holdTimer);
      if (failure) observation.failure = failure;
      observation.durationMs = elapsed(start); resolve(observation);
    };
    const timer = setTimeout(() => { finish('WebSocket observation timed out'); ws.terminate(); }, definition.timeoutMs || suite.defaultTimeoutMs);
    ws.on('open', () => {
      observation.opened = true;
      input.messages.forEach(m => ws.send(typeof m === 'string' ? m : JSON.stringify(m)));
    });
    ws.on('message', raw => {
      const text = raw.toString(); let message;
      try { message = JSON.parse(text); } catch (_) { observation.invalidFrame = true; }
      observation.frames.push({ raw: text, message, receivedAtMs: elapsed(start) });
      if (message && message.final === true) {
        observation.terminalCount++;
        if (observation.terminalCount !== 1) return;
        terminalStart = process.hrtime();
        holdTimer = setTimeout(() => {
          observation.openAfterFinal = ws.readyState === WebSocket.OPEN;
          observation.holdAfterFinalMs = elapsed(terminalStart);
          observation.closeOrigin = 'client'; ws.close(1000, 'fixture complete');
        }, definition.closeAfterFinalMs || 30);
      }
    });
    ws.on('close', (code, reason) => {
      observation.close = { code, reason: reason.toString() };
      if (!observation.closeOrigin) {
        observation.closeOrigin = 'server';
        if (terminalStart) { observation.openAfterFinal = false; observation.holdAfterFinalMs = elapsed(terminalStart); }
      }
      finish();
    });
    ws.on('unexpected-response', (req, res) => {
      observation.upgrade = { status: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, rawBody: '' };
      res.on('data', b => { observation.upgrade.rawBody += b.toString(); });
      res.on('end', () => { observation.upgrade.body = bodyValue(observation.upgrade.rawBody); finish(); ws.terminate(); });
    });
    ws.on('error', error => { if (!done) finish(error.message); });
  });
}
function skillResponse(requestBody) {
  const update = requestBody.type === 'LISTEN_UPDATE';
  const incoming = requestBody.data && requestBody.data.skill && requestBody.data.skill.session;
  const valid = incoming && incoming.id === 'fixture-session' && incoming.nodeID === 7 && incoming.data && incoming.data.answer === 'preserve me';
  return {
    type: 'SKILL_ACTION', msgID: 'fixture-skill-response', ts: fixedNow,
    data: {
      skill: { id: 'skill1', session: { id: 'fixture-session', nodeID: update ? 8 : 7, data: { answer: 'preserve me', turn: update ? 2 : 1 }, trace: ['fixture-node'] } },
      action: { type: 'JCP', config: { version: '2.0.0', jcp: { type: 'SLIM', config: { play: { esml: '<speak>Fixture answer <break size="0.2"/> intact.</speak>' } } } } },
      analytics: { skill1: [{ event: 'Fixture action', properties: { nullValue: null, count: 0, enabled: false, requestType: requestBody.type, continued: !!(update && valid) } }] },
    },
  };
}
async function run(adapter, out, manifestPath) {
  const manifestBytes = fs.readFileSync(manifestPath);
  const report = { schemaVersion: 1, implementation: adapter.name, runtime: process.version, suite: suite.id, suiteSha256: sha(JSON.stringify(suite)),
    driverSha256: sha(fs.readFileSync(__filename)), manifestSha256: sha(manifestBytes), clock: suite.clock, endpoints: {}, cases: [], lateEffects: [] };
  let current, nextEffect = 0;
  const owners = new Map();
  const peer = http.createServer((req, res) => {
    const start = process.hrtime(), tagged = owners.get(req.headers['x-jibo-transid']), owner = tagged || current;
    const chunks = []; req.on('data', b => chunks.push(b));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed = bodyValue(raw), body = parsed.value;
      const effect = { order: nextEffect++, attribution: tagged ? 'trace-header' : 'active-case', method: req.method, path: req.url, headers: req.headers, rawBody: raw, body: parsed };
      (owner ? owner.effects : report.lateEffects).push(effect);
      let response = {}, status = 200;
      if (req.url === '/v1/parse') {
        const text = body && body.data && body.data.text;
        if (text === 'provider failure') { status = 503; response = { message: 'fixture NLU unavailable' }; }
        else response = { type: 'NLU', msgID: 'fixture-parser-response', ts: fixedNow,
          data: { intent: text === 'no matching intent' ? null : text === 'local answer' ? 'decoyIntent' : 'matchingIntent',
            entities: text === 'no matching intent' ? null : { fixtureEntity: 'keep every field' }, rules: ['launch'] } };
      } else if (req.url === '/skill') response = skillResponse(body);
      effect.response = { status, body: clone(response) };
      res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response));
      effect.durationMs = elapsed(start);
    });
  });
  await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
  const peerURL = 'http://127.0.0.1:' + peer.address().port;
  report.endpoints.peer = peerURL;
  const reportManifest = JSON.parse(manifestBytes); reportManifest.URL = peerURL + '/skill';
  const skills = [{ id: 'skill1', URL: peerURL + '/skill', intents: [{ name: 'matchingIntent', memo: { route: 'fixture', enabled: false } }] }, reportManifest];
  let subject;
  try {
    subject = await adapter.start({ peerURL, skills, secret: suite.secret });
    report.endpoints.base = 'http://127.0.0.1:' + subject.basePort;
    report.endpoints.hub = 'http://127.0.0.1:' + subject.hubPort;
    for (const definition of suite.cases) {
      current = { id: definition.id, transport: definition.transport || 'HTTP', effects: [] };
      report.cases.push(current);
      owners.set(definition.id, current);
      const started = process.hrtime();
      try {
        const port = definition.service === 'base' ? subject.basePort : subject.hubPort;
        if (current.transport === 'HTTP') {
          const hdrs = Object.assign({ connection: 'close' }, headers(definition.auth, definition.id));
          if (definition.contentType) hdrs['content-type'] = definition.contentType;
          if (definition.body !== undefined) hdrs['content-length'] = Buffer.byteLength(definition.body);
          current.input = { method: definition.method, path: definition.path, headers: hdrs };
          if (definition.body !== undefined) current.input.body = definition.body;
          current.response = await request(port, current.input, definition.timeoutMs || suite.defaultTimeoutMs);
        } else {
          let context = { general: { accountID: 'fixture-account', robotID: 'fixture-robot' }, runtime: { perception: { speaker: null } }, skill: {} };
          if (definition.sessionFrom) {
            const prior = report.cases.find(c => c.id === definition.sessionFrom);
            const reply = prior.frames && prior.frames.find(f => f.message && f.message.type === 'SKILL_ACTION');
            if (!reply || !reply.message.data.skill.session) throw new Error('Missing session from ' + definition.sessionFrom);
            context.skill = clone(reply.message.data.skill);
          }
          const envelope = (type, data) => ({ type, data, msgID: 'fixture-input-' + type, ts: fixedNow });
          const messages = definition.rawFrames || (definition.text === undefined ? [] : [
            envelope('LISTEN', { rules: ['launch'], mode: 'CLIENT_ASR', lang: 'en-US' }),
            envelope('CONTEXT', context), envelope('CLIENT_ASR', { text: definition.text }),
          ]);
          current.input = { path: definition.path, headers: headers(definition.auth, definition.id), messages };
          Object.assign(current, await websocket(adapter.WebSocket, port, current.input, definition));
        }
      } catch (error) { current.failure = error.message; }
      current.durationMs = elapsed(started);
      // Requests already started retain their original owner. Give asynchronous
      // history writes a bounded drain window before beginning another case.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    current = null;
    await new Promise(resolve => setTimeout(resolve, 50));
    report.captureComplete = true;
  } catch (error) { report.captureComplete = false; report.failure = error.stack; }
  finally {
    if (subject) await subject.close();
    await new Promise(resolve => peer.close(resolve));
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ implementation: adapter.name, cases: report.cases.length, complete: report.captureComplete }));
  }
  if (!report.captureComplete) process.exitCode = 1;
}
module.exports = { installClock, run, suite };
