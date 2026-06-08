// End-to-end robot-compatibility test: drive the gateway over a real WebSocket exactly as the
// robot's @jibo/hub-client does (Authorization: Bearer <HS256 JWT> + x-jibo-transid; text=JSON,
// LISTEN -> CLIENT_ASR/CLIENT_NLU -> CONTEXT), through the real nlu + skills services, and assert
// the response stream (SOS, EOS, LISTEN, SKILL_ACTION) and shapes match the reference protocol.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { jwt } from '@phoenix/common';
import { validate, schemas } from '@phoenix/contracts';

const SECRET = 'test-secret';
const PORTS = { nlu: 7511, skills: 7514, gateway: 7510 };

let nluSrv, skillsSrv, gw;

before(async () => {
  process.env.ETCO_server_hubTokenSecret = SECRET;
  process.env.NET_parser = `localhost:${PORTS.nlu}`;
  process.env.NET_skills = `localhost:${PORTS.skills}`;
  delete process.env.ETCO_hub_disableAuth;
  const { start: startNlu } = await import('@phoenix/nlu');
  const { start: startSkills } = await import('@phoenix/skills');
  const { start: startGateway } = await import('@phoenix/gateway');
  nluSrv = await startNlu(PORTS.nlu);
  skillsSrv = await startSkills(PORTS.skills);
  gw = await startGateway(PORTS.gateway);
});

after(async () => {
  gw?.wss?.close();
  gw?.service?.server?.close();
  nluSrv?.close?.();
  skillsSrv?.close?.();
});

function token() {
  return jwt.sign({ id: 'acct-1', friendlyId: 'My-Robot', accessKeyId: 'k', secretAccessKey: 's' }, SECRET);
}

const context = () => ({
  type: 'CONTEXT', msgID: 'c', ts: Date.now(),
  data: {
    general: { accountID: 'acct-1', robotID: 'My-Robot', lang: 'en-US', release: '2.0.1' },
    runtime: { loop: { users: [] }, dialog: {} },
    skill: { id: null },
  },
});

// Open a listen socket, send `outbound` once open, collect responses until final.
function runListen(outbound, { auth = token() } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORTS.gateway}/v1/listen`, {
      headers: { Authorization: `Bearer ${auth}`, 'x-jibo-transid': 'tid:e2e' },
    });
    const messages = [];
    ws.on('open', () => outbound.forEach((m) => ws.send(JSON.stringify(m))));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      messages.push(m);
      if (m.final) { ws.close(); resolve(messages); }
    });
    ws.on('error', reject);
  });
}

test('CLIENT_ASR: full pipeline robot -> gateway -> nlu -> answer-skill', async () => {
  const messages = await runListen([
    { type: 'LISTEN', msgID: '1', ts: Date.now(), data: { lang: 'en-US', hotphrase: true, rules: ['launch', 'global'], mode: 'CLIENT_ASR', asr: 'FAKE' } },
    context(),
    { type: 'CLIENT_ASR', msgID: '3', ts: Date.now(), data: { text: 'who is ada lovelace' } },
  ]);

  assert.deepEqual(messages.map((m) => m.type), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);

  const [sos, eos, listen, action] = messages;
  assert.equal(sos.timings.total, -1, 'fake SOS carries timings.total -1');
  assert.equal(eos.timings.total, -1, 'fake EOS carries timings.total -1');

  assert.equal(listen.final, false, 'cloud-skill match -> non-final LISTEN');
  assert.equal(listen.data.match.skillID, 'answer-skill');
  assert.equal(listen.data.match.onRobot, false);
  assert.equal(listen.data.nlu.intent, 'generalWhoQuestions');
  assert.equal(listen.data.asr.text, 'who is ada lovelace');

  assert.equal(action.final, true, 'SKILL_ACTION is final');
  assert.ok(validate(schemas.skillResponse, action).valid);
  assert.equal(action.data.action.config.jcp.type, 'SEQUENCE');
  assert.ok(action.data.skill.session.id, 'session round-trips');
});

test('CLIENT_NLU: skips ASR + parser, routes directly', async () => {
  const messages = await runListen([
    { type: 'LISTEN', msgID: '1', ts: Date.now(), data: { lang: 'en-US', rules: ['launch'], mode: 'CLIENT_NLU' } },
    context(),
    { type: 'CLIENT_NLU', msgID: '3', ts: Date.now(), data: { intent: 'generalWhoQuestions', rules: ['launch'], entities: { person: 'ada lovelace' } } },
  ]);
  assert.deepEqual(messages.map((m) => m.type), ['SOS', 'EOS', 'LISTEN', 'SKILL_ACTION']);
  assert.equal(messages[2].data.match.skillID, 'answer-skill');
});

test('no NLU match -> final LISTEN with match:null, no skill call', async () => {
  const messages = await runListen([
    { type: 'LISTEN', msgID: '1', ts: Date.now(), data: { lang: 'en-US', hotphrase: true, rules: ['launch'], mode: 'CLIENT_ASR', asr: 'FAKE' } },
    context(),
    { type: 'CLIENT_ASR', msgID: '3', ts: Date.now(), data: { text: 'blurf gnax' } },
  ]);
  assert.deepEqual(messages.map((m) => m.type), ['SOS', 'EOS', 'LISTEN']);
  const listen = messages[2];
  assert.equal(listen.final, true);
  assert.equal(listen.data.match, null);
  assert.equal(listen.data.nlu.intent, null);
});

test('bad JWT is rejected at the upgrade (HTTP 401, no socket)', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORTS.gateway}/v1/listen`, {
      headers: { Authorization: 'Bearer not-a-valid-token', 'x-jibo-transid': 'tid:bad' },
    });
    ws.on('open', () => { ws.close(); reject(new Error('should not have opened')); });
    ws.on('unexpected-response', (_req, res) => { assert.equal(res.statusCode, 401); resolve(); });
    ws.on('error', () => resolve()); // some stacks surface this as an error instead
  });
});
