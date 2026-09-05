'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { gunzipSync } = require('node:zlib');
const test = require('node:test');
const { writeCapture, writeJSONToStream } = require('./capture-writer.cjs');
const driver = require('./driver.cjs');

class CollectingWritable extends Writable {
  constructor(options) {
    super({ highWaterMark: 1 });
    this.delayMs = options && options.delayMs || 0;
    this.chunks = [];
  }
  _write(chunk, encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    if (this.delayMs) setTimeout(callback, this.delayMs);
    else setImmediate(callback);
  }
  bytes() { return Buffer.concat(this.chunks).toString('utf8'); }
}

class FailingWritable extends Writable {
  _write(chunk, encoding, callback) { callback(new Error('intentional capture sink failure')); }
}

class PrematureCloseWritable extends Writable {
  constructor() { super({ highWaterMark: 1 }); }
  _write(chunk, encoding, callback) { this.destroy(); }
}

function settlesWithin(promise, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('capture writer did not settle')), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

function equivalentReport() {
  const report = {
    schemaVersion: 2,
    text: 'line\nquote " slash \\ emoji 😀',
    numbers: [0, -0, NaN, Infinity, -Infinity],
    omissions: { undefinedValue: undefined, functionValue: function ignored() {}, symbolValue: Symbol('ignored') },
    arrayUndefined: [undefined, function ignored() {}, Symbol('array-null')],
    nested: { order: ['first', 'second'], object: { value: 7 } },
  };
  const custom = {};
  Object.defineProperty(custom, 'toJSON', { enumerable: false, value: function(key) { return { key, output: [undefined, 'ok'] }; } });
  report.custom = custom;
  return report;
}

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'capture-writer-')); }
function removeDir(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

test('incremental JSON is byte-equivalent for bounded values and preserves omission/null semantics', async () => {
  const report = equivalentReport();
  const expected = JSON.stringify(report) + '\n';
  const stream = new CollectingWritable({ delayMs: 1 });
  await writeJSONToStream(report, stream);
  assert.equal(stream.bytes(), expected);
});

test('plain and gzip capture round trips preserve the same JSON bytes', async () => {
  const dir = tempDir();
  try {
    const report = equivalentReport();
    const expected = JSON.stringify(report) + '\n';
    const plain = path.join(dir, 'capture.json');
    const compressed = path.join(dir, 'capture.json.gz');
    await writeCapture(plain, report);
    await writeCapture(compressed, report);
    assert.equal(fs.readFileSync(plain, 'utf8'), expected);
    assert.equal(gunzipSync(fs.readFileSync(compressed)).toString('utf8'), expected);
  } finally { removeDir(dir); }
});

test('backpressure is awaited and sink failures reject the capture', async () => {
  const report = { cases: Array.from({ length: 200 }, (_, index) => ({ id: index, value: 'x'.repeat(512) })) };
  const stream = new CollectingWritable({ delayMs: 1 });
  await writeJSONToStream(report, stream);
  assert.deepEqual(JSON.parse(stream.bytes()), report);
  await assert.rejects(writeJSONToStream(report, new FailingWritable()), /intentional capture sink failure/);
});

test('close before finish rejects promptly and removes the pending drain listener', async () => {
  const stream = new PrematureCloseWritable();
  const report = { cases: [{ value: 'x'.repeat(50000) }] };
  await assert.rejects(settlesWithin(writeJSONToStream(report, stream), 1000), /Premature close/);
  assert.equal(stream.listenerCount('drain'), 0);
  assert.equal(stream.listenerCount('finish'), 0);
  assert.equal(stream.listenerCount('close'), 0);
  assert.equal(stream.listenerCount('error'), 0);
});

test('an already-destroyed stream rejects without waiting for an event', async () => {
  const stream = new CollectingWritable();
  stream.destroy();
  await assert.rejects(settlesWithin(writeJSONToStream({ cases: [{ value: 'x' }] }, stream), 1000), /Premature close/);
  assert.equal(stream.listenerCount('drain'), 0);
});

test('asynchronous silent destruction settles a backpressured capture', async () => {
  const stream = new Writable({
    highWaterMark: 1,
    emitClose: false,
    write(_chunk, _encoding, _callback) {
      setImmediate(() => this.destroy());
    },
  });
  await assert.rejects(settlesWithin(writeJSONToStream({ value: 'pending' }, stream), 1000), /Premature close/);
  for (const event of ['drain', 'finish', 'close', 'error']) assert.equal(stream.listenerCount(event), 0);
});

test('Unicode at chunk boundaries remains byte-equivalent to JSON.stringify', async () => {
  const filler = 'x'.repeat(16383);
  const report = {
    pair: filler + '\ud83d\ude00' + 'tail',
    escaped: filler + '\n"\\\t\b\f\r' + 'tail',
    unpairedHigh: filler + '\ud800' + 'tail',
    unpairedLow: filler + '\udc00' + 'tail',
  };
  const expected = Buffer.from(JSON.stringify(report) + '\n');
  const stream = new CollectingWritable({ delayMs: 1 });
  await writeJSONToStream(report, stream);
  assert.deepEqual(Buffer.concat(stream.chunks), expected);
});

test('driver run awaits the capture writer before resolving', async () => {
  const dir = tempDir();
  try {
    const out = path.join(dir, 'driver.json.gz');
    const suite = { id: 'writer-test', profile: 'writer-test', effectDrainMs: 0, cases: [{ id: 'one', clock: '2018-05-30T12:00:00Z', seed: 1 }], contexts: { known: {} } };
    const adapter = { name: 'writer-test', moduleFile: __filename, async start() { return { metadata: {}, async close() {} }; } };
    const report = await driver.run(adapter, suite, out);
    assert.equal(report.captureComplete, true);
    assert.deepEqual(JSON.parse(gunzipSync(fs.readFileSync(out))), report);
    await assert.rejects(driver.run(adapter, suite, path.join(dir, 'missing', 'capture.json')), /ENOENT/);
  } finally { removeDir(dir); }
});
