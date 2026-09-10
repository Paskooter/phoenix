// H-04 Phoenix control: drives the REAL Phoenix gateway over a real WebSocket for
// the same skill launch / update / redirect / handoff cases the pinned original
// was measured on (docs/parity/evidence/2026-09-10/h04-skill-handoff/source-skill-handoff.cjs),
// so the two normalized JSON receipts can be diffed cell by cell.
//
// Usage: node phoenix-skill-handoff.mjs <outPath>

import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../../../../../packages/gateway/src/index.js';
import { jwt } from '../../../../../packages/common/src/index.js';

const outPath = process.argv[2];

const SECRET = 'h04-skill-handoff-secret';
const token = () => jwt.sign({ id: 'account-h04', friendlyId: 'robot-h04' }, SECRET);
const clone = (v) => JSON.parse(JSON.stringify(v));

function startPeer(program) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/v1/main` }));
  });
}

const SKILLS = (url) => ([
  { id: 'source', URL: url, intents: [{ name: 'launch-intent' }] },
  { id: 'destination', URL: url, intents: [] },
  { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'robot-intent' }] },
]);

async function runTurn(url, { skill, intent = 'launch-intent', hotphrase = false, entities = { e: 'v' }, timeoutMap, collectUntilFinal = true } = {}) {
  const realSetTimeout = global.setTimeout;
  if (timeoutMap) global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, timeoutMap[ms] || ms, ...a);
  let gw;
  try {
    gw = await createGateway({
      skills: SKILLS(url), parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
      disableAuth: false, hubTokenSecret: SECRET, recordLaunchHistory: false,
      recordSpeechHistory: false, asrProvider: 'none', accountUrl: '',
    });
    await gw.service.listen(0);
    const port = gw.service.server.address().port;
    const frames = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:h04-source' },
    });
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });
    ws.send(msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase, rules: ['launch'] }));
    ws.send(msg('CONTEXT', {
      general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' },
      runtime: { perception: { speaker: 'person-h04', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
      skill: skill || {},
    }));
    ws.send(msg('CLIENT_NLU', { intent, rules: ['launch'], entities, external: {} }));
    await Promise.race([
      new Promise((resolve) => { const p = () => { if (!collectUntilFinal || frames.some((f) => f.final)) resolve(); else setTimeout(p, 2); }; p(); }),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    ws.terminate();
    return { frames };
  } finally {
    if (timeoutMap) global.setTimeout = realSetTimeout;
    if (gw) { for (const s of gw.wss.clients) s.terminate(); gw.wss.close(); await new Promise((r) => gw.service.server.close(r)); }
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
const summarizeFrames = (frames) => frames.map((f) => ({ type: f.type, final: f.final, timings: f.timings, data: f.data }));

const result = { runtime: process.version, sourceRevision: '5c0a7390539663ba749d360de348a428c088505c', cases: {} };

async function scenario(program, runOptions) {
  const peer = await startPeer(program);
  const turn = await runTurn(peer.url, runOptions);
  return { peer, turn };
}

// S1 launch
{
  const { peer, turn } = await scenario({ source: [{ body: action('source', 'sess-launch', { fireAndForget: true, analytics: { kept: 1 } }) }] }, {});
  result.cases.launch = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S2 redirect
{
  const { peer, turn } = await scenario({
    source: [{ delay: 60, body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ delay: 60, body: action('destination', 'sess-dest') }],
  }, {});
  result.cases.redirect = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S3 continued session
{
  const { peer, turn } = await scenario({ source: [{ body: action('source', 'sess-continued') }] },
    { intent: 'followup-intent', hotphrase: false, skill: { id: 'source', session: { id: 'existing', opaque: true } } });
  result.cases.update = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S4 too many redirects
{
  const { peer, turn } = await scenario({
    source: [{ body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ body: redirect('destination', 'sess-dest', 'source') }],
  }, {});
  result.cases.tooMany = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S5 redirect timeout
{
  const { peer, turn } = await scenario({
    source: [{ body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ hang: true }],
  }, { timeoutMap: { 10000: 200 } });
  result.cases.redirectTimeout = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S6 launch timeout
{
  const { peer, turn } = await scenario({ source: [{ hang: true }] }, { timeoutMap: { 10000: 200 } });
  result.cases.launchTimeout = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S5b/S6b timeout samples
{
  const samples = { launch: [], redirect: [] };
  for (let i = 0; i < 12; i += 1) {
    {
      const { peer, turn } = await scenario({ source: [{ hang: true }] }, { timeoutMap: { 10000: 200 } });
      samples.launch.push({ frame: (turn.frames.filter((f) => f.type === 'ERROR').pop() || {}).data || null });
      peer.server.close();
    }
    {
      const { peer, turn } = await scenario({
        source: [{ body: redirect('source', 'sess-source', 'destination') }],
        destination: [{ hang: true }],
      }, { timeoutMap: { 10000: 200 } });
      samples.redirect.push({ frame: (turn.frames.filter((f) => f.type === 'ERROR').pop() || {}).data || null });
      peer.server.close();
    }
  }
  result.cases.timeoutSamples = samples;
}
// S7 skill failure
{
  const { peer, turn } = await scenario({ source: [{ status: 500, body: { error: 'boom' } }] }, {});
  result.cases.skillFailure = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S8 on-robot match
{
  const { peer, turn } = await scenario({}, { intent: 'robot-intent', hotphrase: true, entities: {} });
  result.cases.onRobot = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S9 redirect to on-robot
{
  const { peer, turn } = await scenario({ source: [{ body: redirect('source', 'sess-source', 'robot-skill') }] }, {});
  result.cases.redirectToOnRobot = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}
// S10 redirect destination failure
{
  const { peer, turn } = await scenario({
    source: [{ body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ status: 500, body: { error: 'dest-boom' } }],
  }, {});
  result.cases.redirectDestinationFailure = { requests: peer.requests.map(summarizeRequest), frames: summarizeFrames(turn.frames) };
  peer.server.close();
}

fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(Object.fromEntries(Object.entries(result.cases).map(([k, v]) => [k, Array.isArray(v.frames) ? v.frames.map((f) => f.type + (f.final ? '*' : '')) : 'samples']))));
process.exit(0);
