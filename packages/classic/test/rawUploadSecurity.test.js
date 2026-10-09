// Raw Backup/Log/Media uploads: byte caps, 413 without publishing, atomic replacement.
// Synthetic data only (re-ported from the September week-review hardening).
import { readdir, readFile, rm, mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackupStore,
  LogStore,
  MediaStore,
  createClassicEntrypoint,
} from '../src/index.js';

async function allFiles(root) {
  const output = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function assertNoTemporaryFiles(root) {
  const files = await allFiles(root);
  assert.deepEqual(files.filter((path) => path.endsWith('.tmp')), [], 'failed uploads leave no temporary file');
}

async function* interruptedUpload() {
  yield Buffer.from('partial-upload');
  throw new Error('synthetic upload interruption');
}

function chunkedOversize() {
  return Readable.from([Buffer.from('123'), Buffer.from('456')]);
}

function interrupted() {
  return Readable.from(interruptedUpload());
}

function requestChunks(port, method, path, headers, chunks) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (response) => {
      const body = [];
      response.on('data', (chunk) => body.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(body) }));
    });
    request.on('error', reject);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

test('HTTP chunked oversize Backup, Log, and Media uploads return 413 without publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-http-raw-limit-'));
  const entrypoint = createClassicEntrypoint({
    publicUrl: 'http://127.0.0.1:1',
    backup: { dir: join(root, 'backup'), maxBytes: 5, bearerSecret: 'raw-upload-test-secret' },
    log: { dir: join(root, 'log'), maxBytes: 5 },
    media: { directory: join(root, 'media-objects'), file: join(root, 'media.json'), maxBytes: 5 },
  });
  const server = await entrypoint.listen(0);
  const port = server.address().port;
  try {
    const chunks = [Buffer.from('123'), Buffer.from('456')];
    const backupUrl = new URL(entrypoint.backups.signedBlobUrl(`http://127.0.0.1:${port}`, 'PUT', 'loop-a', 'backup-key').url);
    const backup = await requestChunks(port, 'PUT', `${backupUrl.pathname}${backupUrl.search}`, {}, chunks);
    assert.equal(backup.status, 413);
    const log = await requestChunks(port, 'PUT', '/log/upload?key=log-key', {}, chunks);
    assert.equal(log.status, 413);
    const media = await requestChunks(port, 'POST', '/', {
      'content-type': 'application/octet-stream',
      'x-amz-target': 'Media_20160725.Create',
      'x-loop-id': 'loop-a',
      'x-type': 'image',
      'x-path': 'media-path',
    }, chunks);
    assert.equal(media.status, 413);
    assert.equal(entrypoint.backups.find('loop-a', 'backup-key'), null);
    assert.equal(entrypoint.logStore.find('log-key'), null);
    assert.equal(entrypoint.mediaStore.find('media-path'), null);
    await assertNoTemporaryFiles(root);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
test('raw Backup, Log, and Media stores reject chunked uploads over their byte cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-raw-limit-'));
  try {
    const backup = new BackupStore(join(root, 'backup'), { maxBytes: 5 });
    const log = new LogStore(join(root, 'log'), { maxBytes: 5 });
    const media = new MediaStore({
      directory: join(root, 'media-objects'),
      file: join(root, 'media.json'),
      maxBytes: 5,
    });
    const record = { path: 'media-path', type: 'image', accountId: 'account-a', loopId: 'loop-a', thumbs: [] };

    await assert.rejects(
      backup.put('loop-a', 'backup-key', chunkedOversize()),
      (error) => error.statusCode === 413 && error.limit === 5,
    );
    await assert.rejects(
      log.put('log-key', chunkedOversize()),
      (error) => error.statusCode === 413 && error.limit === 5,
    );
    await assert.rejects(
      media.putObject(record, chunkedOversize()),
      (error) => error.statusCode === 413 && error.limit === 5,
    );

    assert.equal(backup.find('loop-a', 'backup-key'), null);
    assert.equal(log.find('log-key'), null);
    assert.equal(media.find('media-path'), null);
    await assertNoTemporaryFiles(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('interrupted raw uploads keep the previous object atomically and remove temp files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-raw-interrupted-'));
  try {
    const backup = new BackupStore(join(root, 'backup'), { maxBytes: 128 });
    const log = new LogStore(join(root, 'log'), { maxBytes: 128 });
    const media = new MediaStore({
      directory: join(root, 'media-objects'),
      file: join(root, 'media.json'),
      maxBytes: 128,
    });
    const mediaRecord = { path: 'media-path', type: 'image', accountId: 'account-a', loopId: 'loop-a', thumbs: [] };

    await backup.put('loop-a', 'backup-key', Readable.from(Buffer.from('backup-before')));
    await log.put('log-key', Readable.from(Buffer.from('log-before')));
    await media.putObject(mediaRecord, Readable.from(Buffer.from('media-before')));

    await assert.rejects(() => backup.put('loop-a', 'backup-key', interrupted()), /synthetic upload interruption/);
    await assert.rejects(() => log.put('log-key', interrupted()), /synthetic upload interruption/);
    await assert.rejects(() => media.putObject(mediaRecord, interrupted()), /synthetic upload interruption/);

    assert.equal(await readFile(join(root, 'backup', 'loop-a', 'backup-key'), 'utf8'), 'backup-before');
    assert.equal(await readFile(join(root, 'log', 'log-key'), 'utf8'), 'log-before');
    assert.equal(await readFile(join(root, 'media-objects', 'account-a', 'media-path.jpg'), 'utf8'), 'media-before');
    assert.equal(backup.find('loop-a', 'backup-key').size, 'backup-before'.length);
    assert.equal(log.find('log-key').size, 'log-before'.length);
    assert.equal(media.find('media-path').path, 'media-path');
    await assertNoTemporaryFiles(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
