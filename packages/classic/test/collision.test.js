// Collision_20161126 — the phonetic username-collision check the app runs before naming a loop
// member.
//
// Every expectation is pinned to the archive, not invented:
//   apis/collision-2016-11-26.normal.json   jiborobot/srv-jibo-server-client
//   jiborobot/srv-collision-ws
//     src/handlers/collision.handler.js     Match Joi: name (allow ''), existingNames (strings)
//     src/controllers/collision.ctrl.js     execFile(... -c test.cfg -i names -t target); non-zero
//                                           exit -> Boom.wrap(..., 409)
//   alexander-rysenko/phonetic_collision
//     README.txt   jibo_phonetic_collision_service_test -c test.cfg -i emir,alex -t amir
//                  -> { "success": true, "collision": true, "closest_pair": "emir", "distance": 1 }
//     test.cfg     nbest = 2 / min_distance = 1
//     src/jibo_phonetic_collision_service.cc   min_distance forced to 0 when either phoneme
//                                              sequence has <= 3 tokens
//     src/phonetic_collision.cc                lev distance over '-'-split phonemes, first minimum
//
// The regression this file exists to prevent: the tier-3 stub answered `collision: false` for
// every name, so the app let a user create a member whose name collided with an existing one.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createClassicEntrypoint } from '../src/index.js';
import { detectCollision, graphemePhonemize, levenshteinDistance } from '../src/collision.js';

const ACCOUNT = '43ca532ad4090cfb80f2e7a5';

let server; let port;
async function match(body, accessKeyId = ACCOUNT) {
  const headers = { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'Collision_20161126.Match' };
  if (accessKeyId) headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20161126/us-east-1/collision/aws4_request, SignedHeaders=host, Signature=ff`;
  const res = await fetch(`http://localhost:${port}/`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, errType: res.headers.get('x-amzn-errortype'), body: await res.json().catch(() => null) };
}

before(async () => { server = await createClassicEntrypoint().listen(0); port = server.address().port; });
after(() => server.close());

// --- the algorithm (unit) -----------------------------------------------------------------------

test('levenshteinDistance is the ported token-vector edit distance', () => {
  assert.equal(levenshteinDistance([], []), 0);
  assert.equal(levenshteinDistance(['a', 'b'], ['a', 'b']), 0);
  assert.equal(levenshteinDistance([], ['a']), 1);
  assert.equal(levenshteinDistance(['a', 'm', 'i', 'r'], ['e', 'm', 'i', 'r']), 1);
  assert.equal(levenshteinDistance(['b', 'o', 'b'], ['r', 'o', 'b']), 1);
});

test('detectCollision reproduces the pinned README example', () => {
  const r = detectCollision({ names: ['emir', 'alex'], target: 'amir' });
  assert.deepEqual(r, {
    collision: true, closestPair: 'emir', distance: 1, targetPhonemes: 'a-m-i-r', inputPhonemes: 'e-m-i-r',
  });
});

test('detectCollision reports no collision when every candidate is far away', () => {
  const r = detectCollision({ names: ['emir', 'alex'], target: 'john' });
  assert.equal(r.collision, false);
  assert.equal(r.closestPair, 'emir'); // first strict minimum wins
  assert.equal(r.distance, 4);
});

test('detectCollision short-name boundary forces an exact phoneme match (<=3 tokens)', () => {
  // 3 tokens on both sides -> min_distance is forced to 0, so a distance of 1 is NOT a collision.
  assert.deepEqual(detectCollision({ names: ['rob'], target: 'bob' }), {
    collision: false, closestPair: 'rob', distance: 1, targetPhonemes: 'b-o-b', inputPhonemes: 'r-o-b',
  });
  assert.equal(detectCollision({ names: ['bob'], target: 'bob' }).collision, true);
  // 4 tokens -> the configured min_distance (1) still applies, so a 1-edit name collides.
  assert.equal(detectCollision({ names: ['amix'], target: 'amir' }).collision, true);
  assert.equal(detectCollision({ names: ['amir'], target: 'amir' }).collision, true);
});

