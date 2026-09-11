'use strict';

// H-08 source control: runs the PINNED original Pegasus listen handler under the
// archived Node 8.9.4 runtime and records, for each turn, the EXACT speech-history
// save payload, every intermediate SpeechHistoryRecord.update() call in order, and
// every skill-launch write — i.e. the real side-effect contract the hub must honour.
//
// This extends the H-04 harness (docs/parity/evidence/2026-09-10/h04-skill-handoff/
// source-skill-handoff.cjs) with:
//   * hubSettings.recordLaunchHistory = true, recordSpeechHistory = true
//   * recording mocks for history.skillLaunch.writeSkillLaunch and
//     history.speechHistory.save (captures the JiboHeaders each call carries)
//   * a prototype probe on SpeechHistoryRecord.update() to capture the exact
//     field-by-field update sequence, including the pre-normalization ASR.
//   * a stub ASR session so the server-ASR path (performASR -> updateSpeechHistoryRecord
//     before normalizeString) is actually executed.
//
// Usage: node source-speech-history.cjs <referenceRoot> <outPath>

const fs = require('fs');
const http = require('http');
const EventEmitter = require('events');
const path = require('path');
const Module = require('module');

// The ASR provider loader is replaced so the listen path can run without the full
// Google ASR dependency tree; each turn can install its own fake session.
let asrFactoryImpl = { startSession() { throw new Error('ASR is outside this control'); } };
const sourceLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '../asr/ASRFactory' || request.endsWith('/asr/ASRFactory')) {
    return { ASRFactory: { startSession(config, logger) { return asrFactoryImpl.startSession(config, logger); } } };
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
const SpeechHistoryRecord = require(path.join(ref, 'packages/history-client/lib/speech/SpeechHistoryRecord')).SpeechHistoryRecord;
const TransactionHandler = require(path.join(ref, 'packages/hub/lib/utils/TransactionHandler')).TransactionHandler;
const ListenTransactionHandler = require(path.join(ref, 'packages/hub/lib/listen/ListenTransactionHandler')).ListenTransactionHandler;

// Control-flow probe: capture the exact order of resolve/reject and the two
// lifecycle hooks so a double save can be attributed, not guessed.
let activeProbes = null;
function probeClass(klass, names) {
  names.forEach((m) => {
    const orig = klass.prototype[m];
    klass.prototype[m] = function (...a) {
      if (activeProbes) activeProbes(`${klass.name}.${m}`);
      return orig.apply(this, a);
    };
  });
}
probeClass(TransactionHandler, ['resolve', 'reject']);
probeClass(ListenTransactionHandler, ['onTransactionSuccess', 'onTransactionError', 'done']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (v) => (v === undefined ? '<undefined>' : JSON.parse(JSON.stringify(v)));
function logger() {
  return { createChild() { return logger(); }, debug() {}, info() {}, warn() {}, error() {} };
}
const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normId = (v) => (typeof v === 'string' && UUID.test(v) ? '<uuid>' : v);

// Capture the SpeechHistoryRecord.update() sequence for the turn currently running.
let activeUpdates = null;
const origUpdate = SpeechHistoryRecord.prototype.update;
SpeechHistoryRecord.prototype.update = function (data) {
  if (activeUpdates) activeUpdates.push(clone(data));
  return origUpdate.call(this, data);
};

function contextOf(skill) {
  return {
    general: { accountID: 'account-h08', robotID: 'robot-h08', lang: 'en', release: '1.8.0' },
    runtime: { perception: { speaker: 'person-h08', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
    skill: skill || {},
  };
}

/** Build hub components with recording history mocks and a configurable parser. */
function components(manager, maker, opts) {
  opts = opts || {};
  const events = opts.events;
  const ui = {
    transId: { get: null }, // placeholder, replaced below
  };
  return {
    skillConfigManager: manager,
    skillRequestMaker: maker,
    intentRouter: {
      getSkillIDFromNLU(nlu) {
        return nlu.intent === 'launch-intent' ? { skillID: 'source' }
          : nlu.intent === 'robot-intent' ? { skillID: 'robot-skill' } : null;
      },
    },
    hubSettings: opts.hubSettings || { recordLaunchHistory: true, recordSpeechHistory: true },
    history: {
      skillLaunch: {
        writeSkillLaunch(data, jiboHeaders) {
          events.push({
            kind: 'skillLaunch', seq: events.length,
            data: clone(data),
            headers: jiboHeaders && jiboHeaders.toHeader ? jiboHeaders.toHeader() : jiboHeaders,
          });
          return Promise.resolve('launch-id');
        },
      },
      speechHistory: {
        save(record, jiboHeaders) {
          events.push({
            kind: 'speechSave', seq: events.length,
            recordId: record.id === undefined ? '<undefined>' : record.id,
            data: clone(record.data),
            headers: jiboHeaders && jiboHeaders.toHeader ? jiboHeaders.toHeader() : jiboHeaders,
          });
          return Promise.resolve(record);
        },
      },
    },
    parser: opts.parser || { handleNLU() { throw new Error('parser is outside this control'); } },
  };
}

class Socket extends EventEmitter {
  constructor(headers) {
    super();
    this.auth = { id: 'account-h08', friendlyId: 'robot-h08' };
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
  // Mirrors ResponseWrapper.write (BaseWebsocketHandler.ts:96-118): default
  // timings.total, and once a final frame is written the response is ended.
  write(frame) {
    if (this.ended) return false;
    if (!frame.timings) frame.timings = { total: 0 };
    this.frames.push(clone(frame));
    if (frame.final) this.ended = true;
    return true;
  }
  writeFinal(frame) { frame.final = true; return this.write(frame); }
}

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
      if (answer.hang) return;
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

/**
 * Drive one full turn. `script` describes the incoming messages and runtime knobs.
 */
async function runTurn(peer, script) {
  script = script || {};
  const events = [];
  const updates = [];
  const probes = [];
  activeUpdates = updates;
  activeProbes = (name) => { probes.push(`${name}@${events.length}`); events.push({ kind: 'probe', name, seq: events.length }); };
  const realSetTimeout = global.setTimeout;
  if (script.timeoutMap) global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, script.timeoutMap[ms] || ms, ...a);
  try {
    const manager = new SkillConfigManager([
      { id: 'source', URL: peer.url, intents: [{ name: 'launch-intent' }] },
      { id: 'destination', URL: peer.url, intents: [] },
      { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'launch-intent' }] },
    ]);
    const maker = new SkillRequestMaker(manager);
    const socket = new Socket({ 'x-jibo-transid': 'tid:h08-source' });
    const response = new Response(socket);
    const handler = new ListenHandler(components(manager, maker, {
      events,
      hubSettings: script.hubSettings,
      parser: script.parser,
    }));
    const promise = handler.handleSocketMessages(socket, response)
      .then(() => ({ outcome: 'resolved' }))
      .catch((error) => ({ outcome: 'rejected', error: { name: error.name, message: error.message, code: error.code } }));
    // LISTEN
    socket.emit('message', msg('LISTEN', script.listen || { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] }));
    await sleep(script.gap || 0);
    // CONTEXT (skipped when the script says so)
    if (!script.skipContext) {
      socket.emit('message', msg('CONTEXT', contextOf(script.skill)));
      await sleep(script.gap || 0);
    }
    if (script.clientAsr) {
      socket.emit('message', msg('CLIENT_ASR', script.clientAsr));
    } else if (script.clientNlu) {
      socket.emit('message', msg('CLIENT_NLU', script.clientNlu));
    }
    const terminal = await Promise.race([promise, sleep(script.settle || 600).then(() => ({ outcome: 'pending' }))]);
    await sleep(script.drain || 30); // let fire-and-forget saves settle
    return { terminal, frames: response.frames, events, updates, probes };
  } finally {
    activeUpdates = null;
    activeProbes = null;
    if (script.timeoutMap) global.setTimeout = realSetTimeout;
  }
}

const action = (skillID, session, extra) => ({ type: 'SKILL_ACTION', msgID: `peer-${session}`, ts: 1700000000000,
  data: Object.assign({ skill: { id: skillID, session: { id: session, nodeID: 1 } }, action: { type: 'JCP' } }, extra || {}) });
const redirect = (from, session, target, extra) => ({ type: 'SKILL_REDIRECT', msgID: 'peer-redirect', ts: 1700000000000,
  data: Object.assign({ skill: { id: from, session: { id: session } }, skillID: target,
    nlu: { intent: 'redirect-intent', entities: { r: 1 } }, asr: { text: 'redirect asr' }, memo: { from } }, extra || {}) });

/** Normalize a captured event for stable diffing (uuid sessionIDs, timestamps vary per run). */
function summarize(events) {
  return events.map((e) => {
    if (e.kind === 'probe') return { kind: e.kind, name: e.name, seq: e.seq };
    if (e.kind === 'skillLaunch') {
      return {
        kind: e.kind, seq: e.seq,
        robotID: e.data.robotID,
        sessionID: normId(e.data.sessionID),
        skillID: e.data.skillID,
        intent: e.data.intent,
        personIDs: e.data.personIDs,
        headers: e.headers,
      };
    }
    // speechSave
    const d = e.data;
    return {
      kind: e.kind, seq: e.seq, recordId: e.recordId,
      robotID: d.robotID, accountID: d.accountID, transID: d.transID,
      timestamp: typeof d.timestamp === 'number' ? '<number>' : d.timestamp,
      audioFileURL: d.audioFileURL,
      hasAsr: Object.prototype.hasOwnProperty.call(d, 'asr'),
      asr: d.asr,
      hasNlu: Object.prototype.hasOwnProperty.call(d, 'nlu'),
      nlu: d.nlu,
      hasMatch: Object.prototype.hasOwnProperty.call(d, 'match'),
      match: d.match,
      redirect: d.redirect,
      skill: d.skill,
      error: d.error,
      headers: e.headers,
    };
  });
}

const summarizeFrames = (frames) => frames.map((f) => ({ type: f.type, final: f.final, match: f.data && f.data.match, code: f.data && f.data.code }));

(async () => {
  const result = { runtime: process.version, sourceRevision: '5c0a7390539663ba749d360de348a428c088505c', cases: {} };
  const record = (name, turn, extra) => {
    result.cases[name] = Object.assign({
      terminal: turn.terminal,
      updateSequence: turn.updates,
      sideEffects: summarize(turn.events),
      frames: summarizeFrames(turn.frames),
    }, extra || {});
  };

  // C1: cloud launch success (CLIENT_NLU)
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-launch') }] });
    const turn = await runTurn(peer, { clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} } });
    record('launch', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C2: continued session -> LISTEN_UPDATE
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-continued') }] });
    const turn = await runTurn(peer, {
      clientNlu: { intent: 'followup-intent', rules: ['launch'], entities: { e: 'v' }, external: {} },
      skill: { id: 'source', session: { id: 'existing-session', opaque: { keep: true } } },
    });
    record('launchUpdate', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C3: redirect success
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ body: action('destination', 'sess-dest') }],
    });
    const turn = await runTurn(peer, { clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} } });
    record('redirect', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C4: too many redirects (error path)
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ body: redirect('destination', 'sess-dest', 'source') }],
    });
    const turn = await runTurn(peer, { clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} } });
    record('tooManyRedirects', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C5: skill non-2xx (error path)
  {
    const peer = await startPeer({ source: [{ status: 500, body: { error: 'boom' } }] });
    const turn = await runTurn(peer, { clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} } });
    record('skillFailure', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C6: redirect destination non-2xx (error path)
  {
    const peer = await startPeer({
      source: [{ body: redirect('source', 'sess-source', 'destination') }],
      destination: [{ status: 500, body: { error: 'dest-boom' } }],
    });
    const turn = await runTurn(peer, { clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} } });
    record('redirectDestinationFailure', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C7: on-robot match (no HTTP request; recordLaunchHistory path without a session)
  {
    const peer = await startPeer({});
    const turn = await runTurn(peer, { clientNlu: { intent: 'robot-intent', rules: ['launch'], entities: {}, external: {} } });
    record('onRobot', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C8: server-ASR path (performASR -> updateSpeechHistoryRecord BEFORE normalizeString)
  {
    asrFactoryImpl = {
      startSession() {
        return {
          onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {},
          getLastIncremental() { return null; },
          start() { return Promise.resolve({ text: '  Hello   World ', confidence: 0.9 }); },
        };
      },
    };
    const peer = await startPeer({ source: [{ body: action('source', 'sess-asr') }] });
    const turn = await runTurn(peer, {
      listen: { lang: 'en-US', rules: ['launch'] }, // no mode -> server ASR
      parser: { handleNLU() { return Promise.resolve({ intent: 'launch-intent', entities: { e: 'v' }, rules: ['launch'] }); } },
      clientNlu: null,
    });
    record('serverAsr', turn, { skillRequests: peer.requests.length });
    peer.server.close();
    asrFactoryImpl = { startSession() { throw new Error('ASR is outside this control'); } };
  }

  // C9: server-ASR GARBAGE short-circuit -> emitListenResult(null, true)
  {
    asrFactoryImpl = {
      startSession() {
        return {
          onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {},
          getLastIncremental() { return null; },
          start() { return Promise.resolve({ text: 'blah', confidence: 0.1, annotation: 'GARBAGE' }); },
        };
      },
    };
    const peer = await startPeer({});
    const turn = await runTurn(peer, { listen: { lang: 'en-US', rules: ['launch'] } });
    record('serverAsrGarbage', turn, { skillRequests: peer.requests.length });
    peer.server.close();
    asrFactoryImpl = { startSession() { throw new Error('ASR is outside this control'); } };
  }

  // C10: no match -> emitListenResult(null, true)
  {
    const peer = await startPeer({});
    const turn = await runTurn(peer, { clientNlu: { intent: 'no-such-intent', rules: ['launch'], entities: {}, external: {} } });
    record('noMatch', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C11: speech logging disabled, launch history enabled -> launch rows only, no speech calls
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-nospeech') }] });
    const turn = await runTurn(peer, {
      clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} },
      hubSettings: { recordLaunchHistory: true, recordSpeechHistory: false },
    });
    record('speechDisabled', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C12: both flags off -> zero history side effects
  {
    const peer = await startPeer({ source: [{ body: action('source', 'sess-noflags') }] });
    const turn = await runTurn(peer, {
      clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} },
      hubSettings: { recordLaunchHistory: false, recordSpeechHistory: false },
    });
    record('flagsDisabled', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  // C13: parser failure -> HubError(PARSER) -> error path
  {
    asrFactoryImpl = {
      startSession() {
        return {
          onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {},
          getLastIncremental() { return null; },
          start() { return Promise.resolve({ text: 'hello', confidence: 0.5 }); },
        };
      },
    };
    const peer = await startPeer({});
    const turn = await runTurn(peer, {
      listen: { lang: 'en-US', rules: ['launch'] },
      parser: { handleNLU() { return Promise.reject(new Error('parser is outside this control')); } },
    });
    record('parserFailure', turn, { skillRequests: peer.requests.length });
    peer.server.close();
    asrFactoryImpl = { startSession() { throw new Error('ASR is outside this control'); } };
  }

  // C14: skill launch timeout -> HubError(TIMEOUT_SKILL) -> error path
  {
    const peer = await startPeer({ source: [{ hang: true }] });
    const turn = await runTurn(peer, {
      clientNlu: { intent: 'launch-intent', rules: ['launch'], entities: { e: 'v' }, external: {} },
      timeoutMap: { 10000: 200 },
      settle: 800,
    });
    record('skillTimeout', turn, { skillRequests: peer.requests.length });
    peer.server.close();
  }

  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  const compact = {};
  Object.keys(result.cases).forEach((k) => {
    const v = result.cases[k];
    compact[k] = {
      terminal: v.terminal,
      sideEffects: v.sideEffects.map((s) => s.kind),
      updates: v.updateSequence.length,
    };
  });
  console.log(JSON.stringify(compact));
  process.exit(0);
})().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
