// H-01 differential: boot the PINNED ORIGINAL Pegasus HubService and the PHOENIX
// gateway side by side with identical skill registries, and compare the four
// robot-specific skill-list URLs plus their generic/edge neighbours.
//
// Usage: node scripts/parity-h01/differential.mjs [REF] [OUT]
//   REF  prepared original checkout (default: .parity/reference/5c0a739...)
//   OUT  report path (default: .parity/runs/h01-differential/report.json)
// Exit 0 also when differences exist; read `differenceCount` (the no-ID aliases are
// expected differences — they are Phoenix deployment extensions, see index.js:94-96).
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createGateway } from '@phoenix/gateway';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
// .parity lives in the main checkout, not inside a linked worktree.
const commonDir = execSync('git rev-parse --path-format=absolute --git-common-dir', { cwd: root, encoding: 'utf8' }).trim();
const parityRoot = resolve(commonDir, '..', '.parity');
const REF = resolve(process.argv[2] || resolve(parityRoot, 'reference/5c0a7390539663ba749d360de348a428c088505c'));
const OUT = resolve(process.argv[3] || resolve(parityRoot, 'runs/h01-differential/report.json'));
mkdirSync(dirname(OUT), { recursive: true });
process.env.ETCO_server_logLevel = 'error';
process.env.ETCO_server_structuredLogs = 'true';
process.env.ETCO_server_name = 'h01-differential';
const Module = require('module');
const realLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === '@google-cloud/speech') return { SpeechClient: class { streamingRecognize() { throw new Error('asr disabled'); } } };
  if (name === 'grpc') return { credentials: { createInsecure: () => ({ fixture: true }) } };
  return realLoad.call(this, name, parent, isMain);
};
const utils = require(`${REF}/packages/utils`);
const hubCfg = require(`${REF}/packages/hub/lib/config`);
const HubService = require(`${REF}/packages/hub/lib/HubService`).HubService;

const ALL = await hubCfg.HubConfigProvider.getSkillConfigs('skills-local.json');
const WITH_SETTINGS = ALL.filter((s) => !!s.settings);
const WITHOUT_SETTINGS = ALL.filter((s) => !s.settings);

const FIXTURES = {
  'full-registry': ALL,
  'no-settings': WITHOUT_SETTINGS,
  'settings-only': WITH_SETTINGS,
  'empty-registry': [],
};

const URLS = [
  '/skills/robot-A', '/v1/skills/robot-A',
  '/skills/settings/robot-A', '/v1/skills/settings/robot-A',
  '/skills/unknown-robot', '/skills/settings/unknown-robot',
  '/skills', '/v1/skills', '/skills/settings', '/skills/', '/skills/settings/',
];

function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withOriginal(skills, run) {
  const hub = new HubService({ disableAuth: true, skills, parser: { baseURL: 'http://127.0.0.1:9' },
    history: { baseURL: 'http://127.0.0.1:9' }, settings: { baseURL: 'http://127.0.0.1:9' },
    hubSettings: { recordLaunchHistory: true } });
  await hub.init(0);
  const port = hub.server.address().port;
  try { return await run(port); } finally { await hub.close(); }
}

async function withPhoenix(skills, run) {
  const gw = await createGateway({ hubTokenSecret: '', disableAuth: true, accountUrl: '', parserURL: 'http://127.0.0.1:9', historyURL: 'http://127.0.0.1:9', settingsURL: 'http://127.0.0.1:9', skills });
  await gw.service.listen(0);
  const port = gw.service.server.address().port;
  try { return await run(port); } finally {
    await new Promise((r) => gw.wss.close(r));
    await new Promise((r, j) => gw.service.server.close((e) => (e ? j(e) : r())));
  }
}

const report = { ref: REF, fixtures: {}, differences: [] };
for (const [name, skills] of Object.entries(FIXTURES)) {
  const original = await withOriginal(skills, async (port) => { const o = {}; for (const u of URLS) o[u] = await get(port, u); return o; });
  const phoenix = await withPhoenix(skills, async (port) => { const o = {}; for (const u of URLS) o[u] = await get(port, u); return o; });
  report.fixtures[name] = { skills: skills.length, withSettings: skills.filter((s) => !!s.settings).length, original, phoenix };
  for (const u of URLS) {
    const a = original[u], b = phoenix[u];
    if (a.status !== b.status || a.body !== b.body || a.contentType !== b.contentType) {
      report.differences.push({ fixture: name, url: u, original: { status: a.status, len: a.body.length }, phoenix: { status: b.status, len: b.body.length } });
    }
  }
}
report.totalComparisons = Object.keys(FIXTURES).length * URLS.length;
report.differenceCount = report.differences.length;
writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`fixtures=${Object.keys(FIXTURES).length} urls=${URLS.length} comparisons=${report.totalComparisons} differences=${report.differenceCount}`);
for (const d of report.differences) console.log('DIFF', JSON.stringify(d));
