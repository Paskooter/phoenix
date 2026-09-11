// N-06 — the speaker/referent interaction across the NLU → hub → skill boundary.
//
// Pinned reference: jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c
//
// Where "speaker" meets "referent" in the source (this is the whole claim):
//
//   1. The robot's CONTEXT message carries ONE RuntimeContext holding BOTH
//      identities, and they are distinct fields:
//        perception.speaker  "ID of the currently active speaker"
//                            (packages/interfaces/src/jibo/runtime.ts:132-137)
//        dialog.referent     "ID of a loop member that was referred to in
//                             utterance"
//                            (packages/interfaces/src/jibo/runtime.ts:139-143)
//
//   2. The referent is NOT computed in the hub. It is copied verbatim from the
//      NLU entity the LoopMemberDetector writes:
//        const referent = input.nlu.entities.loopMemberReferent
//                            (packages/hub/src/skill/SkillRequestHelper.ts:95)
//        input.context.runtime.dialog.referent = resolvedReferent
//                            (packages/hub/src/skill/SkillRequestHelper.ts:99)
//      and the detector resolves it from request.loop.users + the NLU
//      entities/text only — it has no speaker input, and bails on
//      !request.loop.users / !result / !result.intent:
//        (packages/parser/src/utils/LoopMemberDetector.ts:49-93)
//
//   3. The speaker is read independently, ONLY to build history personIDs:
//        return context.perception && context.perception.speaker
//          ? [ context.perception.speaker ] : ["UNKNOWN"]
//                            (packages/hub/src/utils/TransactionHelper.ts:13-16)
//      Phoenix mirrors this at packages/gateway/src/listenTransaction.js:466.
//
//   4. The hub builds the parser request's loop.users from that SAME context:
//        users: this.getLoopUsersInfo(context)
//                            (packages/hub/src/listen/ListenTransactionHandler.ts:311-312)
//      Phoenix mirrors this at packages/gateway/src/listenTransaction.js:386,604-608.
//
// Observable interaction: a turn whose SPEAKER is one loop member and whose
// utterance NAMES a different one must put the NAMED member into
// runtime.dialog.referent while runtime.perception.speaker is left untouched.
//
// This test drives the REAL CLIENT_ASR listen path over a real gateway WebSocket,
// the REAL parser (the packages/nlu HTTP service, which runs LoopMemberDetector),
// and the REAL skill request builder (SkillRequestHelper.injectDialogContext),
// then asserts on the request the cloud skill actually receives.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createGateway } from '../src/index.js';
import { start as startNlu } from '../../nlu/src/index.js';
import { jwt } from '@phoenix/common';

const GEORGE = { id: 'u-george', firstName: 'George', lastName: 'Jetson' };
const JANE = { id: 'u-jane', firstName: 'Jane', lastName: 'Jetson' };
const SECRET = 'n06-speaker-referent-secret';
const ACCOUNT = 'acct-n06';
const ROBOT = 'robot-n06';
const token = () => jwt.sign({ id: ACCOUNT, friendlyId: ROBOT }, SECRET);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A controlled cloud-skill peer: records every request, answers with an action. */
async function startPeer() {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      type: 'SKILL_ACTION', msgID: 'peer-action', ts: 1700000000000,
      data: { skill: { id: body.data.skill.id, session: { id: 'sess-n06', nodeID: 1 } }, action: { type: 'JCP' } },
    }));
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/v1/main`,
    close: async () => { for (const s of sockets) s.destroy(); await new Promise((r) => server.close(r)); },
  };
}

/**
 * Run one CLIENT_ASR listen turn: the robot supplies the ASR text, the hub runs
 * the parser (with loop.users from CONTEXT) and routes to the matched skill.
 */
async function turn(peer, { nluUrl, speaker, loopUsers, text, rules = ['launch'] }) {
  const gateway = await createGateway({
    skills: [{ id: 'source', URL: peer.url, intents: [{ name: 'whoIsPerson' }] }],
    parserURL: nluUrl, historyURL: 'http://127.0.0.1:1', settingsURL: 'http://127.0.0.1:1',
    disableAuth: false, hubTokenSecret: SECRET, recordLaunchHistory: false, recordSpeechHistory: false,
    asrProvider: 'none', accountUrl: '',
  });
  try {
    await gateway.service.listen(0);
    const port = gateway.service.server.address().port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/listen`, {
      headers: { authorization: `Bearer ${token()}`, 'x-jibo-transid': 'tid:n06' },
    });
    const frames = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    await once(ws, 'open');
    const msg = (type, data) => JSON.stringify({ type, msgID: `m-${type}`, ts: 1700000000000, data });
    ws.send(msg('LISTEN', { lang: 'en-US', mode: 'CLIENT_ASR', hotphrase: false, rules }));
    ws.send(msg('CONTEXT', {
      general: { accountID: 'acct-n06', robotID: 'robot-n06', lang: 'en', release: '1.8.0' },
      runtime: { perception: { speaker, peoplePresent: [] }, dialog: {}, loop: { users: loopUsers } },
      skill: { id: null },
    }));
    ws.send(msg('CLIENT_ASR', { text }));
    await Promise.race([
      new Promise((resolve) => {
        const poll = () => {
          // Wait for the cloud-skill request AND the terminal frame it produces.
          if (peer.requests.length && frames.some((f) => f.final)) resolve();
          else setTimeout(poll, 2);
        };
        poll();
      }),
      wait(8000),
    ]);
    return { frames };
  } finally {
    if (gateway) {
      for (const client of gateway.wss.clients) client.terminate();
      gateway.wss.close();
      gateway.service.server.closeAllConnections?.();
      await new Promise((resolve) => gateway.service.server.close(resolve));
    }
  }
}

