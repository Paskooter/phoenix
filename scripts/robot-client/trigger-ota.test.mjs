import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./trigger-ota.cjs', import.meta.url));
const updates = [
  { id: 'be-11.0.1-jibo-io-fcs', subsystem: '@be/be', toVersion: '11.0.1', length: 400, dependencies: { os: '13.0.6', services: '13.0.6' } },
  { id: 'os-13.0.6-fcs', subsystem: 'os', toVersion: '13.0.6', length: 100, dependencies: {} },
  { id: 'services-13.0.6-fcs', subsystem: 'services', toVersion: '13.0.6', length: 200, dependencies: { os: '13.0.6' } },
  { id: 'oobe-config-9.0.1-jibo-io-fcs', subsystem: 'oobe-config', toVersion: '9.0.1', length: 300, dependencies: { os: '13.0.6', services: '13.0.6' } },
];

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [helper, ...args], { env: { ...process.env, ...env } });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('native OTA plans, downloads, and applies four subsystems without BE or OOBE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-native-ota-'));
  const creds = join(dir, 'credentials.json');
  const modePath = join(dir, 'mode.json');
  const setModeBin = join(dir, 'jibo-setmode');
  writeFileSync(creds, '{}');
  writeFileSync(modePath, JSON.stringify({ mode: 'int-developer' }));
  writeFileSync(setModeBin, '#!/bin/sh\nprintf \'{"mode":"%s"}\' "$1" > "$PHOENIX_ROBOT_OTA_MODE_PATH"\n');
  chmodSync(setModeBin, 0o755);
  const calls = [];
  let offered = updates;
  let rejectPost = false;
  let rejectDownload = false;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/update/fcs') return res.end(JSON.stringify({ updates: offered }));
      if (req.method === 'PUT' && req.url === '/update/') {
        if (rejectDownload) {
          res.write(JSON.stringify({ id: updates[0].id, status: 'failed', reason: 'checksum mismatch' }) + '\n');
          return res.end();
        }
        body && JSON.parse(body).ids.forEach((id) => res.write(JSON.stringify({ id, length: 10, received: 10, status: 'finished' }) + '\n'));
        return res.end();
      }
      if (req.method === 'POST' && req.url === '/update/') {
        assert.equal(JSON.parse(readFileSync(modePath, 'utf8')).mode, 'normal');
        return res.end(rejectPost ? JSON.stringify({ error: 'rejected' }) : '{}');
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    PHOENIX_ROBOT_OTA_PORT: String(server.address().port),
    PHOENIX_ROBOT_OTA_CREDENTIALS_PATH: creds,
    PHOENIX_ROBOT_OTA_STATE_PATH: join(dir, 'ota.json'),
    PHOENIX_ROBOT_OTA_BE_PATH: join(dir, 'missing-be'),
    PHOENIX_ROBOT_OTA_MODE_PATH: modePath,
    PHOENIX_ROBOT_OTA_SETMODE_BIN: setModeBin,
  };
  try {
    const plan = await run(['--plan', 'fcs'], env);
    assert.equal(plan.code, 0, plan.stderr);
    const hash = plan.stdout.match(/PHOENIX_OTA_PLAN_HASH=([a-f0-9]{64})/)?.[1];
    assert.ok(hash);
    assert.match(plan.stdout, /@be\/be -> 11\.0\.1/);
    assert.deepEqual(calls.map(({ method }) => method), ['GET']);

    const apply = await run(['--apply', hash, 'fcs'], env);
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /Native OTA accepted/);
    assert.equal(JSON.parse(readFileSync(modePath, 'utf8')).mode, 'normal');
    assert.deepEqual(calls.slice(1).map(({ method }) => method), ['GET', 'PUT', 'POST']);
    assert.deepEqual(calls.at(-1).body.ids, [
      'os-13.0.6-fcs', 'services-13.0.6-fcs',
      'oobe-config-9.0.1-jibo-io-fcs', 'be-11.0.1-jibo-io-fcs',
    ]);

    offered = updates.filter((u) => u.subsystem !== '@be/be');
    const missingBe = await run(['--plan', 'fcs'], env);
    assert.notEqual(missingBe.code, 0);
    assert.match(missingBe.stderr, /BE is absent but the server offered no BE update/);
    assert.deepEqual(calls.at(-1).method, 'GET');

    offered = updates;
    rejectPost = true;
    writeFileSync(modePath, JSON.stringify({ mode: 'int-developer' }));
    const rejected = await run(['--apply', hash, 'fcs'], env);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /installer rejected/);
    assert.equal(JSON.parse(readFileSync(modePath, 'utf8')).mode, 'int-developer',
      'clear installer rejection restores the previous boot mode');
    rejectPost = false;

    rejectDownload = true;
    const failedDownload = await run(['--apply', hash, 'fcs'], env);
    assert.notEqual(failedDownload.code, 0);
    assert.match(failedDownload.stderr, /checksum mismatch/);
    assert.equal(JSON.parse(readFileSync(modePath, 'utf8')).mode, 'int-developer',
      'mode is unchanged until every package passes checksum verification');
    assert.equal(calls.at(-1).method, 'PUT', 'failed downloads must not start the installer');
    rejectDownload = false;

    offered = updates;
    const changedPlan = await run(['--apply', '0'.repeat(64), 'fcs'], env);
    assert.notEqual(changedPlan.code, 0);
    assert.match(changedPlan.stderr, /catalog changed/);
    assert.deepEqual(calls.at(-1).method, 'GET');

    offered = updates.map((u) => u.subsystem === '@be/be'
      ? { ...u, id: 'be-11.0.2-jibo-io-fcs', toVersion: '11.0.2' } : u);
    const nextBe = await run(['--plan', 'fcs'], env);
    assert.equal(nextBe.code, 0, nextBe.stderr);
    assert.match(nextBe.stdout, /@be\/be -> 11\.0\.2/);
    offered = offered.map((u) => u.subsystem === '@be/be'
      ? { ...u, toVersion: '12.0.0' } : u);
    const unsupportedBe = await run(['--plan', 'fcs'], env);
    assert.notEqual(unsupportedBe.code, 0);
    assert.match(unsupportedBe.stderr, /unexpected OTA version/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