test('detectCollision honours the configured min_distance threshold', () => {
  assert.equal(detectCollision({ names: ['emir'], target: 'amir', minDistance: 0 }).collision, false);
  assert.equal(detectCollision({ names: ['amir'], target: 'amir', minDistance: 0 }).collision, true);
});

test('detectCollision expands n-best pronunciations and maps back to the colliding word', () => {
  const phonemize = (word) => (word === 'amir'
    ? [['a', 'm', 'i', 'r'], ['a', 'm', 'a', 'r']]
    : [['e', 'm', 'i', 'r'], ['e', 'm', 'a', 'r']]);
  const r = detectCollision({ names: ['emir'], target: 'amir', phonemize, nbest: 2 });
  assert.equal(r.closestPair, 'emir');
  assert.equal(r.distance, 1);
  assert.equal(r.collision, true);
});

test('detectCollision answers a null pair for an empty candidate list', () => {
  assert.deepEqual(detectCollision({ names: [], target: 'jane' }), {
    collision: false, closestPair: null, distance: null, targetPhonemes: '', inputPhonemes: '',
  });
});

// --- the served operation -----------------------------------------------------------------------

test('collision Match is served with the pinned output shape', async () => {
  const r = await match({ name: 'amir', existingNames: ['emir', 'alex'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, collision: true, closest_pair: 'emir', distance: 1 });
});

test('collision Match answers no-collision and the empty-list boundary', async () => {
  const far = await match({ name: 'john', existingNames: ['emir', 'alex'] });
  assert.equal(far.body.collision, false);
  assert.equal(far.body.success, true);

  const empty = await match({ name: 'jane', existingNames: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { success: true, collision: false, closest_pair: null, distance: null });
});

test('collision Match validates name and existingNames like the source Joi', async () => {
  const noName = await match({ existingNames: ['emir'] });
  assert.equal(noName.status, 400);
  assert.equal(noName.errType, 'ValidationException');

  const noNames = await match({ name: 'amir' });
  assert.equal(noNames.status, 400);

  const emptyName = await match({ name: '', existingNames: ['emir'] });
  assert.equal(emptyName.status, 200); // Joi.string().allow('')

  const emptyItem = await match({ name: 'amir', existingNames: [''] });
  assert.equal(emptyItem.status, 400);

  const unknown = await match({}, 'x');
  assert.equal(unknown.status, 400);
});

test('collision Match requires a signed request (MISSING_AUTH_HEADER 401)', async () => {
  const r = await match({ name: 'amir', existingNames: ['emir'] }, null);
  assert.equal(r.status, 401);
  assert.equal(r.errType, 'MISSING_AUTH_HEADER');
});

test('collision unknown operation is a ValidationException, not a silent no-collision', async () => {
  const res = await fetch(`http://localhost:${port}/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'Collision_20161126.Frobnicate',
      authorization: `AWS4-HMAC-SHA256 Credential=${ACCOUNT}/20161126/us-east-1/collision/aws4_request, SignedHeaders=host, Signature=ff`,
    },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  assert.equal(res.headers.get('x-amzn-errortype'), 'ValidationException');
});

test('collision service failure is answered as 409 (the source Boom.wrap(_, 409))', async () => {
  const broken = await createClassicEntrypoint({
    collision: { phonemize: () => { throw new Error('g2p model not found'); } },
  }).listen(0);
  const brokenPort = broken.address().port;
  try {
    const res = await fetch(`http://localhost:${brokenPort}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': 'Collision_20161126.Match',
        authorization: `AWS4-HMAC-SHA256 Credential=${ACCOUNT}/20161126/us-east-1/collision/aws4_request, SignedHeaders=host, Signature=ff`,
      },
      body: JSON.stringify({ name: 'amir', existingNames: ['emir'] }),
    });
    assert.equal(res.status, 409);
    assert.equal(res.headers.get('x-amzn-errortype'), 'COLLISION_SERVICE_FAILED');
  } finally {
    await broken.close();
  }
});

test('the default pronunciation model is the documented grapheme approximation', () => {
  assert.deepEqual(graphemePhonemize('Amir'), [['a', 'm', 'i', 'r']]);
  assert.deepEqual(graphemePhonemize(''), [[]]);
});
