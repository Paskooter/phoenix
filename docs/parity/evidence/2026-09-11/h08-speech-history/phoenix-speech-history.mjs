// H-08 Phoenix control: drives the REAL Phoenix gateway (createGateway) over a real
// WebSocket per case and records the same three measurements the pinned-original
// source oracle records (source-speech-history.cjs): the ordered SpeechHistoryRecord
// updates, the ordered history side effects (skillLaunch / speechSave) with the
// exact HTTP headers, and the emitted frames.
//
// Unlike the source harness, the history sink here is a REAL HTTP server, so the
// bodies/headers/paths on the wire are observed too.
//
// Usage: node phoenix-speech-history.mjs <outPath>

import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../../../../../packages/gateway/src/index.js';
import { jwt } from '../../../../../packages/common/src/index.js';
import { SpeechHistoryRecord } from '../../../../../packages/gateway/src/historyClient.js';

const outPath = process.argv[2];
const SECRET = 'h08-speech-history-secret';
const transId = 'tid:h08-source';
const clone = (v) => (v === undefined ? '<undefined>' : JSON.parse(JSON.stringify(v)));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const normId = (v) => (typeof v === 'string' && UUID.test(v) ? '<uuid>' : v);
const token = () => jwt.sign({ id: 'account-h08', friendlyId: 'robot-h08' }, SECRET);

let activeUpdates = null;
const origUpdate = SpeechHistoryRecord.prototype.update;
SpeechHistoryRecord.prototype.update = function (data) {
  if (activeUpdates) activeUpdates.push(clone(data));
  return origUpdate.call(this, data);
};

const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });

/** Controlled skill peer, same program shape as the source harness. */
function startPeer(program) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { body: JSON.parse(raw), headers: req.headers };
    requests.push(entry);
    const answer = (program[entry.body.data.skill.id] || []).shift();
    if (!answer) { res.statusCode = 500; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ message: 'unprogrammed' })); }
    if (answer.hang) return;
    const send = () => {
      res.statusCode = answer.status || 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer.body));
    };
    if (answer.delay) setTimeout(send, answer.delay); else send();
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    server, requests, url: `http://127.0.0.1:${server.address().port}/v1/main`,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  }));
}

/** A real history sink: records every request it receives and answers like the service. */
function startHistory() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'PUT' ? { id: req.url.split('/').pop() } : { id: `speech-${requests.length}` }));
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    server, requests, url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  }));
}

const fakeAsr = (result) => () => ({
  onStartOfSpeech() {}, onEndOfSpeech() {}, provideAudio() {}, stop() {},
  getLastIncremental() { return null; },
  start() { return Promise.resolve(result); },
});

