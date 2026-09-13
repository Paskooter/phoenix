// S-12 exercises the real CredentialStore/OAuth -> Data HTTP -> Report path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const evidence = path.join(root, 'docs/parity/evidence/2026-09-13/s12-calendar');
const runner = path.join(root, 'scripts/parity-s12/run-oauth-lifecycle-candidate.mjs');

test('S-12 OAuth failures deactivate credentials and select source CalendarServiceDown', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s12-oauth-test-'));
  const output = path.join(temp, 'oauth-lifecycle.json');
  try {
    const result = spawnSync(process.execPath, [
      runner,
      path.join(root, 'scripts/parity-s12/matrix.json'),
      path.join(evidence, 'source-runtime.json'),
      output,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.equal(receipt.result, 'pass');
    assert.deepEqual(receipt.rows.map((row) => row.id), [
      'google-refresh-failure',
      'outlook-invalid-token',
    ]);
    assert.deepEqual(receipt.rows.map((row) => row.status), [502, 502]);
    assert.ok(receipt.rows.every((row) => row.actionMatch));
    assert.ok(receipt.rows.every((row) => row.action.final === true));
    assert.ok(receipt.rows.every((row) => row.mims.length === 1 && row.mims[0] === 'CalendarServiceDown'));
    assert.deepEqual(receipt.rows.map((row) => row.credential), [
      { isActive: false, error: 'REFRESH_FAILED' },
      { isActive: false, error: 'INVALID_TOKEN' },
    ]);
    assert.deepEqual(receipt.rows.map((row) => row.operations.reportDelta), [
      { tokenPaths: ['/google-token'], googleProviderCalls: 0, outlookProviderCalls: 0 },
      { tokenPaths: [], googleProviderCalls: 0, outlookProviderCalls: 1 },
    ]);
    assert.ok(receipt.rows.every((row) => row.operations.probeDelta.tokenPaths.length === 0));
    assert.ok(receipt.rows.every((row) => row.operations.probeDelta.googleProviderCalls === 0 && row.operations.probeDelta.outlookProviderCalls === 0));
    assert.ok(receipt.rows.every((row) => /No credentials for (personalCalendar|workCalendar)/.test(row.routeBody)));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
