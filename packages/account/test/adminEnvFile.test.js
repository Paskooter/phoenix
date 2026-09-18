// The console edits configuration by rewriting the repo's .env, which is a
// hand-written file full of explanatory comments. These pin the property that
// matters most: everything the console does not own survives untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvFile, writeEnvFile } from '../src/admin/envFile.js';

const SAMPLE = `# Phoenix configuration — copy to \`.env\` and edit.
# Loaded automatically by every Phoenix service.

# ── Web portal ──────────────────────────────────────────────────────────────
# The region written into adopted robots' credentials.json.
ETCO_account_region=api
# Where the account store persists.
#ETCO_account_dataFile=packages/account/data/store.json

# ── Hub auth ────────────────────────────────────────────────────────────────
HUB_TOKEN_SECRET=dev-hub-token-secret
DISABLE_AUTH=true
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'phx-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, SAMPLE);
  return path;
}

test('reads live assignments and reports commented ones separately', () => {
  const path = fixture();
  const { values, commented, exists } = readEnvFile(path);

  assert.equal(exists, true);
  assert.equal(values.ETCO_account_region, 'api');
  assert.equal(values.HUB_TOKEN_SECRET, 'dev-hub-token-secret');
  assert.equal(values.DISABLE_AUTH, 'true');
  // A commented-out line is not in force, and must not be reported as a value.
  assert.equal(values.ETCO_account_dataFile, undefined);
  assert.equal(commented.ETCO_account_dataFile, 'packages/account/data/store.json');
});

test('rewrites an existing key in place and leaves every other byte alone', () => {
  const path = fixture();
  const before = readFileSync(path, 'utf8');

  const result = writeEnvFile({ HUB_TOKEN_SECRET: 'a-real-secret' }, { path });
  const after = readFileSync(path, 'utf8');

  assert.deepEqual(result.applied, ['HUB_TOKEN_SECRET']);
  assert.equal(readEnvFile(path).values.HUB_TOKEN_SECRET, 'a-real-secret');

  // Exactly one line differs, and it is the one we asked for.
  const diff = before.split('\n')
    .map((line, i) => [line, after.split('\n')[i]])
    .filter(([a, b]) => a !== b);
  assert.equal(diff.length, 1);
  assert.deepEqual(diff[0], ['HUB_TOKEN_SECRET=dev-hub-token-secret', 'HUB_TOKEN_SECRET=a-real-secret']);

  // Every comment survives.
  assert.ok(after.includes('# Phoenix configuration'));
  assert.ok(after.includes('# ── Hub auth ─'));
  assert.ok(after.includes("# The region written into adopted robots' credentials.json."));
});

test('setting a commented-out key uncomments it in place rather than appending', () => {
  const path = fixture();
  writeEnvFile({ ETCO_account_dataFile: '/srv/phoenix/store.json' }, { path });
  const after = readFileSync(path, 'utf8');

  assert.equal(readEnvFile(path).values.ETCO_account_dataFile, '/srv/phoenix/store.json');
  assert.ok(after.includes('ETCO_account_dataFile=/srv/phoenix/store.json'));
  assert.ok(!after.includes('#ETCO_account_dataFile='));
  // It stayed under its own comment, not at the bottom of the file.
  const lines = after.split('\n');
  assert.equal(lines[lines.indexOf('ETCO_account_dataFile=/srv/phoenix/store.json') - 1],
    '# Where the account store persists.');
  assert.ok(!after.includes('Set from the admin console'));
});

test('clearing a key comments it out, keeping the old value visible', () => {
  const path = fixture();
  const result = writeEnvFile({ DISABLE_AUTH: '' }, { path });

  assert.deepEqual(result.cleared, ['DISABLE_AUTH']);
  const { values, commented } = readEnvFile(path);
  assert.equal(values.DISABLE_AUTH, undefined);
  assert.equal(commented.DISABLE_AUTH, 'true');
});

test('an unknown key is appended under a marked section', () => {
  const path = fixture();
  writeEnvFile({ PARAKEET_URL: 'http://10.0.0.5:6972' }, { path });
  const after = readFileSync(path, 'utf8');

  assert.equal(readEnvFile(path).values.PARAKEET_URL, 'http://10.0.0.5:6972');
  assert.ok(after.includes('Set from the admin console'));
  assert.ok(after.indexOf('Set from the admin console') < after.indexOf('PARAKEET_URL='));
  // The header is written once, however many appends happen.
  writeEnvFile({ LLM_MODEL: 'some/model' }, { path });
  const twice = readFileSync(path, 'utf8');
  assert.equal(twice.split('Set from the admin console').length - 1, 1);
});

test('values needing quotes get them, and round-trip unchanged', () => {
  const path = fixture();
  writeEnvFile({ ETCO_account_mailFrom: ' spaced value ', LLM_MODEL: 'has#hash' }, { path });
  const { values } = readEnvFile(path);
  assert.equal(values.ETCO_account_mailFrom, ' spaced value ');
  assert.equal(values.LLM_MODEL, 'has#hash');
});

test('a no-op write does not touch the file', () => {
  const path = fixture();
  const before = statSync(path).mtimeMs;
  const result = writeEnvFile({ HUB_TOKEN_SECRET: 'dev-hub-token-secret' }, { path });
  assert.deepEqual(result, { path, applied: [], cleared: [], added: [], backup: null });
  assert.equal(statSync(path).mtimeMs, before);
});

test('a backup of the previous contents is kept', () => {
  const path = fixture();
  writeEnvFile({ HUB_TOKEN_SECRET: 'changed' }, { path });
  assert.ok(existsSync(`${path}.bak`));
  assert.equal(readEnvFile(`${path}.bak`).values.HUB_TOKEN_SECRET, 'dev-hub-token-secret');
});

test('a file created from nothing is not world-readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-env-'));
  const path = join(dir, '.env');
  writeEnvFile({ HUB_TOKEN_SECRET: 'fresh' }, { path });

  assert.equal(readEnvFile(path).values.HUB_TOKEN_SECRET, 'fresh');
  // .env holds secrets: no group or other bits.
  assert.equal(statSync(path).mode & 0o077, 0);
});

test('an existing file keeps its own permissions', () => {
  const path = fixture();
  chmodSync(path, 0o640);
  writeEnvFile({ HUB_TOKEN_SECRET: 'changed' }, { path });
  assert.equal(statSync(path).mode & 0o777, 0o640);
});

test('prose containing an equals sign is not mistaken for an assignment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, '# set prefsFromConfig=true to enable the commute section\nLOG_LEVEL=info\n');

  const { values, commented } = readEnvFile(path);
  assert.equal(values.LOG_LEVEL, 'info');
  // The prose line does assign-looking text; it is reported as commented, never live.
  assert.equal(values.prefsFromConfig, undefined);

  // And writing that key must not rewrite the sentence.
  writeEnvFile({ LOG_LEVEL: 'debug' }, { path });
  assert.ok(readFileSync(path, 'utf8')
    .includes('# set prefsFromConfig=true to enable the commute section'));
  assert.ok(commented !== undefined);
});
