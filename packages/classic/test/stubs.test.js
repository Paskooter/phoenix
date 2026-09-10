// Tier-3 stubs (H.5) — every service that once lived in stubs.js has graduated to a real,
// source-faithful handler (media, rom, ifttt, nlp, and — in A-15 — person + collision), so
// `stubRegistrations()` is now empty. What remains worth asserting at this seam is that the
// graduated prefixes are routed to their real handlers (a bad operation is a ValidationException,
// never a silent default shape) and that an unknown prefix is still an UnknownOperationException.
//
// person's full contract is covered by person.test.js; collision's by collision.test.js.
// (Unverified end-to-end without the dead mobile app/hardware — see DIVERGENCES.)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';
import { stubRegistrations } from '../src/stubs.js';

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

test('no tier-3 stub services remain', () => {
  assert.deepEqual(stubRegistrations(), []);
});

test('graduated person/collision/jot prefixes reach their real handlers', async () => {
  // person: the stub used to answer `[]` for any category; the real handler validates it.
  const person = await amz('Person_20160801.List', { category: 'not-a-category' });
  assert.equal(person.status, 404);
  assert.equal(person.errType, 'CATEGORY_NOT_FOUND');
  // collision: the stub used to answer success for any body; the real handler requires the input.
  const collision = await amz('Collision_20161126.Match', {});
  assert.equal(collision.status, 400);
  assert.equal(collision.errType, 'ValidationException');
  // jot: there was never a Jot registration, so the prefix fell through to UnknownOperationException;
  // the real handler owns it now and validates the pinned Joi payload (loopId required).
  const jot = await amz('Jot_20160512.CreateMessage', {});
  assert.equal(jot.status, 400);
  assert.equal(jot.errType, 'ValidationException');
  assert.match(jot.body.message, /loopId/);
});

test('unknown op on a graduated service -> ValidationException', async () => {
  const r = await amz('Collision_20161126.Frobnicate', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('unknown prefix -> UnknownOperationException', async () => {
  const r = await amz('Nothing_20160101.Do', {});
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'UnknownOperationException');
});
