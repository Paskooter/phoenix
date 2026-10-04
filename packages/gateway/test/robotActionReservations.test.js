import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RobotActionReservations } from '../src/robotActionReservations.js';

const identity = { id: 'synthetic-durable-robot', accessKeyId: 'synthetic-durable-key', friendlyId: 'synthetic-durable-name' };

test('private UUID-only reservations fsync their new parent entry, file and directory and survive process recreation', t => {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const open = new Map(), synced = [];
  const fsImpl = { ...fs, openSync(path, ...options) {
    const fd = fs.openSync(path, ...options); open.set(fd, path); return fd;
  }, fsyncSync(fd) { synced.push(open.get(fd)); fs.fsyncSync(fd); } };
  const store = new RobotActionReservations({ runtimeDir, fsImpl });
  const requestId = randomUUID();
  assert.equal(store.reserve(identity, requestId), true);
  assert.ok(synced.includes(runtimeDir), 'the first mkdir entry must be persisted in its parent');
  assert.ok(synced.includes(store.directory));
  assert.ok(synced.some(path => path.endsWith('.tmp')));
  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file)), { version: 1, reservations: [{ identity, requestId }] });
  const recovered = new RobotActionReservations({ runtimeDir });
  assert.deepEqual([...recovered.entries.values()], [{ identity, requestId }]);
  assert.equal(recovered.clear(identity, requestId), true);
  assert.deepEqual([...new RobotActionReservations({ runtimeDir }).entries.values()], []);
});

test('rename or fsync clear failures retain uncertainty until a successful durable clear', t => {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-failure-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new RobotActionReservations({ runtimeDir });
  const requestId = randomUUID();
  assert.equal(store.reserve(identity, requestId), true);
  for (const method of ['renameSync', 'fsyncSync']) {
    store.fs = { ...fs, [method]() { throw new Error('synthetic persistence failure'); } };
    assert.equal(store.clear(identity, requestId), false);
    assert.equal(store.entries.size, 1);
    assert.equal(store.healthy, false);
    const recovered = new RobotActionReservations({ runtimeDir });
    assert.ok(recovered.loadFault || recovered.entries.size === 1, 'failed writes must retain startup uncertainty');
  }
  store.fs = fs;
  assert.equal(store.clear(identity, requestId), true);
  assert.equal(store.healthy, true);
});

test('invalid or unreadable startup records never become an empty healthy store', t => {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-invalid-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const initial = new RobotActionReservations({ runtimeDir });
  fs.writeFileSync(initial.file, 'invalid synthetic state', { mode: 0o600 });
  const invalid = new RobotActionReservations({ runtimeDir });
  assert.equal(invalid.loadFault, true);
  assert.equal(invalid.healthy, false);
  assert.equal(invalid.reserve(identity, randomUUID()), false);
  const unreadable = new RobotActionReservations({ runtimeDir, fsImpl: { ...fs, readFileSync() {
    throw new Error('synthetic read failure');
  } } });
  assert.equal(unreadable.loadFault, true);
  assert.equal(unreadable.healthy, false);
});

test('entry and Unicode byte overflow persist global uncertainty instead of RAM-only execution', t => {
  for (const options of [{ maxEntries: 1 }, { maxBytes: 512 }]) {
    const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-overflow-'));
    t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
    const store = new RobotActionReservations({ runtimeDir, ...options });
    assert.equal(store.reserve(identity, randomUUID()), true);
    const overflow = { id: 'synthetic-overflow', accessKeyId: '\u754c'.repeat(200), friendlyId: '\u754c'.repeat(200) };
    assert.equal(store.reserve(overflow, randomUUID()), false);
    assert.equal(store.healthy, false);
    const recovered = new RobotActionReservations({ runtimeDir, ...options });
    assert.equal(recovered.loadFault, false);
    assert.equal(recovered.unknown, true);
    assert.equal(recovered.healthy, false);
    assert.ok(fs.statSync(store.file).size <= store.maxBytes);
  }
});

test('post-rename directory fsync failure retains a startup quarantine marker', t => {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-directory-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new RobotActionReservations({ runtimeDir });
  const requestId = randomUUID();
  assert.equal(store.reserve(identity, requestId), true);
  let renamed = false;
  const opened = new Map();
  store.fs = { ...fs, openSync(path, ...args) { const fd = fs.openSync(path, ...args); opened.set(fd, path); return fd; },
    renameSync(...args) { fs.renameSync(...args); renamed = true; }, fsyncSync(fd) {
      if (renamed && opened.get(fd) === store.directory) throw new Error('synthetic post-rename directory fsync failure');
      fs.fsyncSync(fd);
    } };
  assert.equal(store.clear(identity, requestId), false);
  assert.equal(store.entries.size, 1);
  assert.equal(new RobotActionReservations({ runtimeDir }).loadFault, true);
  store.fs = fs;
  assert.equal(store.clear(identity, requestId), true);
  assert.equal(new RobotActionReservations({ runtimeDir }).healthy, true);
});

test('persistent failures reuse bounded local uncertainty files and successful proof cleanup removes them', t => {
  const runtimeDir = fs.mkdtempSync(join(tmpdir(), 'native-reservation-retry-'));
  t.after(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = new RobotActionReservations({ runtimeDir });
  const requestId = randomUUID();
  assert.equal(store.reserve(identity, requestId), true);
  store.fs = { ...fs, renameSync() { throw new Error('synthetic persistent rename failure'); } };
  for (let i = 0; i < 10; i++) {
    assert.equal(store.clear(identity, requestId), false);
    const files = fs.readdirSync(store.directory);
    assert.ok(files.length <= 3, 'retries cannot accumulate more than primary plus one local pair');
    assert.ok(store.failedTemps.size <= 2);
    const bytes = files.reduce((total, name) => total + fs.statSync(join(store.directory, name)).size, 0);
    assert.ok(bytes <= store.maxBytes * 2 + 64);
  }
  assert.equal(new RobotActionReservations({ runtimeDir }).loadFault, true);
  store.fs = fs;
  assert.equal(store.clear(identity, requestId), true);
  assert.deepEqual(fs.readdirSync(store.directory), ['outstanding.json']);
  assert.equal(store.failedTemps.size, 0);
  assert.equal(new RobotActionReservations({ runtimeDir }).healthy, true);
});
