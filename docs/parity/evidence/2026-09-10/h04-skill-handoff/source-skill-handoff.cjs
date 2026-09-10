'use strict';

// H-04 source control: runs the PINNED original Pegasus listen handler under the
// archived Node 8.9.4 runtime and records, for each skill launch/update/redirect/
// handoff case, the exact HTTP request the hub sent and the exact WS frames it
// emitted. This is the oracle Phoenix is compared against.
//
// Usage: node source-skill-handoff.cjs <referenceRoot> <outPath>

const fs = require('fs');
const http = require('http');
const EventEmitter = require('events');
const path = require('path');
const Module = require('module');

// The listen path does not execute ASR here; replace only the native/provider
// loader that would initialize the full Google ASR dependency tree at import.
const sourceLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../asr/ASRFactory' || request.endsWith('/asr/ASRFactory')) {
    return { ASRFactory: { startSession() { throw new Error('ASR is outside this control'); } } };
  }
  if (request === '../asr/ASRUtils' || request.endsWith('/asr/ASRUtils')) {
    return { ASRUtils: { cleanHintsEOS(value) { return value; } } };
  }
  return sourceLoad.call(this, request, parent, isMain);
};

const ref = process.argv[2];
const outPath = process.argv[3];
const utils = require(path.join(ref, 'packages/utils/lib/index'));
const ListenHandler = require(path.join(ref, 'packages/hub/lib/listen/ListenHandler')).ListenHandler;
const SkillConfigManager = require(path.join(ref, 'packages/hub/lib/config/SkillConfigManager')).SkillConfigManager;
const SkillRequestMaker = require(path.join(ref, 'packages/hub/lib/skill/SkillRequestMaker')).SkillRequestMaker;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (v) => JSON.parse(JSON.stringify(v));
function logger() {
  return { createChild() { return logger(); }, debug() {}, info() {}, warn() {}, error() {} };
}
const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });

