#!/usr/bin/env node
// Verifies a running compose(-equivalent) stack honors the reference port/wire contract:
//   1. every service answers /healthcheck on its reference host port
//   2. the hub lists skills at GET /v1/skills
//   3. a full WS turn through hub:9000 (LISTEN/CONTEXT/CLIENT_NLU launchPersonalReport)
//      routes to report-skill on :9003 and forwards its SKILL_ACTION
//   4. a direct POST to report-skill:9003 /v1/report-skill/main answers SKILL_ACTION
// Run after: bash scripts/run-compose-stack.sh   (or docker compose up)

import WebSocket from 'ws';

const HOST = process.env.HOST || 'localhost';
const PORTS = { hub: 9000, 'report-skill': 9003, 'chitchat-skill': 9004, parser: 9005, history: 9006, lasso: 9007, 'answer-skill': 9009 };

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS', name);
  else { failures++; console.log('FAIL', name, detail != null ? `:: ${JSON.stringify(detail).slice(0, 200)}` : ''); }
};

// 1. healthchecks
for (const [name, port] of Object.entries(PORTS)) {
  try {
    const r = await fetch(`http://${HOST}:${port}/healthcheck`);
    check(`healthcheck ${name}:${port}`, r.ok);
  } catch (e) {
    check(`healthcheck ${name}:${port}`, false, e.message);
  }
}

// 2. hub skill list
try {
  const r = await fetch(`http://${HOST}:${PORTS.hub}/v1/skills`);
  const skills = await r.json();
  const list = Array.isArray(skills) ? skills : skills.skills || [];
  check('hub GET /v1/skills lists report-skill', list.some((s) => (s.id || s) === 'report-skill'), list.slice(0, 3));
} catch (e) {
  check('hub GET /v1/skills', false, e.message);
}

// 3. WS turn through the hub -> report-skill on :9003
const frames = await new Promise((resolve) => {
  const out = [];
  const ws = new WebSocket(`ws://${HOST}:${PORTS.hub}/listen`, { headers: { 'X-JIBO-transID': 'tid:compose-verify' } });
  const done = () => { clearTimeout(t); try { ws.close(); } catch { /* */ } resolve(out); };
  const t = setTimeout(done, 15000);
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'LISTEN', msgID: 'l', ts: Date.now(), data: { lang: 'en-US', hotphrase: false, rules: ['launch'], mode: 'CLIENT_NLU' } }));
    ws.send(JSON.stringify({ type: 'CONTEXT', msgID: 'c', ts: Date.now(), data: { general: { release: '1.9.0' }, runtime: { loop: { users: [] }, dialog: {}, perception: {} }, skill: null } }));
    ws.send(JSON.stringify({ type: 'CLIENT_NLU', msgID: 'n', ts: Date.now(), data: { rules: ['launch'], intent: 'launchPersonalReport', entities: {} } }));
  });
  ws.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw));
      out.push(m);
      if (m.final) done();
    } catch { /* binary */ }
  });
  ws.on('error', (e) => { out.push({ type: 'WS_ERROR', error: e.message }); done(); });
});
const listen = frames.find((f) => f.type === 'LISTEN');
const action = frames.find((f) => f.type === 'SKILL_ACTION');
check('hub WS turn: LISTEN match -> report-skill', listen && listen.data.match && listen.data.match.skillID === 'report-skill', listen && listen.data);
check('hub WS turn: report-skill SKILL_ACTION forwarded', !!action && action.data.skill.id === 'report-skill', frames.map((f) => f.type));

// 4. direct skill POST on the reference port
try {
  const r = await fetch(`http://${HOST}:${PORTS['report-skill']}/v1/report-skill/main`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'LISTEN_LAUNCH', msgID: 'm', ts: Date.now(),
      data: {
        general: { accountID: 'a', robotID: 'r', lang: 'en-US' },
        runtime: { dialog: {}, perception: {}, loop: { users: [] }, location: { lat: 42.36, lng: -71.06, iso: new Date().toISOString() } },
        skill: { id: 'report-skill' },
        result: { nlu: { intent: 'requestWeatherPR', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive Weather' },
      },
    }),
  });
  const j = await r.json();
  check('report-skill direct POST /v1/report-skill/main', j.type === 'SKILL_ACTION', j.type);
} catch (e) {
  check('report-skill direct POST', false, e.message);
}

console.log(failures ? `CONTRACT VERIFY: ${failures} FAILURE(S)` : 'CONTRACT VERIFY: ALL PASS');
process.exit(failures ? 1 : 0);
