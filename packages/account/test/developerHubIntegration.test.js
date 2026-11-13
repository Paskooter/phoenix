import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { developerRoutes } from '../src/developerPortal.js';
import { SKILL_KIT_FILES, skillKitZip } from '../src/developerStarter.js';
import { staticRoutes as productionStaticRoutes } from '../src/static.js';
import { staticRoutes, copyKit, guideSources, contentProjectDir, hasSkillGuide, missingGuideReason } from './fixtures/developer-content.mjs';

function env(values, fn) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return fn(); } finally { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
function get(handler) {
  assert.equal(typeof handler, 'function', 'route must exist');
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(bytes) { this.bytes = Buffer.from(bytes); this.body = this.bytes.toString(); } };
  handler({ res }); return res;
}
const KIT = 'GET /developers/downloads/jibo-skill-kit.zip';

test('integration: a linked kit readme remains a link rather than silently becoming plain text', () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'developer-readme-'));
  try {
    mkdirSync(join(projectDir, 'docs/developers'), { recursive: true });
    writeFileSync(join(projectDir, 'docs/developers/support.md'), '# Support\n\nRead [the kit readme](../../tools/skill-kit/README.md).\n');
    const routes = developerRoutes({ prepare: bytes => bytes, projectDir }).routes;
    assert.match(get(routes['GET /developers/support']).body, /<a href="https:\/\/github.com\/Paskooter\/phoenix\/blob\/main\/tools\/skill-kit\/README.md">the kit readme<\/a>/);
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
});

test('integration: no partial guide or missing allowlisted file can advertise a kit', () => env({ PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true' }, () => {
  const projectDir = mkdtempSync(join(tmpdir(), 'developer-admission-'));
  try {
    for (const path of guideSources) {
      mkdirSync(join(projectDir, path, '..'), { recursive: true });
      writeFileSync(join(projectDir, path), '# Synthetic reference\n\nRoute-admission input only.\n');
    }
    copyKit(projectDir);
    assert.equal(typeof developerRoutes({ prepare: b => b, projectDir }).routes[KIT], 'function');
    for (const path of [...guideSources, ...SKILL_KIT_FILES]) {
      rmSync(join(projectDir, path));
      const routes = developerRoutes({ prepare: b => b, projectDir }).routes;
      assert.equal(routes[KIT], undefined, path);
      assert.equal(routes['GET /developers/skills'], undefined, path);
      writeFileSync(join(projectDir, path), '# Synthetic restored route-admission input\n');
    }
  } finally { rmSync(projectDir, { recursive: true, force: true }); }
}));

test('integration: route-table opt-in is stable and does not invent the private Store layer', () => {
  const routes = env({ PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_DEVELOPER_SKILLS_ENABLED: undefined }, () => productionStaticRoutes());
  env({ PHOENIX_SKILL_STORE_ENABLED: undefined }, () => {
    assert.equal(get(routes['GET /developers']).status, 200);
    assert.match(get(routes['GET /']).body, /href="\/developers">Developers<\/a>/);
    assert.equal(productionStaticRoutes()['GET /developers'], undefined);
  });
  const boundary = get(routes['GET /developers/console']);
  assert.equal(boundary.status, 302);
  assert.equal(boundary.headers.location, '/apps#publisher');
  // These assets belong to a separate integration, not placeholder Hub files.
  for (const path of ['/apps', '/apps.js', '/apps.css']) assert.equal(routes['GET ' + path], undefined);
});

test('integration: enabled download is byte-identical to the explicit kit inputs', { skip: !hasSkillGuide && missingGuideReason }, () => env({ PHOENIX_SKILL_STORE_ENABLED: 'true', PHOENIX_DEVELOPER_SKILLS_ENABLED: 'true' }, () => {
  const first = get(staticRoutes()[KIT]);
  const second = get(staticRoutes()[KIT]);
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-length'], first.bytes.length);
  assert.equal(first.headers['content-type'], 'application/zip');
  assert.equal(first.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(first.bytes, second.bytes);
  assert.deepEqual(first.bytes, skillKitZip(contentProjectDir));
  if (process.env.PHOENIX_DEVELOPER_TEST_ZIP_SHA256) assert.equal(createHash('sha256').update(first.bytes).digest('hex'), process.env.PHOENIX_DEVELOPER_TEST_ZIP_SHA256);
}));
