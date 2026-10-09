// An Account/Loop photo upload whose declared Content-Length exceeds Account's photo route limit
// answers Account's reference 400 on the authenticated entrypoint too. No body bytes are read; a
// size refusal under a smaller boundary cap keeps the boundary's 413.
//
// All accounts and keys are SYNTHETIC test values.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syntheticAccount, writeSyntheticAccountStore } from './fixtures/signedClassic.js';
import { createClassicEntrypoint, createVerifiedClassicCaller } from '../src/index.js';

const REFERENCE_400 = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'Payload content length greater than maximum allowed: 1000000000',
};

async function entrypoint(t, { maxBodyBytes } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-photo-length-'));
  const store = writeSyntheticAccountStore(join(dir, 'account.json'), { accounts: [syntheticAccount('synthetic-photo-owner')] });
  const callerBoundary = createVerifiedClassicCaller({
    resolveCredentials: (accessKeyId) => store.accountByAccessKeyId(accessKeyId),
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
  });
  const server = await createClassicEntrypoint({
    publicUrl: 'https://classic.synthetic.test',
    callerBoundary,
    notificationFile: join(dir, 'notifications.json'),
  }).listen(0, '127.0.0.1');
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  return server.address().port;
}

/** Send only the request head with a declared length; the server must answer without the body. */
function declareOnly(port, target, contentLength) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/',
      headers: { 'content-type': 'application/octet-stream', 'x-amz-target': target, 'content-length': String(contentLength) },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        req.destroy();
        let body = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.flushHeaders();
  });
}

test('an oversize declared photo upload answers Account\'s reference 400 behind the caller boundary', async (t) => {
  const port = await entrypoint(t);
  for (const target of ['Loop_20160602.UpdateMemberPhoto', 'Account_20160715.UpdatePhoto']) {
    const res = await declareOnly(port, target, 1_000_000_001);
    assert.equal(res.status, 400, target);
    assert.deepEqual(res.body, REFERENCE_400, target);
  }
});

test('a smaller boundary cap keeps its 413 for photo uploads and other uploads', async (t) => {
  const port = await entrypoint(t, { maxBodyBytes: 10 });
  const photo = await declareOnly(port, 'Account_20160715.UpdatePhoto', 11);
  assert.equal(photo.status, 413);
  assert.equal(photo.body.__type, 'PAYLOAD_TOO_LARGE');
  const media = await declareOnly(port, 'Media_20160725.Create', 11);
  assert.equal(media.status, 413);
});
