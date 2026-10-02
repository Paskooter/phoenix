import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { LogStore, makeLogHandler, logHttpRoutes } from '../src/log.js';

test('disabled ASR audio retention refuses new and previously issued diagnostic uploads', async t => {
  const previous = process.env.ETCO_log_storeAsrAudio;
  process.env.ETCO_log_storeAsrAudio = 'false';
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-audio-policy-'));
  t.after(() => {
    if (previous === undefined) delete process.env.ETCO_log_storeAsrAudio; else process.env.ETCO_log_storeAsrAudio = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new LogStore(dir);
  const response = () => ({ writeHead(status) { this.status = status; }, end(body) { this.body = body; } });
  const res = response();
  makeLogHandler(store, () => 'https://example.test')({ req: { headers: {} }, res, body: { trackingId: 'synthetic-turn' }, op: 'PutAsrBinary' });
  assert.equal(res.status, 429);
  const upload = response();
  await logHttpRoutes(store)['PUT /log/upload']({ req: Readable.from([Buffer.from('synthetic-audio')]), res: upload, url: new URL('https://example.test/log/upload?key=asr-binary/old-upload.bin') });
  assert.equal(upload.status, 429);
  assert.deepEqual(readdirSync(dir), []);
});
