// The console reads the server's environment file to show where each setting's
// value comes from. It never writes it (consoleSettings.js keeps what the console
// saves); these pin how it is read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readEnvFile, envFilePath } from '../src/admin/envFile.js';
import * as envFile from '../src/admin/envFile.js';

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
ETCO_gqa_wikiUserAgent="Fixture/1.0 (https://example.test; ops@example.test)"
`;

function fixture(text = SAMPLE) {
  const dir = mkdtempSync(join(tmpdir(), 'phx-env-'));
  const path = join(dir, '.env');
  writeFileSync(path, text);
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

test('a quoted value is read without its quotes, as the launcher and loader read it', () => {
  const { values } = readEnvFile(fixture());
  assert.equal(values.ETCO_gqa_wikiUserAgent, 'Fixture/1.0 (https://example.test; ops@example.test)');
});

test('prose containing an equals sign is not mistaken for an assignment', () => {
  const { values } = readEnvFile(fixture('# set prefsFromConfig=true to enable the commute section\nLOG_LEVEL=info\n'));
  assert.equal(values.LOG_LEVEL, 'info');
  assert.equal(values.prefsFromConfig, undefined);
});

test('a missing file reads as empty, and the path follows PHOENIX_ENV_FILE', () => {
  const missing = join(mkdtempSync(join(tmpdir(), 'phx-env-')), 'absent.env');
  assert.deepEqual(readEnvFile(missing).values, {});
  assert.equal(readEnvFile(missing).exists, false);
  const path = fixture();
  assert.equal(envFilePath({ PHOENIX_ENV_FILE: path }), path);
});

test('the console has no way to write the server’s file', () => {
  assert.equal(envFile.writeEnvFile, undefined);
});
