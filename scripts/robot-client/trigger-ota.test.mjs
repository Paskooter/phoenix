import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync,
  symlinkSync, readlinkSync, lstatSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const helper = fileURLToPath(new URL('./trigger-ota.cjs', import.meta.url));
const require = createRequire(import.meta.url);

test('root mount check ignores synthetic writable rootfs and tracks the real ext4 mount', () => {
  const { rootMountIsReadOnly } = require(helper);
  const prefix = '1 0 0:1 / / rw,relatime - rootfs rootfs rw\n';
  assert.equal(rootMountIsReadOnly(prefix + '12 1 179:1 / / ro,relatime - ext4 /dev/root ro\n'), true);
  assert.equal(rootMountIsReadOnly(prefix + '12 1 179:1 / / rw,relatime - ext4 /dev/root rw\n'), false);
  assert.throws(() => rootMountIsReadOnly('13 12 0:5 / /dev rw - devtmpfs devtmpfs rw\n'),
    /could not determine root mount mode/);
});
const updates = [
  { id: 'be-13.0.2-jibo-io-fcs', subsystem: '@be/be', toVersion: '13.0.2', length: 400, dependencies: { os: '13.0.7', services: '13.0.7' } },
  { id: 'os-13.0.7-fcs', subsystem: 'os', toVersion: '13.0.7', length: 100, dependencies: {} },
  { id: 'services-13.0.7-fcs', subsystem: 'services', toVersion: '13.0.7', length: 200, dependencies: { os: '13.0.7' } },
  { id: 'oobe-config-9.0.1-jibo-io-fcs', subsystem: 'oobe-config', toVersion: '9.0.1', length: 300, dependencies: { os: '13.0.7', services: '13.0.7' } },
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
  const queryPath = join(dir, 'jibo-get-update');
  const queryStatePath = join(dir, 'ota-query-override.json');
  const originalQuery = '#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2)}));\n';
  writeFileSync(creds, '{}');
  writeFileSync(modePath, JSON.stringify({ mode: 'int-developer' }));
  writeFileSync(setModeBin, '#!/bin/sh\nprintf \'{"mode":"%s"}\' "$1" > "$PHOENIX_ROBOT_OTA_MODE_PATH"\n');
  chmodSync(setModeBin, 0o755);
  writeFileSync(queryPath, originalQuery);
  chmodSync(queryPath, 0o755);
  const calls = [];
  const queries = [];
  let offered = updates;
  let rejectPost = false;
  let rejectDownload = false;
  let rejectGet = false;
  let hangGet = false;
  let busyGetCount = 0;
  let managerError = null;
  let queriedSubsystems = ['os', 'services', 'oobe-config', '@be/be'];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls.push({ method: req.method, path: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/update/fcs') {
        if (hangGet) return; // model a helper killed while discovery is in flight
        if (busyGetCount > 0) {
          busyGetCount -= 1;
          return res.end(JSON.stringify({ error: 'Service temporarily unavailable' }));
        }
        if (managerError) return res.end(JSON.stringify({ error: managerError }));
        // Simulate UpdateManager.checkForUpdates invoking the real absolute
        // jibo-get-update entrypoint for all four published subsystems.
        for (const subsystem of queriedSubsystems) {
          const query = spawnSync(queryPath, ['--credentials', creds, '--subsystem', subsystem,
            '--version', '13.0.5', '--filter', 'fcs'], { encoding: 'utf8', env: {
              ...process.env, PHOENIX_ROBOT_OTA_QUERY_PATH: queryPath,
              PHOENIX_ROBOT_OTA_QUERY_STATE_PATH: queryStatePath,
              PHOENIX_ROBOT_OTA_CREDENTIALS_PATH: creds,
            } });
          assert.equal(query.status, 0, query.stderr);
          const args = JSON.parse(query.stdout).args;
          queries.push({ subsystem, version: args[args.indexOf('--version') + 1] });
        }
        if (rejectGet) { res.statusCode = 503; return res.end('{}'); }
        return res.end(JSON.stringify({ updates: offered }));
      }
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
    PHOENIX_ROBOT_OTA_QUERY_PATH: queryPath,
    PHOENIX_ROBOT_OTA_QUERY_STATE_PATH: queryStatePath,
  };
  try {
    const plan = await run(['--plan', 'fcs'], env);
    assert.equal(plan.code, 0, plan.stderr);
    const hash = plan.stdout.match(/PHOENIX_OTA_PLAN_HASH=([a-f0-9]{64})/)?.[1];
    assert.ok(hash);
    assert.match(plan.stdout, /@be\/be -> 13\.0\.2/);
    assert.deepEqual(calls.map(({ method }) => method), ['GET']);
    assert.deepEqual(queries.map((q) => q.version), Array(4).fill('0.0.1'));
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    assert.equal(existsSync(queryPath + '.phoenix-ota-original'), false);
    assert.equal(existsSync(queryStatePath), false);

    const apply = await run(['--apply', hash, 'fcs'], env);
    assert.equal(apply.code, 0, apply.stderr);
    assert.match(apply.stdout, /Native OTA accepted/);
    assert.equal(JSON.parse(readFileSync(modePath, 'utf8')).mode, 'normal');
    assert.deepEqual(calls.slice(1).map(({ method }) => method), ['GET', 'PUT', 'POST']);
    assert.deepEqual(queries.map((q) => q.version), Array(8).fill('0.0.1'));
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery,
      'stock query executable is restored before the native install POST');
    assert.deepEqual(calls.at(-1).body.ids, [
      'os-13.0.7-fcs', 'services-13.0.7-fcs',
      'oobe-config-9.0.1-jibo-io-fcs', 'be-13.0.2-jibo-io-fcs',
    ]);

    offered = updates.filter((u) => u.subsystem !== '@be/be');
    const missingBe = await run(['--plan', 'fcs'], env);
    assert.notEqual(missingBe.code, 0);
    assert.match(missingBe.stderr, /full refresh requires a published @be\/be OTA/);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    assert.deepEqual(calls.at(-1).method, 'GET');

    queriedSubsystems = ['os', 'services', 'oobe-config'];
    offered = updates;
    const missingQuery = await run(['--plan', 'fcs'], env);
    assert.notEqual(missingQuery.code, 0);
    assert.match(missingQuery.stderr, /did not query @be\/be through the full-refresh override/);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    queriedSubsystems = ['os', 'services', 'oobe-config', '@be/be'];

    queriedSubsystems = [];
    const noQueries = await run(['--plan', 'fcs'], env);
    assert.notEqual(noQueries.code, 0);
    assert.match(noQueries.stderr, /did not query os through the full-refresh override \(queries observed: none; updates offered: 4\)/);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    queriedSubsystems = ['os', 'services', 'oobe-config', '@be/be'];

    managerError = 'query failed before os';
    const managerFailure = await run(['--plan', 'fcs'], env);
    assert.notEqual(managerFailure.code, 0);
    assert.match(managerFailure.stderr, /update discovery failed: query failed before os/);
    assert.doesNotMatch(managerFailure.stderr, /did not query os/);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    managerError = null;

    busyGetCount = 1;
    const busyThenReady = await run(['--plan', 'fcs'], env);
    assert.equal(busyThenReady.code, 0, busyThenReady.stderr);
    assert.equal(busyGetCount, 0);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);

    busyGetCount = 3;
    const stillBusy = await run(['--plan', 'fcs'], env);
    assert.notEqual(stillBusy.code, 0);
    assert.match(stillBusy.stderr, /update discovery failed: Service temporarily unavailable/);
    assert.equal(busyGetCount, 0);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    assert.equal(existsSync(queryStatePath), false);

    rejectGet = true;
    const failedGet = await run(['--plan', 'fcs'], env);
    assert.notEqual(failedGet.code, 0);
    assert.match(failedGet.stderr, /system-manager HTTP 503/);
    assert.equal(readFileSync(queryPath, 'utf8'), originalQuery);
    assert.equal(existsSync(queryStatePath), false);
    rejectGet = false;

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
      ? { ...u, id: 'be-13.0.3-jibo-io-fcs', toVersion: '13.0.3' } : u);
    const newerBe = await run(['--plan', 'fcs'], env);
    assert.equal(newerBe.code, 0, newerBe.stderr);
    assert.match(newerBe.stdout, /@be\/be -> 13\.0\.3/);
    offered = updates;
    offered = offered.map((u) => u.subsystem === 'os'
      ? { ...u, id: 'os-13.0.8-fcs', toVersion: '13.0.8' } : u);
    const newerOs = await run(['--plan', 'fcs'], env);
    assert.notEqual(newerOs.code, 0, 'dependent services must be updated alongside the OS');
    assert.match(newerOs.stderr, /catalog dependency mismatch/);
    offered = offered.map((u) => u.subsystem === 'services'
      ? { ...u, id: 'services-13.0.8-fcs', toVersion: '13.0.8', dependencies: { os: '13.0.8' } } : u);
    offered = offered.map((u) => u.subsystem === 'oobe-config' || u.subsystem === '@be/be'
      ? { ...u, dependencies: { os: '13.0.8', services: '13.0.8' } } : u);
    const newerPlatform = await run(['--plan', 'fcs'], env);
    assert.equal(newerPlatform.code, 0, newerPlatform.stderr);
    assert.match(newerPlatform.stdout, /os -> 13\.0\.8/);
    offered = updates;
    offered = offered.map((u) => u.subsystem === 'os'
      ? { ...u, id: 'os-13.0.7-fcs', toVersion: '13.0.7' } : u);
    offered = offered.map((u) => u.subsystem === 'oobe-config'
      ? { ...u, dependencies: { os: '13.0.6', services: '13.0.6' } } : u);
    const incompatibleOobe = await run(['--plan', 'fcs'], env);
    assert.notEqual(incompatibleOobe.code, 0);
    assert.match(incompatibleOobe.stderr, /catalog dependency mismatch: oobe-config requires os 13\.0\.6 but the catalog offers 13\.0\.7/);
    offered = offered.map((u) => u.subsystem === 'oobe-config'
      ? { ...u, dependencies: { os: '13.0.7', services: '13.0.7' } } : u);
    offered = offered.map((u) => u.subsystem === '@be/be'
      ? { ...u, toVersion: 'not-a-version' } : u);
    const malformedBe = await run(['--plan', 'fcs'], env);
    assert.notEqual(malformedBe.code, 0);
    assert.match(malformedBe.stderr, /invalid OTA version/);

    // Stock firmware often provides /usr/bin/jibo-get-update as a symlink to
    // the npm-installed script; restoring must preserve that link exactly.
    const stockTarget = join(dir, 'stock-get-update');
    renameSync(queryPath, stockTarget);
    symlinkSync(stockTarget, queryPath);
    offered = updates;
    const symlinkPlan = await run(['--plan', 'fcs'], env);
    assert.equal(symlinkPlan.code, 0, symlinkPlan.stderr);
    assert.equal(lstatSync(queryPath).isSymbolicLink(), true);
    assert.equal(readlinkSync(queryPath), stockTarget);
    assert.equal(existsSync(queryPath + '.phoenix-ota-original'), false);

    hangGet = true;
    const interrupted = spawn(process.execPath, [helper, '--plan', 'fcs'], {
      env: { ...process.env, ...env }, stdio: 'ignore',
    });
    for (let i = 0; i < 80 && !existsSync(queryPath + '.phoenix-ota-original'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(queryPath + '.phoenix-ota-original'), true,
      'the stock query entrypoint was backed up during discovery');
    interrupted.kill('SIGKILL');
    await new Promise((resolve) => interrupted.on('close', resolve));
    assert.equal(existsSync(queryStatePath), true, 'a crash leaves a short-lived lease');
    const afterCrashQuery = spawnSync(queryPath, ['--credentials', creds, '--subsystem', 'os',
      '--version', '13.0.5'], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(afterCrashQuery.status, 0, afterCrashQuery.stderr);
    const afterCrashArgs = JSON.parse(afterCrashQuery.stdout).args;
    assert.equal(afterCrashArgs[afterCrashArgs.indexOf('--version') + 1], '13.0.5',
      'the wrapper stops spoofing as soon as its owner process is gone');
    hangGet = false;
    const recovered = await run(['--plan', 'fcs'], env);
    assert.equal(recovered.code, 0, recovered.stderr);
    assert.equal(lstatSync(queryPath).isSymbolicLink(), true,
      'the next run recovers and ultimately restores the original symlink');
    assert.equal(readlinkSync(queryPath), stockTarget);
    assert.equal(existsSync(queryPath + '.phoenix-ota-original'), false);
    assert.equal(existsSync(queryStatePath), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only preview asks for current packages from 0.0.1 without patching the robot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-native-ota-preview-'));
  const queryPath = join(dir, 'jibo-get-update');
  const statePath = join(dir, 'ota-query-override.json');
  const credentialsPath = join(dir, 'credentials.json');
  const stockQuery = `#!/usr/bin/env node
var a=process.argv.slice(2), s=a[a.indexOf('--subsystem')+1], v=a[a.indexOf('--version')+1];
if(v!=='0.0.1') process.exit(2);
console.log(JSON.stringify({subsystem:s,toVersion:'13.0.7',length:1048576}));
`;
  writeFileSync(credentialsPath, '{}');
  writeFileSync(queryPath, stockQuery);
  chmodSync(queryPath, 0o755);
  try {
    const result = await run(['--preview', 'fcs'], {
      PHOENIX_ROBOT_OTA_QUERY_PATH: queryPath,
      PHOENIX_ROBOT_OTA_QUERY_STATE_PATH: statePath,
      PHOENIX_ROBOT_OTA_CREDENTIALS_PATH: credentialsPath,
      PHOENIX_ROBOT_OTA_STATE_PATH: join(dir, 'ota-work.json'),
    });
    assert.equal(result.code, 0, result.stderr);
    for (const name of ['os', 'services', 'oobe-config', '@be/be']) {
      assert.match(result.stdout, new RegExp(name.replace('/', '\\/') + ' -> 13\\.0\\.7'));
    }
    assert.equal(readFileSync(queryPath, 'utf8'), stockQuery);
    assert.equal(existsSync(queryPath + '.phoenix-ota-original'), false);
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read-only preview reports the stock client error without dumping credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phx-native-ota-preview-error-'));
  const queryPath = join(dir, 'jibo-get-update');
  const credentialsPath = join(dir, 'credentials.json');
  const stockQuery = `#!/usr/bin/env node
console.log(JSON.stringify({error:{type:'ERROR',data:{message:'Signature does not match'},
  secretAccessKey:'must-not-be-printed'}}));
process.exit(1);
`;
  writeFileSync(credentialsPath, '{"secretAccessKey":"also-must-not-be-printed"}');
  writeFileSync(queryPath, stockQuery);
  chmodSync(queryPath, 0o755);
  try {
    const result = await run(['--preview', 'fcs'], {
      PHOENIX_ROBOT_OTA_QUERY_PATH: queryPath,
      PHOENIX_ROBOT_OTA_CREDENTIALS_PATH: credentialsPath,
      PHOENIX_ROBOT_OTA_STATE_PATH: join(dir, 'ota-work.json'),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /stock OTA lookup for os failed \(exit 1\): ERROR: Signature does not match/);
    assert.doesNotMatch(result.stderr, /must-not-be-printed/);
    assert.doesNotMatch(result.stderr, /child_process\.js/);
    assert.equal(readFileSync(queryPath, 'utf8'), stockQuery);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
