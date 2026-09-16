// R-01 hub supervisor: makes an out-of-process Phoenix hub reconfigurable per test.
//
// Why this exists. The original suite constructs a fresh hub in every
// describe's beforeEach and hands it that file's own skill registry. A
// substituted hub is a separate process configured once at startup and cannot
// follow that, so the substitution lane could only run the files that share
// TEST_SKILL_CONFIG. Running the others against a hub configured from a
// different registry would compare two DIFFERENTLY CONFIGURED hubs, which is
// not a substitution result.
//
// This supervisor closes that gap without touching Phoenix. It owns the
// gateway process and exposes one control route; `integration.startHub` posts
// the registry the test was about to build, the supervisor writes it and
// restarts the gateway on the same port, and the test proceeds. The hub under
// test is the unmodified `packages/gateway/src/index.js`; only who starts it
// and with which registry changes.
//
// Deliberately NOT a hot-reload endpoint inside the gateway: adding a
// reconfiguration API to the production hub for the benefit of its own parity
// test would change the thing being measured.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const REPO = process.env.R01_PHOENIX_DIR || '/phoenix';
const REGISTRY_DIR = join(REPO, 'packages/gateway/resources/skills');
const INDEX_FILE = process.env.ETCO_hub_skillsConfig || 'skills-r01.json';
const CONTROL_PORT = Number(process.env.R01_CONTROL_PORT) || 8097;
const HUB_PORT = Number(process.env.PORT) || 8098;
const SKILL_PORT = process.env.R01_SKILL_PORT || '8080';
// A gateway that never reports `listening` is a gateway that is not under test.
// Bound the wait rather than hanging the suite on it.
const READY_TIMEOUT_MS = Number(process.env.R01_READY_TIMEOUT_MS) || 30000;

let child = null;
/** Manifest files this supervisor wrote, so a reconfigure replaces rather than accumulates. */
let written = [];

function log(...args) { console.log('[r01-supervisor]', ...args); }

/**
 * Write `skills` in the registry shape the gateway loads, exactly as
 * r01-emit-phoenix-skills.js does for the shared config: Phoenix composes
 * baseURL + basePath + /v1/main, so each manifest drops the full URL and the
 * index entry carries the origin.
 */
function writeRegistry(skills) {
  mkdirSync(REGISTRY_DIR, { recursive: true });
  for (const file of written) rmSync(join(REGISTRY_DIR, file), { force: true });
  written = [];

  const index = { skills: [] };
  for (const skill of skills) {
    const manifest = { ...skill };
    delete manifest.URL;
    const file = `${skill.id}_manifest.json`;
    writeFileSync(join(REGISTRY_DIR, file), JSON.stringify(manifest, null, 2));
    written.push(file);
    index.skills.push({ baseURL: `http://127.0.0.1:${SKILL_PORT}`, configPath: file });
  }
  writeFileSync(join(REGISTRY_DIR, INDEX_FILE), JSON.stringify(index, null, 2));
  return index.skills.length;
}

function stopChild() {
  if (!child) return Promise.resolve();
  const dying = child;
  child = null;
  return new Promise((resolve) => {
    // The gateway holds listening sockets; give it SIGTERM and escalate rather
    // than racing the next start for the port.
    const kill = setTimeout(() => { try { dying.kill('SIGKILL'); } catch { /* already gone */ } }, 5000);
    dying.once('exit', () => { clearTimeout(kill); resolve(); });
    try { dying.kill('SIGTERM'); } catch { clearTimeout(kill); resolve(); }
  });
}

function startChild() {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['packages/gateway/src/index.js'], {
      cwd: REPO,
      env: { ...process.env, PORT: String(HUB_PORT), ETCO_hub_skillsConfig: INDEX_FILE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;

    let settled = false;
    // `listening` is the same line run.sh's require_listening guard greps for,
    // so the in-container and out-of-container readiness checks agree.
    const onData = (buffer) => {
      const text = buffer.toString();
      process.stdout.write(text);
      if (!settled && text.includes('listening')) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`gateway did not report 'listening' within ${READY_TIMEOUT_MS}ms`));
    }, READY_TIMEOUT_MS);

    proc.once('exit', (code, signal) => {
      if (proc === child) child = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`gateway exited before listening (code=${code} signal=${signal})`));
      }
    });
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const control = createServer(async (req, res) => {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, running: Boolean(child), hubPort: HUB_PORT });
    }
    if (req.method === 'POST' && req.url === '/reconfigure') {
      const body = await readBody(req);
      if (!Array.isArray(body.skills)) return send(400, { error: 'skills must be an array' });
      const count = writeRegistry(body.skills);
      await stopChild();
      await startChild();
      log(`reconfigured with ${count} skill(s) and restarted on ${HUB_PORT}`);
      return send(200, { ok: true, skills: count, hubPort: HUB_PORT });
    }
    return send(404, { error: 'not found' });
  } catch (err) {
    log('control error:', err.message);
    return send(500, { error: err.message });
  }
});

control.listen(CONTROL_PORT, '0.0.0.0', () => {
  log(`control listening on ${CONTROL_PORT}; hub port ${HUB_PORT}; registry ${INDEX_FILE}`);
});

// Start once from whatever registry setup already generated, so the lanes that
// never reconfigure behave exactly as they did before this supervisor existed.
startChild()
  .then(() => log('initial gateway started'))
  .catch((err) => { log('initial gateway failed:', err.message); process.exit(1); });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { stopChild().then(() => process.exit(0)); });
}
