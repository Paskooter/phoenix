// H-04: skill launch, update, redirect and session handoff over the REAL gateway
// WebSocket, compared against the pinned original handler run under the archived
// Node 8.9.4 runtime (docs/parity/evidence/2026-09-10/h04-skill-handoff/).
//
// Reference citations are file:line into Pegasus
// 5c0a7390539663ba749d360de348a428c088505c, packages/hub/src/.
//
// Everything here drives `createGateway` over a real `ws` socket with a real HTTP
// skill peer, so the requests the hub sends and the frames the robot receives are
// observed, not inferred.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../src/index.js';
import { jwt } from '@phoenix/common';

const SECRET = 'h04-skill-handoff-secret';
const token = () => jwt.sign({ id: 'account-h04', friendlyId: 'robot-h04' }, SECRET);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A controlled skill peer. `program` maps skillID -> queued answers. */
async function startPeer(program) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const entry = { body: JSON.parse(raw), headers: req.headers };
    requests.push(entry);
    const answer = (program[entry.body.data.skill.id] || []).shift();
    if (!answer) { res.statusCode = 500; return res.end(JSON.stringify({ message: 'unprogrammed' })); }
    if (answer.hang) return; // never respond
    const send = () => {
      res.statusCode = answer.status || 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer.body));
    };
    if (answer.delay) setTimeout(send, answer.delay); else send();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const close = async () => {
    // A deliberately hanging peer leaves its socket open; destroy it so the
    // server (and the gateway's own pending fetch) can shut down.
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return { server, requests, close, url: `http://127.0.0.1:${server.address().port}/v1/main` };
}

/**
 * Start a gateway, run one CLIENT_NLU turn, and resolve every frame up to the
 * terminal one (or `settleMs` after the first final frame).
 */
async function turn(peer, {
  skill = {}, intent = 'launch-intent', hotphrase = false, entities = { e: 'v' },
  timeoutMap, settleMs = 0,
} = {}) {
  const realSetTimeout = global.setTimeout;
  if (timeoutMap) global.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, timeoutMap[ms] || ms, ...rest);
  const frames = [];
  let gateway;
  try {
    gateway = await createGateway({
      skills: [
        { id: 'source', URL: peer.url, intents: [{ name: 'launch-intent' }] },
        { id: 'destination', URL: peer.url, intents: [] },
        { id: 'robot-skill', URL: '', onRobot: true, intents: [{ name: 'robot-intent' }] },
      ],
      parserURL: 'http://127.0.0.1:1', historyURL: 'http://127.0.0.1:1',
      disableAuth: false, hubTokenSecret: SECRET, recordLaunchHistory: false,
      recordSpeechHistory: false, asrProvider: 'none', accountUrl: '',
    });
    await gateway.service.listen(0);
    const port = gateway.service.server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:h04' },
    });
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });
    ws.send(msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_NLU', hotphrase, rules: ['launch'] }));
    ws.send(msg('CONTEXT', {
      general: { accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0' },
      runtime: { perception: { speaker: 'person-h04', peoplePresent: [] }, dialog: {}, loop: { users: [] } },
      skill,
    }));
    ws.send(msg('CLIENT_NLU', { intent, rules: ['launch'], entities, external: {} }));
    await Promise.race([
      new Promise((resolve) => { const poll = () => { if (frames.some((f) => f.final)) resolve(); else setTimeout(poll, 2); }; poll(); }),
      wait(8000),
    ]);
    if (settleMs) await wait(settleMs);
    return { frames, types: () => frames.map((f) => f.type), requests: peer.requests, gateway };
  } finally {
    if (gateway) {
      for (const client of gateway.wss.clients) client.terminate();
      gateway.wss.close();
      gateway.service.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.service.server.close(resolve));
    }
    if (timeoutMap) global.setTimeout = realSetTimeout;
  }
}

const action = (skillID, session, extra = {}) => ({ type: 'SKILL_ACTION', msgID: `peer-${session}`, ts: 1700000000000,
  data: { skill: { id: skillID, session: { id: session, nodeID: 1 } }, action: { type: 'JCP' }, ...extra } });
const redirect = (from, session, target, extra = {}) => ({ type: 'SKILL_REDIRECT', msgID: 'peer-redirect', ts: 1700000000000,
  data: { skill: { id: from, session: { id: session } }, skillID: target,
    nlu: { intent: 'redirect-intent', entities: { r: 1 } }, asr: { text: 'redirect asr' }, memo: { from }, ...extra } });