function contextOf(skill) {
  return {
    general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' },
    runtime: { perception: { speaker: 'person-h04', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
    skill: skill || {},
  };
}

function components(manager, maker) {
  return {
    skillConfigManager: manager,
    skillRequestMaker: maker,
    intentRouter: { getSkillIDFromNLU(nlu) { return nlu.intent === 'launch-intent' ? { skillID: 'source' } : nlu.intent === 'robot-intent' ? { skillID: 'robot-skill' } : null; } },
    hubSettings: { recordLaunchHistory: false, recordSpeechHistory: false },
    history: { skillLaunch: { writeSkillLaunch() { return Promise.resolve(); } } },
    parser: { handleNLU() { throw new Error('parser is outside this control'); } },
  };
}

class Socket extends EventEmitter {
  constructor(headers) {
    super();
    this.auth = { id: 'account-h04', friendlyId: 'robot-h04' };
    this.remoteAddress = '::ffff:127.0.0.1';
    this.jibo = new utils.service.JiboHeaders(headers || {});
    this.log = logger();
  }
}
class Response {
  constructor(socket) {
    this.socket = socket;
    this.ended = false;
    this.frames = [];
    socket.on('close', () => { this.ended = true; });
  }
  // Mirrors ResponseWrapper.write (BaseWebsocketHandler.ts:96-118): insert a
  // default timings.total, and once a final frame is written the response is
  // ended so every later write is refused.
  write(frame) {
    if (this.ended) return false;
    if (!frame.timings) frame.timings = { total: 0 };
    this.frames.push(clone(frame));
    if (frame.final) this.ended = true;
    return true;
  }
  writeFinal(frame) { frame.final = true; return this.write(frame); }
}

/** A controlled skill peer. `program` maps skillID -> list of answers. */
function startPeer(program) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const entry = { body: JSON.parse(raw), headers: req.headers };
      requests.push(entry);
      const queue = program[entry.body.data.skill.id] || [];
      const answer = queue.shift() || { status: 500, body: { message: 'unprogrammed' } };
      if (answer.hang) return; // never respond
      const send = () => {
        res.statusCode = answer.status || 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(answer.body));
      };
      if (answer.delay) setTimeout(send, answer.delay); else send();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1/main` }));
  });
}

async function runTurn(url, { skill, intent = 'launch-intent', hotphrase = false, timeoutMap } = {}) {
  const realSetTimeout = global.setTimeout;
  if (timeoutMap) global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, timeoutMap[ms] || ms, ...a);
  try {
    const manager = new SkillConfigManager([
      { id: 'source', URL: url, intents: [{ name: 'launch-intent' }] },
      { id: 'destination', URL: url, intents: [] },
      { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'launch-intent' }] },
    ]);
    const maker = new SkillRequestMaker(manager);
    const socket = new Socket({ 'x-jibo-transid': 'tid:h04-source' });
    const response = new Response(socket);
    const handler = new ListenHandler(components(manager, maker));
    const promise = handler.handleSocketMessages(socket, response)
      .then(() => ({ outcome: 'resolved' }))
      .catch((error) => ({ outcome: 'rejected', error: { name: error.name, message: error.message, code: error.code } }));
    socket.emit('message', msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase, rules: ['launch'] }));
    await sleep(0);
    socket.emit('message', msg('CONTEXT', contextOf(skill)));
    await sleep(0);
    socket.emit('message', msg('CLIENT_NLU', { intent, rules: ['launch'], entities: { e: 'v' }, external: {} }));
    const terminal = await Promise.race([promise, sleep(600).then(() => ({ outcome: 'pending' }))]);
    return { terminal, frames: response.frames };
  } finally {
    if (timeoutMap) global.setTimeout = realSetTimeout;
  }
}

const action = (skillID, session, extra) => ({ type: 'SKILL_ACTION', msgID: `peer-${session}`, ts: 1700000000000,
  data: Object.assign({ skill: { id: skillID, session: { id: session, nodeID: 1 } }, action: { type: 'JCP' } }, extra || {}) });
const redirect = (from, session, target, extra) => ({ type: 'SKILL_REDIRECT', msgID: 'peer-redirect', ts: 1700000000000,
  data: Object.assign({ skill: { id: from, session: { id: session } }, skillID: target,
    nlu: { intent: 'redirect-intent', entities: { r: 1 } }, asr: { text: 'redirect asr' }, memo: { from } }, extra || {}) });

const summarizeRequest = (entry) => ({
  type: entry.body.type,
  dataSkill: entry.body.data.skill,
  resultKeys: Object.keys(entry.body.data.result).sort(),
  nlu: entry.body.data.result.nlu,
  asr: entry.body.data.result.asr === undefined ? '<absent>' : entry.body.data.result.asr,
  memo: entry.body.data.result.memo === undefined ? '<absent>' : entry.body.data.result.memo,
  generalKeys: Object.keys(entry.body.data.general).sort(),
  trace: {
    transId: entry.headers['x-jibo-transid'],
    robotId: entry.headers['x-jibo-robotid'],
    loggingConfig: entry.headers['x-jibo-logging-config'],
  },
});
const summarizeFrames = (frames) => frames.map((f) => ({
  type: f.type, final: f.final, timings: f.timings, data: f.data,
}));

(async () => {
  const result = { runtime: process.version, sourceRevision: '5c0a7390539663ba749d360de348a428c088505c', cases: {} };

  // S1: launch
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-launch', { fireAndForget: true, analytics: { kept: 1 } }) }] });
    const turn = await runTurn(peer.url, {});
    result.cases.launch = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S2: redirect with two measurable legs
  {
    const peer = await startPeer({
      source: [{ delay: 60, body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ delay: 60, body: action('destination', 'sess-dest') }],
    });
    const turn = await runTurn(peer.url, {});
    result.cases.redirect = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S3: continued session -> LISTEN_UPDATE
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-continued') }] });
    const turn = await runTurn(peer.url, { intent: 'followup-intent', hotphrase: false, skill: { id: 'source', session: { id: 'existing', opaque: true } } });
    result.cases.update = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S4: too many redirects
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ body: redirect('destination', 'sess-dest', 'source') }],
    });
    const turn = await runTurn(peer.url, {});
    result.cases.tooMany = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S5: destination hangs through the redirect leg (10s budget mapped to 200ms)
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ hang: true }],
    });
    const turn = await runTurn(peer.url, { timeoutMap: { 10000: 200 } });
    result.cases.redirectTimeout = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S6: initial skill hangs (10s budget mapped to 200ms)
  {
    const peer = await startPeer({ source: [{ hang: true }] });
    const turn = await runTurn(peer.url, { timeoutMap: { 10000: 200 } });
    result.cases.launchTimeout = { terminal: turn.terminal, requests: peer.requests.length, frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S5b/S6b: the two timeout layers race; sample both repeatedly to expose it.
  const timeoutSamples = { launch: [], redirect: [] };
  for (let i = 0; i < 12; i += 1) {
    {
      const peer = await startPeer({ source: [{ hang: true }] });
      const turn = await runTurn(peer.url, { timeoutMap: { 10000: 200 } });
      const frame = turn.frames.filter((f) => f.type === 'ERROR').pop();
      timeoutSamples.launch.push({ frame: frame ? frame.data : null, terminal: turn.terminal });
      peer.server.close();
    }
    {
      const peer = await startPeer({
        source: [{ body: redirect('source', 'sess-source', 'destination') }],
        destination: [{ hang: true }],
      });
      const turn = await runTurn(peer.url, { timeoutMap: { 10000: 200 } });
      const frame = turn.frames.filter((f) => f.type === 'ERROR').pop();
      timeoutSamples.redirect.push({ frame: frame ? frame.data : null, terminal: turn.terminal });
      peer.server.close();
    }
  }
  result.cases.timeoutSamples = timeoutSamples;

  // S7: cloud skill returns a non-2xx
  {
    const peer = await startPeer({ source: [{ status: 500, body: { error: 'boom' } }] });
    const turn = await runTurn(peer.url, {});
    result.cases.skillFailure = { terminal: turn.terminal, requests: peer.requests.length, frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S8: on-robot match (no HTTP request, final LISTEN)
  {
    const peer = await startPeer({});
    const manager = new SkillConfigManager([
      { id: 'source', URL: peer.url, intents: [] },
      { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'launch-intent' }] },
    ]);
    const maker2 = new SkillRequestMaker(manager);
    const socket = new Socket({ 'x-jibo-transid': 'tid:h04-source' });
    const response = new Response(socket);
    const handler = new ListenHandler(components(manager, maker2));
    const promise = handler.handleSocketMessages(socket, response)
      .then(() => ({ outcome: 'resolved' })).catch((e) => ({ outcome: 'rejected', error: { name: e.name, message: e.message, code: e.code } }));
    socket.emit('message', msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: true, rules: ['launch'] }));
    await sleep(0);
    socket.emit('message', msg('CONTEXT', contextOf({})));
    await sleep(0);
    socket.emit('message', msg('CLIENT_NLU', { intent: 'robot-intent', rules: ['launch'], entities: {}, external: {} }));
    const terminal = await Promise.race([promise, sleep(600).then(() => ({ outcome: 'pending' }))]);
    result.cases.onRobot = { terminal, requests: peer.requests.length, frames: summarizeFrames(response.frames) };
    peer.server.close();
  }

  // S9: redirect to an on-robot skill (notification is final, then the launch is refused)
  {
    const peer = await startPeer({ source: [{ body: redirect('source', 'sess-source', 'robot-skill') }] });
    const turn = await runTurn(peer.url, {});
    result.cases.redirectToOnRobot = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  // S10: redirect whose destination returns a non-2xx
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ status: 500, body: { error: 'dest-boom' } }],
    });
    const turn = await runTurn(peer.url, {});
    result.cases.redirectDestinationFailure = { terminal: turn.terminal, requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
    peer.server.close();
  }

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  const compact = {};
  Object.keys(result.cases).forEach((k) => {
    const v = result.cases[k];
    compact[k] = { terminal: v.terminal, requestCount: Array.isArray(v.requests) ? v.requests.length : v.requests };
  });
  console.log(JSON.stringify(compact));
  process.exit(0);
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