test('N-06 speaker/referent: the speaker (perception) and the referred member (dialog) are independent in one turn', async (t) => {
  // The parser runs the real LoopMemberDetector; force the AST default so the
  // fixture intent/entities match the pinned parser profile.
  const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;
  delete process.env.PHOENIX_NLU_RUNTIME;
  const nlu = await startNlu(0);
  const nluUrl = `http://127.0.0.1:${nlu.address().port}`;
  const peer = await startPeer();
  try {
    // George is the speaker; the utterance names Jane (and Jane is NOT first in
    // loop.users, so array order alone would pick George).
    const { frames } = await turn(peer, {
      nluUrl, speaker: GEORGE.id, loopUsers: [GEORGE, JANE], text: 'who is jane jetson',
    });

    assert.equal(peer.requests.length, 1, 'one cloud-skill request');
    const req = peer.requests[0];
    assert.equal(req.type, 'LISTEN_LAUNCH');
    assert.equal(req.data.skill.id, 'source');

    // The NLU result the hub got back carries the detector's referent entity.
    assert.equal(req.data.result.nlu.entities.loopMemberReferent, JANE.id,
      'LoopMemberDetector resolved the member NAMED in the utterance');
    assert.equal(req.data.result.nlu.entities['given-name'], 'Jane');
    assert.equal(req.data.result.nlu.entities['last-name'], 'Jetson');

    // The referent reaches the skill as runtime.dialog.referent …
    assert.equal(req.data.runtime.dialog.referent, JANE.id,
      'SkillRequestHelper.injectDialogContext copied the referent entity');
    // … while the speaker field is passed through untouched.
    assert.equal(req.data.runtime.perception.speaker, GEORGE.id,
      'the speaker identity is untouched by referent resolution');
    // The two identities coexist and differ.
    assert.notEqual(req.data.runtime.dialog.referent, req.data.runtime.perception.speaker);

    // The robot observed a routed skill action, not an error.
    assert.ok(frames.some((f) => f.type === 'SKILL_ACTION'), 'skill action forwarded');
  } finally {
    await peer.close();
    await new Promise((resolve, reject) => nlu.close((error) => (error ? reject(error) : resolve())));
    if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
  }
});

test('N-06 speaker/referent: an unmatched name writes no referent, so dialog.referent stays empty', async () => {
  const selectedRuntime = process.env.PHOENIX_NLU_RUNTIME;
  delete process.env.PHOENIX_NLU_RUNTIME;
  const nlu = await startNlu(0);
  const nluUrl = `http://127.0.0.1:${nlu.address().port}`;
  const peer = await startPeer();
  try {
    // "jane" is NOT in this loop: the parser still extracts a given-name entity,
    // but LoopMemberDetector finds no member (step 2 fails, no text fall-through),
    // so no loopMemberReferent is written and injectDialogContext leaves
    // dialog.referent exactly as the CONTEXT sent it (empty object).
    await turn(peer, {
      nluUrl, speaker: GEORGE.id, loopUsers: [GEORGE], text: 'who is jane jetson',
    });
    assert.equal(peer.requests.length, 1, 'the whoIsPerson intent still routes to the skill');
    const req = peer.requests[0];
    assert.equal(req.data.result.nlu.entities.loopMemberReferent, undefined,
      'no referent entity when the named person is not a loop member');
    assert.deepEqual(req.data.runtime.dialog, {},
      'dialog context is untouched when there is no referent');
    assert.equal(req.data.runtime.perception.speaker, GEORGE.id);
  } finally {
    await peer.close();
    await new Promise((resolve, reject) => nlu.close((error) => (error ? reject(error) : resolve())));
    if (selectedRuntime !== undefined) process.env.PHOENIX_NLU_RUNTIME = selectedRuntime;
  }
});
