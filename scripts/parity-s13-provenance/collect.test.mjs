import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  collect,
  buildRemoteScript,
  compareSnapshotFiles,
  immutableFileHashes,
  writeAtomicJson,
} from './collect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'remote-complete.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function privateDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'phoenix-s13-provenance-test-'));
}

function fakeSsh(directory, remote) {
  const frame = `S13P1\t${JSON.stringify(remote)}\n`;
  const framePath = path.join(directory, 'remote-frame.txt');
  const logPath = path.join(directory, 'ssh-argv.log');
  fs.writeFileSync(framePath, frame, { mode: 0o600 });
  const scriptPath = path.join(directory, 'fake-ssh');
  const quotedFrame = `'${framePath.replaceAll("'", "'\\\"'\\\"'")}'`;
  const quotedLog = `'${logPath.replaceAll("'", "'\\\"'\\\"'")}'`;
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '%s\\n' "$*" > ${quotedLog}\ncat ${quotedFrame}\n`, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  return { scriptPath, frame, logPath };
}

function cloneFixture() {
  return JSON.parse(JSON.stringify(fixture));
}

test('remote bootstrap remains compatible with Moth Node 6 and selects the Electron main process', () => {
  const script = buildRemoteScript('fixture-slot');
  assert.match(script, /exec node <<'__S13_NODE__'/);
  assert.doesNotMatch(script, /exec node - <<'__S13_NODE__'/);
  assert.match(script, /active Electron main process/);
});

test('collects a complete fixture through one fake root SSH command and writes mode 0600', async () => {
  const directory = privateDirectory();
  const ssh = fakeSsh(directory, fixture);
  const output = path.join(directory, 'receipt.json');
  const snapshot = await collect({ host: 'fixture-host', slot: 'fixture-slot', out: output, sshBin: ssh.scriptPath });

  assert.equal(snapshot.schema, 'phoenix-s13-provenance-v1');
  assert.equal(snapshot.collector.remoteUser, 'root');
  assert.equal(snapshot.target.slot, 'fixture-slot');
  assert.equal(snapshot.electron.page.slot, 'fixture-slot');
  assert.equal(snapshot.electron.process.candidateCount, 1);
  assert.equal(snapshot.be.package.name, '@be/fixture-parity');
  assert.equal(snapshot.jetstreamClient.package.name, '@jibo/jetstream-client');
  assert.equal(snapshot.native.node.version, 'v6.17.1');
  assert.equal(snapshot.native.jetstream.binary.path, '/usr/local/bin/jibo-jetstream-service');
  assert.equal(snapshot.native.jetstream.config.path, '/usr/local/etc/jibo-jetstream-service.json');
  assert.equal(snapshot.nimbus.package.name, '@be/nimbus');
  assert.equal(snapshot.nimbus.assets.auditSha256, '24289254460d31852752da635805d64788d4e345fd7155d5b44ca6c1a6721ee2');
  assert.equal(snapshot.ssm.package.version, '16.0.0');
  assert.equal(snapshot.firmware.release, '3.3.0 InDev');
  assert.equal(snapshot.identity.hostname, undefined);
  assert.equal(snapshot.identity.robotIdSha256.length, 64);
  assert.equal(snapshot.raw.ssh.stdoutSha256, sha256(Buffer.from(ssh.frame)));
  assert.equal(snapshot.raw.ssh.stderrBytes, 0);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(ssh.logPath, 'utf8'), /root@fixture-host/);
});

test('compares before/after snapshots using derived immutable file hashes', async () => {
  const directory = privateDirectory();
  const ssh = fakeSsh(directory, fixture);
  const beforePath = path.join(directory, 'before.json');
  const afterPath = path.join(directory, 'after.json');
  await collect({ host: 'fixture-host', slot: 'fixture-slot', out: beforePath, sshBin: ssh.scriptPath });
  await collect({ host: 'fixture-host', slot: 'fixture-slot', out: afterPath, sshBin: ssh.scriptPath });
  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
  assert.deepEqual(immutableFileHashes(before), immutableFileHashes(after));
  const comparisonPath = path.join(directory, 'comparison.json');
  const comparison = compareSnapshotFiles(beforePath, afterPath, comparisonPath);
  assert.equal(comparison.matched, true);
  assert.equal(fs.statSync(comparisonPath).mode & 0o777, 0o600);

  after.be.index.sha256 = 'f'.repeat(64);
  writeAtomicJson(afterPath, after);
  const changed = compareSnapshotFiles(beforePath, afterPath);
  assert.equal(changed.matched, false);
  assert.ok(changed.differences.some((row) => row.key.includes('be.index')));

  after.native.jetstream.config.sha256 = 'e'.repeat(64);
  writeAtomicJson(afterPath, after);
  const nativeChanged = compareSnapshotFiles(beforePath, afterPath);
  assert.equal(nativeChanged.matched, false);
  assert.ok(nativeChanged.differences.some((row) => row.key.includes('native.jetstream-config')));
});

test('fails closed for an ambiguous active Electron process and leaves no output', async () => {
  const directory = privateDirectory();
  const bad = cloneFixture();
  bad.payload.electron.process.candidateCount = 2;
  const ssh = fakeSsh(directory, bad);
  const output = path.join(directory, 'receipt.json');
  await assert.rejects(
    collect({ host: 'fixture-host', slot: 'fixture-slot', out: output, sshBin: ssh.scriptPath }),
    /ambiguous/
  );
  assert.equal(fs.existsSync(output), false);
});

test('fails closed for a missing immutable artifact and preserves an existing receipt', async () => {
  const directory = privateDirectory();
  const bad = cloneFixture();
  bad.payload.ssm.skillMain.path = '';
  const ssh = fakeSsh(directory, bad);
  const output = path.join(directory, 'receipt.json');
  const original = Buffer.from('{"previous":true}\n');
  fs.writeFileSync(output, original, { mode: 0o600 });
  await assert.rejects(
    collect({ host: 'fixture-host', slot: 'fixture-slot', out: output, sshBin: ssh.scriptPath }),
    /ssm\.skillMain\.path is missing/
  );
  assert.deepEqual(fs.readFileSync(output), original);
});

test('fails closed when the report-asset audit digest does not bind its rows', async () => {
  const directory = privateDirectory();
  const bad = cloneFixture();
  bad.payload.nimbus.assets.auditSha256 = '0'.repeat(64);
  const ssh = fakeSsh(directory, bad);
  const output = path.join(directory, 'receipt.json');
  await assert.rejects(
    collect({ host: 'fixture-host', slot: 'fixture-slot', out: output, sshBin: ssh.scriptPath }),
    /auditSha256 does not bind sorted report-asset rows/
  );
  assert.equal(fs.existsSync(output), false);
});

test('fixture test never invokes the real ssh binary', async () => {
  const directory = privateDirectory();
  const ssh = fakeSsh(directory, fixture);
  const output = path.join(directory, 'receipt.json');
  await collect({ host: 'fixture-host', slot: 'fixture-slot', out: output, sshBin: ssh.scriptPath });
  assert.equal(fs.readFileSync(ssh.logPath, 'utf8').trim().split(/\s+/)[0], '-T');
});
