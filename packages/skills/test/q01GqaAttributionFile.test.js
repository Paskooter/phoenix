import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createGqaFileAttributionStore,
  GQA_ATTRIBUTE_DEFAULT_FILE,
} from '../src/gqaAccountAttribution.js';

const NOW = 1700000000000;
const DAY_MS = 24 * 60 * 60 * 1000;

function tempFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-q01-attribution-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'attribution.json');
}

test('file attribution preserves source records, windows, insertion order, and restart state', async (t) => {
  const file = tempFile(t);
  const store = createGqaFileAttributionStore({ file, clock: () => NOW });
  await store.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/a', null, 'loop-1');
  await store.insert('Wolfram Alpha', ['A', 'fixture', 2], 'https://fixture.invalid/b', 'https://fixture.invalid/b.jpg', 'loop-1');
  await store.insert('Bing', 'Other loop.', 'https://fixture.invalid/c', null, 'loop-2');

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(await store.search('loop-1', undefined, NOW + 1, NOW - 1), [
    {
      service: 'Bing',
      query: 'A fixture answer.',
      url: 'https://fixture.invalid/a',
      image_url: null,
      loop_id: 'loop-1',
      timestamp: NOW,
    },
    {
      service: 'Wolfram Alpha',
      query: ['A', 'fixture', 2],
      url: 'https://fixture.invalid/b',
      image_url: 'https://fixture.invalid/b.jpg',
      loop_id: 'loop-1',
      timestamp: NOW,
    },
  ]);
  assert.deepEqual(await store.search('loop-1', 'Bing', String(NOW + 1), NOW - 1), []);
  assert.equal((await store.search('loop-1', undefined, false, NOW - 1)).length, 2);

  const restarted = createGqaFileAttributionStore({ file, clock: () => NOW });
  assert.deepEqual(restarted.snapshot(), store.snapshot());
  assert.deepEqual(await restarted.search('loop-1', 'Wolfram Alpha', NOW + 1, NOW - 1), [
    {
      service: 'Wolfram Alpha',
      query: ['A', 'fixture', 2],
      url: 'https://fixture.invalid/b',
      image_url: 'https://fixture.invalid/b.jpg',
      loop_id: 'loop-1',
      timestamp: NOW,
    },
  ]);

  // The file format itself contains only the local source-shaped records and
  // no account credentials or robot-identifying fixture data.
  const persisted = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(persisted), ['version', 'records']);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.records.length, 3);
});

test('file attribution applies the source 90-day floor and 50-row insertion-order limit', async (t) => {
  const file = tempFile(t);
  const store = createGqaFileAttributionStore({ file, clock: () => NOW });
  for (let index = 0; index < 55; index += 1) {
    await store.insert('Bing', `answer-${index}`, `https://fixture.invalid/${index}`, null, 'loop-1');
  }
  const result = await store.search('loop-1', 'Bing', NOW + 1, NOW - DAY_MS);
  assert.equal(result.length, 50);
  assert.equal(result[0].query, 'answer-0');
  assert.equal(result.at(-1).query, 'answer-49');

  const old = createGqaFileAttributionStore({ file: tempFile(t), clock: () => NOW });
  await old.insert('Bing', 'old answer', 'https://fixture.invalid/old', null, 'loop-1');
  const raw = JSON.parse(readFileSync(old.file, 'utf8'));
  raw.records[0].timestamp = NOW - (91 * DAY_MS);
  writeFileSync(old.file, `${JSON.stringify(raw)}\n`);
  const recovered = createGqaFileAttributionStore({ file: old.file, clock: () => NOW });
  assert.deepEqual(await recovered.search('loop-1', 'Bing', NOW + 1, 0), []);
});

test('file attribution rejects corruption without rewriting the destination', (t) => {
  const file = tempFile(t);
  writeFileSync(file, '{');
  assert.throws(
    () => createGqaFileAttributionStore({ file, clock: () => NOW }),
    /GQA attribution store unreadable/,
  );

  writeFileSync(file, JSON.stringify({ version: 1, records: {} }));
  assert.throws(
    () => createGqaFileAttributionStore({ file, clock: () => NOW }),
    /GQA attribution store has invalid records/,
  );
});

test('file attribution requires the known snapshot version and records array', (t) => {
  const cases = [
    {
      snapshot: { records: [] },
      error: /GQA attribution store has an unsupported or missing version/,
    },
    {
      snapshot: { version: 2, records: [] },
      error: /GQA attribution store has an unsupported or missing version/,
    },
    {
      snapshot: { version: 1 },
      error: /GQA attribution store has invalid records.*missing/,
    },
    {
      snapshot: { version: 1, records: {} },
      error: /GQA attribution store has invalid records.*not an array/,
    },
  ];
  for (const { snapshot, error } of cases) {
    const file = tempFile(t);
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`);
    assert.throws(
      () => createGqaFileAttributionStore({ file, clock: () => NOW }),
      error,
    );
  }
});

test('file attribution rejects records missing any source field', (t) => {
  const fields = ['service', 'query', 'url', 'image_url', 'loop_id', 'timestamp'];
  for (const missing of fields) {
    const file = tempFile(t);
    const record = {
      service: 'Bing',
      query: 'A fixture answer.',
      url: 'https://fixture.invalid/a',
      image_url: null,
      loop_id: 'loop-1',
      timestamp: NOW,
    };
    delete record[missing];
    writeFileSync(file, JSON.stringify({ version: 1, records: [record] }));
    assert.throws(
      () => createGqaFileAttributionStore({ file, clock: () => NOW }),
      new RegExp(`GQA attribution store record is missing '${missing}'`),
    );
  }
});

test('file attribution hardens an existing file without changing its parent mode', (t) => {
  const file = tempFile(t);
  writeFileSync(file, JSON.stringify({ version: 1, records: [] }), { mode: 0o644 });
  chmodSync(file, 0o644);
  const parent = dirname(file);
  const parentMode = statSync(parent).mode & 0o777;
  const chmodCalls = [];
  createGqaFileAttributionStore({
    file,
    clock: () => NOW,
    persistence: {
      chmod(path, mode) {
        chmodCalls.push({ path, mode });
        chmodSync(path, mode);
      },
    },
  });
  assert.deepEqual(chmodCalls, [{ path: file, mode: 0o600 }]);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(parent).mode & 0o777, parentMode);
});

test('file attribution rolls back a failed write and leaves no partial snapshot', async (t) => {
  const file = tempFile(t);
  const initial = createGqaFileAttributionStore({ file, clock: () => NOW });
  await initial.insert('Bing', 'A fixture answer.', 'https://fixture.invalid/a', null, 'loop-1');
  const before = readFileSync(file, 'utf8');

  const failing = createGqaFileAttributionStore({
    file,
    clock: () => NOW,
    persistence: {
      writeFile(path) {
        writeFileSync(path, 'partial snapshot');
        throw new Error('fixture disk full');
      },
    },
  });
  await assert.rejects(
    failing.insert('Bing', 'A second fixture answer.', 'https://fixture.invalid/b', null, 'loop-1'),
    /fixture disk full/,
  );
  assert.deepEqual(failing.snapshot(), initial.snapshot());
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(dirname(file)), ['attribution.json']);

  const restarted = createGqaFileAttributionStore({ file, clock: () => NOW });
  assert.deepEqual(restarted.snapshot(), initial.snapshot());
});

test('factory defaults to a stable private temporary path when no file is supplied', () => {
  const store = createGqaFileAttributionStore({ clock: () => NOW });
  assert.equal(store.file, process.env.ETCO_gqa_attributionFile || GQA_ATTRIBUTE_DEFAULT_FILE);
});
