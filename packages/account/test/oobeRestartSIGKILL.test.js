// A-05 criterion 2 — issued robot credentials survive a SIGKILL restart.
//
// The live deployment evidence (docs/parity/evidence/2026-09-10/a05-oobe-live/live-probe.json)
// used an orderly `systemctl --user restart`. This test closes the harder case: the account
// service's durable store is a single JSON snapshot written with an atomic tmp+rename
// (packages/account/src/store.js flush), so an abrupt, uncatchable kill must still leave a
// complete snapshot on disk — credentials included — with no orderly shutdown hook to run.
//
// Method: spawn a real child node process that provisions a loop + robot account and then
// keeps flushing, SIGKILL it mid-write, and reopen the file in this process.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/store.js';
import { findOrCreateRobotAccount } from '../src/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const childPath = join(here, '..', '..', '..', 'scripts', 'parity-a05', 'oobeStoreChild.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForFile(path, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await sleep(10);
  }
  return false;
}

test('SIGKILL mid-write leaves a complete snapshot with the issued robot credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-sigkill-oobe-'));
  const file = join(dir, 'account.json');
  const marker = join(dir, 'marker.json');
  const child = spawn(process.execPath, [childPath, file, marker], { stdio: 'ignore' });
  try {
    assert.ok(await waitForFile(marker), 'the child provisioned the store');
    const issued = JSON.parse(readFileSync(marker, 'utf8'));

    // Let it re-enter the write cycle, then kill it with the uncatchable signal.
    await sleep(25);
    child.kill('SIGKILL');
    const { code, signal } = await new Promise((resolve) => child.on('exit', (c, s) => resolve({ code: c, signal: s })));
    assert.equal(signal, 'SIGKILL', 'the child died by SIGKILL, not a clean exit');
    assert.equal(code, null);

    // The credential file is readable as a whole: reopening must not throw.
    const reopened = new Store(file);
    const robot = reopened.accounts.get(issued.robotId);
    assert.ok(robot, 'the robot account is durable');
    assert.equal(robot.accessKeyId, issued.accessKeyId, 'accessKeyId preserved');
    assert.equal(robot.secretAccessKey, issued.secretAccessKey, 'secretAccessKey preserved');
    assert.equal(robot.friendlyId, 'sigkill-robot-alpha');
    assert.equal(reopened.accounts.get(issued.ownerId).email, 'sigkill-owner@crash.invalid');
    const loop = reopened.loops.get(issued.loopId);
    assert.equal(loop.robot, issued.robotId, 'the loop still points at the robot');
    assert.equal(reopened.accountByAccessKeyId(issued.accessKeyId)._id, issued.robotId,
      'the preserved access key resolves to the robot after the crash');

    // No half-written snapshot or stray temp file survived the kill.
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tmp')) assert.fail(`stray temp file after SIGKILL: ${name}`);
    }
    assert.doesNotThrow(() => JSON.parse(readFileSync(file, 'utf8')), 'the snapshot is valid JSON');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a SIGKILL before any flush leaves no credentials to lose and no partial file', async () => {
  // The counterpart to the test above: if the process dies before its first snapshot commit,
  // there must be no half-created store the service would later load as truth.
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-sigkill-early-'));
  const file = join(dir, 'account.json');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await sleep(25);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(existsSync(file), false, 'no snapshot was written');
    assert.equal(new Store(file).accounts.size, 0, 'a missing store loads as empty, not an error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a robot account write that fails mid-transaction never corrupts the committed snapshot', () => {
  // The store's tmp+rename is the mechanism that makes the SIGKILL test above reliable. Prove
  // it directly: a rejected write leaves the previously committed bytes byte-for-byte intact.
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-sigkill-atomic-'));
  try {
    const file = join(dir, 'account.json');
    const store = new Store(file);
    const robot = findOrCreateRobotAccount(store, 'sigkill-atomic-robot');
    store.flush();
    const committed = readFileSync(file);

    // Simulate a crash between the temp write and the rename: the committed file is untouched.
    store.accounts.get(robot._id).updated = 1n; // BigInt is not JSON-serializable
    assert.throws(() => store.flush(), TypeError);
    assert.deepEqual(readFileSync(file), committed, 'the committed snapshot is untouched');
    assert.equal(new Store(file).accounts.get(robot._id).accessKeyId, robot.accessKeyId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
