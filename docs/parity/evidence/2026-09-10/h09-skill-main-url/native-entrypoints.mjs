// H-09 runtime: start every independently deployed skill process exactly the way the
// native/compose entrypoint configurations do (same command, same PHOENIX_SKILL_ID
// environment, one process per skill) and record the /v1/main response identity.
//
// The reference ports (9003/9004/9008/9009/9013/9014) are shifted to an isolated
// 19xxx block so this control can run beside another stack; the command and
// environment are byte-identical to docker-compose.yml and
// scripts/run-compose-stack.sh.
//
// Usage: node native-entrypoints.mjs <outPath>

import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..', '..');
const outPath = process.argv[2];

const PORT_BASE = 19000; // isolated from a live reference-port stack
const SKILLS = ['answer-skill', 'report-skill', 'chitchat-skill', 'color-skill', 'example-skill', 'template-skill'];
const REFERENCE_PORT = {
  'report-skill': 9003, 'chitchat-skill': 9004, 'color-skill': 9008,
  'answer-skill': 9009, 'example-skill': 9013, 'template-skill': 9014,
};

const baseRuntime = {
  dialog: {}, perception: {}, loop: { users: [] },
  location: { lat: 42.36, lng: -71.06, iso: '2026-06-12T10:00:00-04:00' },
};
const BODIES = {
  'answer-skill': { runtime: { dialog: {} }, result: { asr: { text: 'who is ada lovelace' }, nlu: { intent: 'generalWhoQuestions', rules: ['launch'], entities: {} }, memo: { type: 'who' } } },
  'report-skill': { runtime: baseRuntime, result: { nlu: { intent: 'launchPersonalReport', entities: {}, rules: [] }, asr: { text: '' }, memo: 'Reactive' } },
  'chitchat-skill': { runtime: { ...baseRuntime, character: { emotion: { name: 'NEUTRAL', valence: 0, confidence: 0 } } }, result: { nlu: { intent: 'requestDance', entities: {}, rules: [] }, asr: { text: '' }, memo: { mim: 'RA_JBO_SpecificDance', type: 'ScriptedResponse' } } },
  'color-skill': { runtime: baseRuntime, result: { nlu: { intent: 'favoriteColorChat', entities: {}, rules: [] }, asr: { text: 'my favorite color is blue' }, memo: 'Reactive' } },
  'example-skill': { runtime: baseRuntime, result: { nlu: { intent: 'doesJiboLikeThing', entities: {}, rules: [] }, asr: { text: '' }, memo: null } },
  'template-skill': { runtime: baseRuntime, result: { nlu: { intent: 'x', entities: {}, rules: [] }, asr: { text: '' }, memo: { entry: 'SomeThing' } } },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The reference ports are host ports; this control shares a host with other stacks, so take a
// genuinely free ephemeral port per process and report the mapping to the reference port.
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitReady(port) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthcheck`)).ok) return true; } catch { /* not up */ }
    await sleep(100);
  }
  return false;
}

const out = { portBase: PORT_BASE, command: 'node packages/skills/src/index.js', rows: [] };
for (const skillId of SKILLS) {
  const port = await freePort();
  // Same command + environment contract as docker-compose.yml / run-compose-stack.sh.
  const env = { ...process.env, PORT: String(port), ETCO_server_port: String(port), PHOENIX_SKILL_ID: skillId };
  const child = spawn('node', ['packages/skills/src/index.js'], { cwd: REPO, env, stdio: 'ignore' });
  const ready = await waitReady(port);
  const body = { type: 'LISTEN_LAUNCH', msgID: skillId, ts: Date.now(), data: { general: { accountID: 'a', robotID: 'r', lang: 'en-US' }, skill: { id: skillId }, ...BODIES[skillId] } };
  let main = null;
  let alias = null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/main`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    main = { status: r.status, type: j.type, skill: j.data && j.data.skill && j.data.skill.id };
  } catch (e) { main = { error: e.message }; }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/${skillId}/main`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    alias = { status: r.status, type: j.type, skill: j.data && j.data.skill && j.data.skill.id };
  } catch (e) { alias = { error: e.message }; }
  out.rows.push({ skillId, referencePort: REFERENCE_PORT[skillId], probePort: port, healthcheck: ready, main, alias });
  child.kill('SIGKILL');
  await sleep(150);
}

writeFileSync(outPath, JSON.stringify(out, null, 2));
const bad = out.rows.filter((row) => !row.healthcheck || row.main?.skill !== row.skillId || row.alias?.skill !== row.skillId);
console.log(JSON.stringify(out, null, 2));
console.log(bad.length ? `NATIVE ENTRYPOINTS: ${bad.length} MISMATCH(ES)` : 'NATIVE ENTRYPOINTS: ALL PASS');
process.exit(bad.length ? 1 : 0);
