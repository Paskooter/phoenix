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
// The accepted-input bounds are read from the module itself so this file cannot drift from them.
import * as collisionModule from '../src/collision.js';

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

// --- accepted-input bounds (the served operation) -----------------------------------------------
//
// Match's supported name lengths and candidate count bound comparison work per request.
// These tests require the existing validation shape for over-limit input and retain exact
// answers for accepted inputs.

const LIMITS = collisionModule.COLLISION_LIMITS;

test('collision Match refuses a target name far beyond the supported length', async () => {
  const r = await match({ name: 'a'.repeat(4096), existingNames: ['emir'] });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('collision Match refuses more candidates than supported', async () => {
  const names = Array.from({ length: 1024 }, (_, i) => `name-${i}`);
  const r = await match({ name: 'amir', existingNames: names });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('collision Match refuses a candidate name far beyond the supported length', async () => {
  const r = await match({ name: 'amir', existingNames: ['e'.repeat(4096)] });
  assert.equal(r.status, 400);
  assert.equal(r.errType, 'ValidationException');
});

test('collision Match answers an over-limit request within a fixed small budget', async () => {
  // A parseable over-limit fixture must receive the existing validation response promptly.
  const request = {
    name: 'a'.repeat(49000),
    existingNames: ['b'.repeat(49000)],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(request)) < 100 * 1024, 'fixture stays parseable by the shared JSON body cap');
  const started = performance.now();
  const r = await match(request);
  const elapsed = performance.now() - started;
  assert.equal(r.status, 400, `an over-limit request must be refused; it took ${Math.round(elapsed)}ms`);
  assert.equal(r.errType, 'ValidationException');
  assert.ok(elapsed < 1000, `refusal is a fixed small cost, not proportional to input size (took ${Math.round(elapsed)}ms)`);
});

test('collision Match accepts input at the bounds and still answers the exact match', async () => {
  const target = 'x'.repeat(LIMITS.maxNameLength);
  const others = Array.from({ length: LIMITS.maxExistingNames - 1 }, () => 'y'.repeat(LIMITS.maxExistingNameLength));
  const started = performance.now();
  const r = await match({ name: target, existingNames: [...others, target] });
  const elapsed = performance.now() - started;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { success: true, collision: true, closest_pair: target, distance: 0 });
  assert.ok(elapsed < 2000, `bounds stay small enough to answer in a fixed budget (took ${Math.round(elapsed)}ms)`);
});

test('collision Match refuses input one step past the bounds', async () => {
  const longName = await match({ name: 'a'.repeat(LIMITS.maxNameLength + 1), existingNames: ['emir'] });
  assert.equal(longName.status, 400);
  assert.equal(longName.errType, 'ValidationException');

  const tooMany = Array.from({ length: LIMITS.maxExistingNames + 1 }, () => 'emir');
  const count = await match({ name: 'amir', existingNames: tooMany });
  assert.equal(count.status, 400);
  assert.equal(count.errType, 'ValidationException');

  const longItem = await match({ name: 'amir', existingNames: ['e'.repeat(LIMITS.maxExistingNameLength + 1)] });
  assert.equal(longItem.status, 400);
  assert.equal(longItem.errType, 'ValidationException');

  // Exactly at the bounds is accepted (the previous test) — and an empty name stays valid.
  const empty = await match({ name: '', existingNames: ['emir'] });
  assert.equal(empty.status, 200);
});

// --- randomized equality for in-limit inputs -----------------------------------------------------
//
// The bounds must not change any accepted answer. This is an independent reference implementation
// of the pinned semantics (grapheme tokens, full edit-distance matrix, first strict minimum wins,
// short sequences need an exact piece match) checked against the served module on every random
// case. A future matcher change that alters an in-limit answer fails here.

function referenceTokens(word) {
  return String(word ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').split('');
}

function referenceEditDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return rows[a.length][b.length];
}

function referenceDetect(names, target, minDistance = 1) {
  const targetTokens = referenceTokens(target);
  const inputTokens = names.map(referenceTokens);
  if (inputTokens.length === 0 || targetTokens.length === 0) {
    return { collision: false, closestPair: null, distance: null, targetPhonemes: '', inputPhonemes: '' };
  }
  let best = { distance: 1000, index: 0 };
  for (let i = 0; i < inputTokens.length; i++) {
    const distance = referenceEditDistance(targetTokens, inputTokens[i]);
    if (distance < best.distance) best = { distance, index: i };
  }
  const threshold = (targetTokens.length <= 3 || inputTokens[best.index].length <= 3) ? 0 : minDistance;
  return {
    collision: best.distance <= threshold,
    closestPair: names[best.index],
    distance: best.distance,
    targetPhonemes: targetTokens.join('-'),
    inputPhonemes: inputTokens[best.index].join('-'),
  };
}

test('detectCollision agrees with the reference on randomized in-limit inputs', () => {
  // Deterministic PRNG (mulberry32) so a mismatch reproduces from the seed alone.
  let seed = 0x5ec06d6;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789- .é_';
  const word = (maxLength) => {
    const length = 1 + Math.floor(rand() * maxLength);
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  };
  for (let trial = 0; trial < 200; trial++) {
    const target = word(24);
    const names = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => word(24));
    const minDistance = Math.floor(rand() * 3);
    const served = detectCollision({ names, target, minDistance });
    const expected = referenceDetect(names, target, minDistance);
    assert.deepEqual(served, expected, `trial ${trial}: names=${JSON.stringify(names)} target=${JSON.stringify(target)} minDistance=${minDistance}`);
  }
});