test('launch: full request shape, trace defaults, and the action forwarded verbatim', async () => {
  const peer = await startPeer({ source: [{ body: action('source', 'sess-launch', { fireAndForget: true, analytics: { kept: 1 } }) }] });
  try {
    const out = await turn(peer);
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);
    assert.deepEqual(out.frames.slice(0, 2).map((f) => f.timings.total), [-1, -1]);

    // LISTEN match is non-final for a cloud skill (GlobalMatchResponseData).
    const listen = out.frames[2];
    assert.deepEqual(listen.data.match, { skillID: 'source', launch: true, onRobot: false });
    assert.equal(listen.final, false);

    // Hub -> skill request (SkillRequestHelper.buildListenLaunchRequest).
    const req = out.requests[0];
    assert.equal(out.requests.length, 1);
    assert.equal(req.body.type, 'LISTEN_LAUNCH');
    assert.deepEqual(req.body.data.skill, { id: 'source' });
    assert.deepEqual(Object.keys(req.body.data.result).sort(), ['asr', 'memo', 'nlu']);
    assert.equal(req.body.data.result.memo, null);
    assert.equal(req.body.data.result.asr.text, '');
    assert.deepEqual(req.body.data.general, {
      accountID: 'account-h04', robotID: 'robot-h04', lang: 'en', release: '1.8.0', remoteAddress: '::ffff:127.0.0.1',
    });
    // JiboHeaders defaults ride every skill call.
    assert.deepEqual({
      transId: req.headers['x-jibo-transid'], robotId: req.headers['x-jibo-robotid'], loggingConfig: req.headers['x-jibo-logging-config'],
    }, { transId: 'tid:h04', robotId: 'unknown', loggingConfig: '{}' });

    // Skill response is forwarded verbatim with final/timings overwritten.
    const response = out.frames[3];
    assert.equal(response.final, true);
    assert.equal(response.data.action.type, 'JCP');
    assert.equal(response.data.fireAndForget, true);
    assert.deepEqual(response.data.analytics, { kept: 1 });
    assert.deepEqual(response.data.skill.session, { id: 'sess-launch', nodeID: 1 });
    assert.deepEqual(Object.keys(response.timings).sort(), ['skill', 'total']);
  } finally {
    await peer.close();
  }
});

test('continued session: LISTEN_UPDATE preserves the opaque session and drops the memo', async () => {
  const peer = await startPeer({ source: [{ body: action('source', 'sess-continued') }] });
  try {
    const out = await turn(peer, {
      intent: 'followup-intent', hotphrase: false,
      skill: { id: 'source', session: { id: 'existing-session', opaque: { keep: true } } },
    });
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);
    assert.deepEqual(out.frames[2].data.match, { skillID: 'source', launch: false, onRobot: false });

    const req = out.requests[0];
    assert.equal(out.requests.length, 1);
    assert.equal(req.body.type, 'LISTEN_UPDATE');
    // Session round-trips untouched; LISTEN_UPDATE carries nlu+asr only (no memo).
    assert.deepEqual(req.body.data.skill, { id: 'source', session: { id: 'existing-session', opaque: { keep: true } } });
    assert.deepEqual(Object.keys(req.body.data.result).sort(), ['asr', 'nlu']);
    assert.equal(req.body.data.result.nlu.intent, 'followup-intent');
  } finally {
    await peer.close();
  }
});

