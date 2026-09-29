// The stock robot's MMS uploads an encrypted stream with UNSIGNED-PAYLOAD.
// Exercise the public Classic caller boundary, not the LAN-trust Media fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSigV4 } from '@phoenix/common';
import { createClassicEntrypoint, createVerifiedClassicCaller } from '../src/index.js';
import { MediaStore } from '../src/media.js';

const ACCOUNT = '5a0b20f5ddee0000197e2880';
const LOOP = '5a0b20f5ddee0000197e2881';
const ACCESS_KEY = 'ROBOTMEDIATESTKEY';
const SECRET_KEY = 'robot-media-fixture-secret';

function signedHeaders({ target, body, path = '/', extra = {} }) {
  return signSigV4({
    method: 'POST', path, body,
    headers: {
      Host: 'api.jibo.io',
      'Content-Type': target === 'Media_20160725.Create' ? 'application/octet-stream' : 'application/x-amz-json-1.1',
      'Transfer-Encoding': 'chunked',
      'X-Amz-Target': target,
      ...extra,
    },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY,
    region: 'us-east-1',
    service: 'media',
  }).headers;
}

function post(port, headers, body) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method: 'POST', path: '/', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let payload;
        try { payload = JSON.parse(raw); } catch { payload = raw; }
        resolve({ status: res.statusCode, body: payload, headers: res.headers });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    // Explicit chunks plus Transfer-Encoding mimic the MMS stream; there is no file path or
    // Content-Length for the signer to hash ahead of time.
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const middle = Math.max(1, Math.floor(bytes.length / 2));
    req.write(bytes.subarray(0, middle));
    req.end(bytes.subarray(middle));
  });
}

test('signed chunked Media.Create with UNSIGNED-PAYLOAD reaches storage and remains HMAC-protected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phoenix-signed-media-'));
  const store = new MediaStore({ directory: join(dir, 'objects'), file: join(dir, 'media.json') });
  const account = { _id: ACCOUNT, friendlyId: 'Moth-Fixture', accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET_KEY, isActive: true };
  const callerBoundary = createVerifiedClassicCaller({
    resolveCredentials: (key) => key === ACCESS_KEY ? account : null,
    allowNativeClientPayloadHash: true,
  });
  const service = createClassicEntrypoint({
    publicUrl: 'https://api.jibo.io', callerBoundary,
    media: { store, loops: {
      members: (loopId) => loopId === LOOP ? [ACCOUNT] : [],
      accountLoops: (accountId) => accountId === ACCOUNT ? [LOOP] : [],
      ownedLoops: () => [],
    } },
  });
  const server = await service.listen(0);
  const port = server.address().port;
  try {
    const bytes = Buffer.from('encrypted-photo-chunk-one::encrypted-photo-chunk-two');
    const headers = signedHeaders({ target: 'Media_20160725.Create', body: bytes, extra: {
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
      'X-Loop-Id': LOOP,
      'X-Path': 'photo-unsigned-stream',
      'X-Type': 'image',
      'X-Encrypted': 'true',
    } });
    assert.match(headers.Authorization, /SignedHeaders=[^,]*x-amz-target/);
    const created = await post(port, headers, bytes);
    assert.equal(created.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.path, 'photo-unsigned-stream');
    assert.equal(created.body.loopId, LOOP);
    assert.equal(created.body.isEncrypted, true);
    assert.deepEqual(await readFile(store.objectFile('photo-unsigned-stream')), bytes);

    const listBody = JSON.stringify({ loopIds: [LOOP] });
    const listed = await post(port, signedHeaders({ target: 'Media_20160725.List', body: listBody }), listBody);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.ok(listed.body.some((item) => item.path === 'photo-unsigned-stream'));

    const tampered = await post(port, { ...headers, 'X-Path': 'photo-tampered-after-signing' }, bytes);
    assert.equal(tampered.status, 401);
    assert.equal(tampered.body.__type, 'SIGNATURE_MISMATCH');
    assert.equal(store.find('photo-tampered-after-signing'), null);

    const retargeted = await post(port, { ...headers, 'X-Amz-Target': 'Media_20160725.List' }, bytes);
    assert.equal(retargeted.status, 401);
    assert.equal(retargeted.body.__type, 'SIGNATURE_MISMATCH');

    const deniedPath = 'photo-other-loop';
    const denied = await post(port, signedHeaders({ target: 'Media_20160725.Create', body: bytes, extra: {
      'X-Amz-Content-Sha256': 'UNSIGNED-PAYLOAD',
      'X-Loop-Id': 'unrelated-loop',
      'X-Path': deniedPath,
    } }), bytes);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.__type, 'MEDIA_MUST_BE_MEMBER');
    assert.equal(store.find(deniedPath), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