const context = (skill) => ({
  general: { accountID: 'account-h08', robotID: 'robot-h08', lang: 'en', release: '1.8.0' },
  runtime: { perception: { speaker: 'person-h08', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
  skill: skill || {},
});

async function runCase(history, script) {
  const peer = await startPeer(script.program || {});
  const updates = [];
  activeUpdates = updates;
  const realSetTimeout = global.setTimeout;
  if (script.timeoutMap) global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, script.timeoutMap[ms] || ms, ...a);
  const historyStart = history.requests.length;
  const frames = [];
  let gateway;
  try {
    gateway = await createGateway({
      skills: [
        { id: 'source', URL: peer.url, intents: [{ name: 'launch-intent' }] },
        { id: 'destination', URL: peer.url, intents: [] },
        { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'robot-intent' }] },
      ],
      parserURL: 'http://127.0.0.1:1', historyURL: history.url,
      disableAuth: false, hubTokenSecret: SECRET, accountUrl: '',
      recordLaunchHistory: script.recordLaunchHistory !== false,
      recordSpeechHistory: script.recordSpeechHistory !== false,
      asrProvider: 'none',
    });
    if (script.asr) gateway.components.asrProvider = script.asr;
    if (script.parser) gateway.components.parser.handleNLU = script.parser;
    await gateway.service.listen(0);
    const port = gateway.service.server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': transId },
    });
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    ws.send(msg('LISTEN', script.listen || { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase: false, rules: ['launch'] }));
    await new Promise((r) => realSetTimeout(r, script.gap || 0));
    if (!script.skipContext) {
      ws.send(msg('CONTEXT', context(script.skill)));
      await new Promise((r) => realSetTimeout(r, script.gap || 0));
    }
    if (script.clientAsr) ws.send(msg('CLIENT_ASR', script.clientAsr));
    else if (script.clientNlu) ws.send(msg('CLIENT_NLU', script.clientNlu));
    await Promise.race([
      new Promise((resolve) => { const poll = () => { if (frames.some((f) => f.final)) resolve(); else realSetTimeout(poll, 2); }; poll(); }),
      new Promise((r) => realSetTimeout(r, 3000)),
    ]);
    await new Promise((r) => realSetTimeout(r, script.drain || 120));
    return { frames, updates, historyRequests: history.requests.slice(historyStart) };
  } finally {
    activeUpdates = null;
    if (script.timeoutMap) global.setTimeout = realSetTimeout;
    if (gateway) {
      for (const c of gateway.wss.clients) c.terminate();
      gateway.wss.close();
      gateway.service.server.closeAllConnections?.();
      await new Promise((r) => gateway.service.server.close(r));
    }
    await peer.close();
  }
}

function summarizeFrames(frames) {
  const seen = [];
  for (const f of frames) {
    const row = { type: f.type, final: f.final, match: f.data && f.data.match, code: f.data && f.data.code };
    // Collapse the redirect notification + terminal ERROR duplicates by keeping all rows.
    seen.push(row);
  }
  return seen;
}

function summarizeSideEffects(historyRequests) {
  return historyRequests.map((r) => {
    const headers = {
      'x-jibo-transid': r.headers['x-jibo-transid'],
      'x-jibo-robotid': r.headers['x-jibo-robotid'],
      'x-jibo-logging-config': r.headers['x-jibo-logging-config'],
    };
    if (r.url === '/v1/skill/launch') {
      return {
        kind: 'skillLaunch', method: r.method, url: r.url,
        robotID: r.body.robotID, sessionID: normId(r.body.sessionID), skillID: r.body.skillID,
        intent: r.body.intent, personIDs: r.body.personIDs, headers,
      };
    }
    const d = r.body;
    return {
      kind: 'speechSave', method: r.method, url: r.url,
      robotID: d.robotID, accountID: d.accountID, transID: d.transID,
      timestamp: typeof d.timestamp === 'number' ? '<number>' : d.timestamp,
      audioFileURL: d.audioFileURL,
      hasAsr: Object.prototype.hasOwnProperty.call(d, 'asr'), asr: d.asr,
      hasNlu: Object.prototype.hasOwnProperty.call(d, 'nlu'), nlu: d.nlu,
      hasMatch: Object.prototype.hasOwnProperty.call(d, 'match'), match: d.match,
      redirect: d.redirect, skill: d.skill, error: d.error,
      headers,
    };
  });
}

const action = (skillID, session, extra) => ({ type: 'SKILL_ACTION', msgID: `peer-${session}`, ts: 1700000000000,
  data: { skill: { id: skillID, session: { id: session, nodeID: 1 } }, action: { type: 'JCP' }, ...(extra || {}) } });
const redirect = (from, session, target, extra) => ({ type: 'SKILL_REDIRECT', msgID: 'peer-redirect', ts: 1700000000000,
  data: { skill: { id: from, session: { id: session } }, skillID: target,
    nlu: { intent: 'redirect-intent', entities: { r: 1 } }, asr: { text: 'redirect asr' }, memo: { from }, ...(extra || {}) } });

const CNLU = (intent) => ({ intent, rules: ['launch'], entities: intent === 'launch-intent' ? { e: 'v' } : {}, external: {} });