test('redirect: rewritten match, redirect nlu/memo without asr, and only the redirect leg in timings.skill', async () => {
  // Each leg takes ~80 ms. The source overwrites timings.skill with the redirect
  // leg (ListenTransactionHandler.ts:404-410), so a redirected turn must report
  // roughly one leg while totalTime covers both.
  const peer = await startPeer({
    source: [{ delay: 80, body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ delay: 80, body: action('destination', 'sess-dest') }],
  });
  try {
    const out = await turn(peer);
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_REDIRECT', 'SKILL_ACTION']);
    assert.equal(out.requests.length, 2);

    // The redirect notification rewrites match to the target with launch:true.
    const notification = out.frames[3];
    assert.equal(notification.final, false);
    assert.deepEqual(notification.data.match, { skillID: 'destination', launch: true, onRobot: false });
    assert.deepEqual(notification.data.nlu, { intent: 'redirect-intent', entities: { r: 1 } });
    assert.deepEqual(notification.data.memo, { from: 'source' });

    // The redirected launch is a fresh LISTEN_LAUNCH with the redirect's own
    // nlu/memo and no asr (TransactionHandler's redirect omits ASR).
    const redirected = out.requests[1];
    assert.equal(redirected.body.type, 'LISTEN_LAUNCH');
    assert.deepEqual(redirected.body.data.skill, { id: 'destination' });
    assert.deepEqual(Object.keys(redirected.body.data.result).sort(), ['memo', 'nlu']);
    assert.deepEqual(redirected.body.data.result.nlu, { intent: 'redirect-intent', entities: { r: 1 } });
    assert.deepEqual(redirected.body.data.result.memo, { from: 'source' });

    const response = out.frames[4];
    assert.equal(response.final, true);
    assert.deepEqual(response.data.skill, { id: 'destination', session: { id: 'sess-dest', nodeID: 1 } });
    assert.ok(response.timings.skill < response.timings.total - 40,
      `timings.skill ${response.timings.skill} must be the redirect leg, not both legs (total ${response.timings.total})`);
  } finally {
    await peer.close();
  }
});

test('redirect to an on-robot skill: final SKILL_REDIRECT ends the response, later ERROR is dropped', async () => {
  const peer = await startPeer({ source: [{ body: redirect('source', 'sess-source', 'robot-skill') }] });
  try {
    const out = await turn(peer, { settleMs: 300 });
    // The notification is final because the target is an on-robot skill, so the
    // failed launch's ERROR is refused by ResponseWrapper (Write-after-final).
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_REDIRECT']);
    assert.equal(out.frames[3].final, true);
    assert.deepEqual(out.frames[3].data.match, { skillID: 'robot-skill', launch: true, onRobot: true });
    // Only the source was ever contacted; the on-robot target has no URL.
    assert.deepEqual(out.requests.map((r) => r.body.data.skill.id), ['source']);
  } finally {
    await peer.close();
  }
});

test('too many redirects: ERROR carries the plain message and no code', async () => {
  const peer = await startPeer({
    source: [{ body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ body: redirect('destination', 'sess-dest', 'source') }],
  });
  try {
    const out = await turn(peer);
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_REDIRECT', 'ERROR']);
    const terminal = out.frames[4];
    assert.equal(terminal.final, true);
    assert.deepEqual(terminal.data, { message: 'Too many redirects' });
    assert.deepEqual(out.requests.map((r) => r.body.type), ['LISTEN_LAUNCH', 'LISTEN_LAUNCH']);
  } finally {
    await peer.close();
  }
});

test('skill failure: the ERROR message reproduces the source Error-from-URL envelope', async () => {
  const peer = await startPeer({ source: [{ status: 500, body: { error: 'boom' } }] });
  try {
    const out = await turn(peer);
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'ERROR']);
    const terminal = out.frames[3];
    assert.equal(terminal.final, true);
    // SkillRequestMaker.ts:119-123 builds
    // `Error from URL '<url>': <status> <axios message> :: <JSON body>`.
    assert.deepEqual(terminal.data, {
      message: `Error from URL '${peer.url}': 500 Request failed with status code 500 :: {"error":"boom"}`,
    });
    assert.equal('code' in terminal.data, false, 'a skill failure is emitted via emitSkillResult with no code');
  } finally {
    await peer.close();
  }
});

test('redirect timeout: TIMEOUT_SKILL names the ORIGINAL skill, matching the source throw site', async () => {
  const peer = await startPeer({
    source: [{ body: redirect('source', 'sess-source', 'destination') }],
    destination: [{ hang: true }],
  });
  try {
    // The source's 10 s skill budget is mapped to 200 ms so the terminal path can
    // be observed without waiting; the message text is what is under test.
    const out = await turn(peer, { timeoutMap: { 10000: 200 } });
    assert.deepEqual(out.types(), ['SOS', 'EOS', 'LISTEN', 'SKILL_REDIRECT', 'ERROR']);
    const terminal = out.frames[4];
    assert.equal(terminal.final, true);
    // ListenTransactionHandler.ts:406-407 throws while `skillOutput` still refers
    // to the FIRST response, so the message names 'source', not 'destination'.
    assert.deepEqual(terminal.data, {
      code: 'TIMEOUT_SKILL',
      message: "Timeout of 10000 while waiting for the redirect skill response from 'source'",
    });
  } finally {
    await peer.close();
  }
});
