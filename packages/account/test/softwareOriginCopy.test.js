import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticRoutes } from '../src/static.js';

const project = new URL('../../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, project), 'utf8');
const compact = (text) => text.replace(/\s+/g, ' ');
const disclosure = 'Robot updates and Phoenix images include original Jibo robot software and skills, with Phoenix changes.';
const forbidden = /no Jibo binaries|zero vendored Jibo binaries|no binaries, no proprietary code|Phoenix ships no code|only plain-text data|strictly as a behavioural reference|clean-room reimplementation|OTA packages are built locally, not shipped/i;
const brand = JSON.parse(read('packages/account/portal/branding.json'));

function served(path) {
  const keys = ['PHOENIX_PAGES_DIR', 'PHOENIX_BRANDING_FILE', 'PHOENIX_SITE_URL'];
  const saved = keys.map(key => process.env[key]);
  for (const key of keys) delete process.env[key];
  process.env.PHOENIX_SITE_URL = 'https://synthetic.example';
  try {
    let body;
    staticRoutes()[`GET ${path}`]({ res: {
      writeHead(status) { assert.equal(status, 200); },
      end(value) { body = String(value); },
    } });
    return body;
  } finally {
    keys.forEach((key, i) => {
      if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
    });
  }
}

// Test both fallback HTML and the separately rendered branding: fixing only one
// leaves a stale claim for crawlers, static hosting or the browser's second pass.
test('landing fallback and branding describe the open-source server and original robot software', () => {
  const source = compact(read('packages/account/portal/index.html'));
  for (const text of [source, JSON.stringify(brand), compact(served('/'))]) {
    assert.doesNotMatch(text, forbidden);
    assert.ok(text.includes(disclosure));
  }
  assert.match(brand.features.items.find(item => item.icon === 'open').body, /server is open source/);
  assert.ok(brand.faq.items.find(item => item.q === 'Does it ship any of the original software?').a.startsWith(`Yes. ${disclosure}`));
  assert.match(brand.footer.blurb, /open-source server/);
});

test('landing descriptions and structured data contain no original-software denial', () => {
  const html = served('/');
  const descriptions = [...html.matchAll(/<meta (?:name="(?:description|twitter:description)"|property="og:description") content="([^"]+)"/g)].map(match => match[1]);
  assert.equal(descriptions.length, 3);
  for (const description of descriptions) {
    assert.match(description, /open-source server/);
    assert.ok(description.includes(disclosure));
  }
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  const data = JSON.parse(scripts[0][1]);
  assert.doesNotMatch(JSON.stringify(data), forbidden);
  assert.equal(data['@graph'].find(item => item['@type'] === 'WebSite').name, 'Phoenix');
});

test('terms distinguish the open-source server from robot downloads', () => {
  for (const html of [read('packages/account/portal/terms.html'), served('/terms')]) {
    const text = compact(html);
    assert.doesNotMatch(text, forbidden);
    assert.ok(text.includes(disclosure));
    assert.match(text, /server.*open.source/);
    assert.match(text, /original Jibo dialog content, grammars and other resources/);
  }
});

test('README and historical documentation do not repeat blanket distribution denials', () => {
  for (const path of ['README.md', 'docs/DIVERGENCES.md', 'docs/internal/M9-REPORT.md', 'docs/internal/OOBE-PORTAL-HANDOFF.md', 'docs/internal/WORKLOG.md']) {
    const text = compact(read(path));
    assert.doesNotMatch(text, forbidden, path);
    assert.doesNotMatch(text, /vendor(?:s)? plain data/i, path);
  }
  const readme = compact(read('README.md'));
  assert.ok(readme.includes(disclosure));
  assert.match(readme, /server is open source/);
  assert.match(readme, /original client-code test fixture/);
});

test('metadata regeneration preserves the corrected server and robot-software wording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-origin-meta-'));
  try {
    writeFileSync(join(dir, 'index.html'), read('packages/account/portal/index.html'));
    const result = spawnSync('python3', [fileURLToPath(new URL('tools/portal-meta.py', project)), dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const generated = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(generated, forbidden);
    assert.ok(generated.includes(`content="${brand.description}"`));
    assert.doesNotMatch(read('tools/og-card.py'), forbidden);
    assert.match(read('tools/og-card.py'), /An open-source server that brings Jibo/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