const CASES = {
  launch: { program: { source: [{ body: action('source', 'sess-launch') }] }, clientNlu: CNLU('launch-intent') },
  launchUpdate: {
    program: { source: [{ body: action('source', 'sess-continued') }] },
    clientNlu: { intent: 'followup-intent', rules: ['launch'], entities: { e: 'v' }, external: {} },
    skill: { id: 'source', session: { id: 'existing-session', opaque: { keep: true } } },
  },
  redirect: {
    program: { source: [{ body: redirect('source', 'sess-source', 'destination') }], destination: [{ body: action('destination', 'sess-dest') }] },
    clientNlu: CNLU('launch-intent'),
  },
  tooManyRedirects: {
    program: { source: [{ body: redirect('source', 'sess-source', 'destination') }], destination: [{ body: redirect('destination', 'sess-dest', 'source') }] },
    clientNlu: CNLU('launch-intent'),
  },
  skillFailure: { program: { source: [{ status: 500, body: { error: 'boom' } }] }, clientNlu: CNLU('launch-intent') },
  redirectDestinationFailure: {
    program: { source: [{ body: redirect('source', 'sess-source', 'destination') }], destination: [{ status: 500, body: { error: 'dest-boom' } }] },
    clientNlu: CNLU('launch-intent'),
  },
  onRobot: { program: {}, clientNlu: CNLU('robot-intent') },
  serverAsr: {
    listen: { lang: 'en-US', rules: ['launch'] },
    asr: fakeAsr({ text: '  Hello   World ', confidence: 0.9 }),
    parser: () => Promise.resolve({ intent: 'launch-intent', entities: { e: 'v' }, rules: ['launch'] }),
    program: { source: [{ body: action('source', 'sess-asr') }] },
  },
  serverAsrGarbage: {
    listen: { lang: 'en-US', rules: ['launch'] },
    asr: fakeAsr({ text: 'blah', confidence: 0.1, annotation: 'GARBAGE' }),
    program: {},
  },
  noMatch: { program: {}, clientNlu: CNLU('no-such-intent') },
  speechDisabled: { program: { source: [{ body: action('source', 'sess-nospeech') }] }, clientNlu: CNLU('launch-intent'), recordSpeechHistory: false },
  flagsDisabled: { program: { source: [{ body: action('source', 'sess-noflags') }] }, clientNlu: CNLU('launch-intent'), recordLaunchHistory: false, recordSpeechHistory: false },
  parserFailure: {
    listen: { lang: 'en-US', rules: ['launch'] },
    asr: fakeAsr({ text: 'hello', confidence: 0.5 }),
    parser: () => Promise.reject(new Error('parser is outside this control')),
    program: {},
  },
  skillTimeout: {
    program: { source: [{ hang: true }] },
    clientNlu: CNLU('launch-intent'),
    timeoutMap: { 10000: 200 },
    drain: 900,
  },
};

const NORMALIZE_FRAME = (f) => f;
const result = { runtime: process.version, phoenixRevision: process.env.PHOENIX_REVISION || 'worktree', cases: {} };

const history = await startHistory();
try {
  for (const [name, script] of Object.entries(CASES)) {
    const out = await runCase(history, script);
    result.cases[name] = {
      terminal: { outcome: out.frames.some((f) => f.type === 'ERROR') ? 'error-frame' : 'resolved' },
      updateSequence: out.updates,
      sideEffects: summarizeSideEffects(out.historyRequests),
      frames: summarizeFrames(out.frames).map(NORMALIZE_FRAME),
    };
  }
} finally {
  await history.close();
}

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
const compact = {};
for (const k of Object.keys(result.cases)) {
  compact[k] = { sideEffects: result.cases[k].sideEffects.map((s) => s.kind), updates: result.cases[k].updateSequence.length };
}
console.log(JSON.stringify(compact));
