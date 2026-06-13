// H.5 — build-to-spec tier-3 stubs: each service dispatches its ops and returns a valid shape.
// (Unverified end-to-end without the dead mobile app/hardware — see DIVERGENCES.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';

let server; let port;
async function amz(target, body, accessKeyId = 'acct-1') {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1', 'x-amz-target': target,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260613/us-east-1/x/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => { server = await createClassicEntrypoint().listen(0); port = server.address().port; });
after(() => server.close());

test('rom: SetupClient returns the cert-bundle shape', async () => {
  const r = await amz('ROM_20171011.SetupClient', {});
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['cert', 'created', 'fingerprint', 'p12', 'payload', 'private', 'public']);
});

test('media: Create returns a record; List/Get empty', async () => {
  const c = await amz('Media_20160725.Create', { type: 'photo', loopId: 'l' });
  assert.equal(c.body.type, 'photo');
  assert.equal(c.body.accountId, 'acct-1');
  assert.equal(c.body.url, '');
  assert.deepEqual((await amz('Media_20160725.List', {})).body, []);
});

test('person: account properties round-trip in-memory', async () => {
  await amz('Person_20160801.SetAccountProperty', { key: 'favColor', value: 'blue' }, 'acct-P');
  const got = await amz('Person_20160801.GetAccountProperties', {}, 'acct-P');
  assert.equal(got.body.favColor, 'blue');
  const keys = await amz('Person_20160801.ListAccountPropertyKeys', {}, 'acct-P');
  assert.deepEqual(keys.body.keys, ['favColor']);
  // holidays return the command-accepted shape
  assert.equal((await amz('Person_20160801.EnableHolidays', {})).body.result, 'Command accepted');
});

test('backup / ifttt / nlp / collision return their shapes', async () => {
  assert.equal((await amz('Backup_20170222.New', {})).body.uploadUrl, '');
  assert.equal((await amz('IFTTT_20170207.Trigger', {})).body.result, 'Command accepted');
  assert.deepEqual((await amz('NLP_20161031.PartOfSpeech', { text: 'hi' })).body.partsOfSpeech, []);
  const col = await amz('Collision_20161126.Match', { username: 'jane' });
  assert.equal(col.body.success, true);
  assert.equal(col.body.collision, false);
});

test('unknown op on a stub service -> ValidationException', async () => {
  const r = await amz('NLP_20161031.Frobnicate', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});
