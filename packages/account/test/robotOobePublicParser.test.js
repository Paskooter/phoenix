// A-05 — the public OOBE gateway receives the original entity before the
// downstream Hapi-compatible parser. These requests deliberately use
// node:http so the missing Content-Type case cannot be hidden by fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { deflateSync, gzipSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountService, Store } from '../src/index.js';
import { createOwnerAccount } from '../src/model.js';

const OOBE_MAX_PAYLOAD_BYTES = 1024 * 1024;

function post(port, body, contentType, extraHeaders = {}) {
  const entity = body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = {
    host: `127.0.0.1:${port}`,
    'x-amz-target': 'OOBE_20161026.GetStatus',
    connection: 'close',
    'content-length': String(entity.length),
    ...extraHeaders,
  };
  if (contentType !== undefined) headers['content-type'] = contentType;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = rawBody === '' ? null : JSON.parse(rawBody); }
        catch { parsed = undefined; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody,
          sentHeaders: req.getHeaders(),
        });
      });
    });
    req.on('error', reject);
    req.end(entity);
  });
}

function postChunked(port, body, contentType, extraHeaders = {}) {
  const entity = body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = {
    host: `127.0.0.1:${port}`,
    'x-amz-target': 'OOBE_20161026.GetStatus',
    connection: 'close',
    'transfer-encoding': 'chunked',
    ...extraHeaders,
  };
  if (contentType !== undefined) headers['content-type'] = contentType;

  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      method: 'POST',
      path: '/',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = rawBody === '' ? null : JSON.parse(rawBody); }
        catch { parsed = undefined; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed,
          rawBody,
          sentHeaders: req.getHeaders(),
        });
      });
    });
    req.on('error', reject);
    // Explicit chunked framing ensures there is no declared length for the
    // bounded reader to trust. Multiple writes exercise its per-chunk count.
    for (let offset = 0; offset < entity.length; offset += 64 * 1024) {
      req.write(entity.subarray(offset, Math.min(entity.length, offset + 64 * 1024)));
    }
    req.end();
  });
}

test('OOBE public parser matches source media and entity boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-oobe-public-parser-'));
  const store = new Store(join(dir, 'store.json'));
  createOwnerAccount(store, { email: 'oobe-public-parser@synthetic.invalid', password: 'synthetic-password' });
  const service = createAccountService({ store });
  const server = await service.listen(0);
  const port = server.address().port;
  try {
    const missingContentType = await post(port, '{"token":"synthetic"}');
    assert.equal(missingContentType.sentHeaders['content-type'], undefined,
      'node:http sent no Content-Type header');
    assert.equal(missingContentType.status, 200);
    assert.deepEqual(missingContentType.body, { complete: true });

    const vendorJson = await post(port, '{"token":"synthetic"}', 'application/vnd.synthetic+json');
    assert.equal(vendorJson.status, 200);
    assert.deepEqual(vendorJson.body, { complete: true });

    const malformedVendor = await post(port, '{', 'application/vnd.synthetic+json');
    assert.equal(malformedVendor.status, 400);
    assert.deepEqual(malformedVendor.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid request payload JSON format',
    });

    const validText = await post(port, '{"token":"synthetic"}', 'text/html');
    assert.equal(validText.status, 200);
    assert.deepEqual(validText.body, { complete: true });

    const malformedText = await post(port, '{', 'text/plain');
    assert.equal(malformedText.status, 422);
    assert.equal(malformedText.body.statusCode, 422);
    assert.equal(malformedText.body.error, 'Unprocessable Entity');

    const form = await post(port, 'token=synthetic', 'application/x-www-form-urlencoded');
    assert.equal(form.status, 200);
    assert.deepEqual(form.body, { complete: true });

    const binary = await post(port, Buffer.from('{"token":"synthetic"}'), 'application/octet-stream');
    assert.equal(binary.status, 422);
    assert.equal(binary.body.message, 'child "token" fails because ["token" is required]');

    const invalidContentType = await post(port, '{"token":"synthetic"}', 'invalid');
    assert.equal(invalidContentType.status, 400);
    assert.deepEqual(invalidContentType.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid content-type header',
    });

    const amzWithParameter = await post(port, '{"token":"synthetic"}', 'application/x-amz-json-1.1; charset=utf-8');
    assert.equal(amzWithParameter.status, 415);
    assert.deepEqual(amzWithParameter.body, {
      statusCode: 415,
      error: 'Unsupported Media Type',
      message: 'Unsupported Media Type',
    });

    for (const [encoding, encode] of [['gzip', gzipSync], ['deflate', deflateSync]]) {
      const decoded = await post(port, encode(Buffer.from('{"token":"synthetic"}')), 'application/json', {
        'content-encoding': encoding,
      });
      assert.equal(decoded.status, 200, `${encoding} status`);
      assert.deepEqual(decoded.body, { complete: true }, `${encoding} body`);
    }

    const invalidCompression = await post(port, Buffer.from('{"token":"synthetic"}'), 'application/json', {
      'content-encoding': 'gzip',
    });
    assert.equal(invalidCompression.status, 400);
    assert.deepEqual(invalidCompression.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Invalid compressed payload',
    });

    const oversized = await post(port, JSON.stringify({ token: 'x'.repeat(OOBE_MAX_PAYLOAD_BYTES) }), 'application/json');
    assert.equal(oversized.status, 400);
    assert.deepEqual(oversized.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Payload content length greater than maximum allowed: 1048576',
    });

    const compressedOversized = await post(
      port,
      gzipSync(Buffer.alloc(OOBE_MAX_PAYLOAD_BYTES + 1, 0x20)),
      'application/json',
      { 'content-encoding': 'gzip' },
    );
    assert.equal(compressedOversized.status, 400);
    assert.deepEqual(compressedOversized.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Payload content length greater than maximum allowed: 1048576',
    });

    const chunkedOversized = await postChunked(
      port,
      Buffer.alloc(OOBE_MAX_PAYLOAD_BYTES + 1, 0x20),
      'application/json',
    );
    assert.equal(chunkedOversized.sentHeaders['content-length'], undefined,
      'chunked request has no Content-Length header');
    assert.equal(chunkedOversized.sentHeaders['transfer-encoding'], 'chunked');
    assert.equal(chunkedOversized.status, 400);
    assert.deepEqual(chunkedOversized.body, {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Payload content length greater than maximum allowed: 1048576',
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
