// `collision` service (Collision_20161126) — the username-collision check the app calls before it
// lets a user name a loop member. Graduated out of the tier-3 stub file in A-15; the stub answered
// "no collision" unconditionally.
//
// Pinned from the archive (read through the Jibo archive MCP, not guessed):
//   apis/collision-2016-11-26.normal.json   jiborobot/srv-jibo-server-client
//       targetPrefix "Collision_20161126"; one op Match (input {name, existingNames}, output
//       {success, collision, closest_pair, distance}); MatchInput requires name + existingNames,
//       MatchOutput requires success.
//   jiborobot/srv-collision-ws
//       src/handlers/collision.handler.js  `match` with @parseCredentials({}) and
//          @validatePayload({ name: Joi.string().allow('').required(),
//                             existingNames: Joi.array().items(Joi.string().required()).required() })
//       src/controllers/collision.ctrl.js  execFile('/phonetic_collision/bin/
//          jibo_phonetic_collision_service_test', ['-c','/phonetic_collision/test.cfg',
//          '-i', existingNames.join(','), '-t', name]); a non-zero exit rejects
//          `Boom.wrap(stderr ? new Error(stderr) : error, 409)`.
//   alexander-rysenko/phonetic_collision (== amir/phonetic_collision)
//       README.txt        usage + the worked example:
//                           jibo_phonetic_collision_service_test -c test.cfg -i emir,alex -t amir
//                           { "success": true, "collision": true, "closest_pair": "emir", "distance": 1 }
//       test.cfg          nbest = 2 / g2p_model = resources/g2p.model / min_distance = 1
//       src/jibo_phonetic_collision_service.cc   the threshold rule (ported below)
//       src/phonetic_collision.cc                gen_phone_seq + compute_distance + levenshtein
//       src/errors were not recovered for this repo; see the 409 note below.
//
// The algorithm, ported line for line:
//   * gen_phone_seq runs the g2p model `nbest` times per word; each pronunciation is a phoneme
//     sequence joined with '-'. Target pronunciations and (input-word pronunciations) are both
//     collected, and the input word is repeated once per returned sequence so the closest pair can
//     be mapped back to a word (`expanded_input_words`).
//   * compute_distance takes the minimum Levenshtein distance (over the '-'-split phoneme tokens)
//     across every target×input pair; ties keep the first pair encountered (strict `<`), and the
//     iteration order is target-outer / input-inner.
//   * the threshold: `min_distance` from the config (1 in test.cfg) — BUT if either the target or
//     the winning input phoneme sequence has <= 3 tokens, `min_distance` is forced to 0, so only an
//     exact phoneme match counts as a collision for short names.
//   * collision = distance <= min_distance.
//
// DEDUCED (not in scope): the g2p model is a 14 MB Phonetisaurus FST (resources/g2p.model) that
// cannot be reproduced from source, so the phoneme sequences the original produced are UNKNOWN.
// The handler therefore takes a `phonemize` seam. The default is a documented grapheme
// approximation (lower-cased character tokens) which reproduces the pinned README example exactly
// (amir vs emir -> distance 1 -> collision true, closest_pair emir) and preserves every threshold
// rule; it is NOT claimed to equal the model's output for other names.
//
// Error response: the source rejected with a Boom wrapping the child-process failure at status 409
// when the binary exited non-zero (e.g. a missing config/model). Phoenix has no native binary; the
// seam throwing is answered as 409 with COLLISION_SERVICE_FAILED. The exact wire `__type` the
// deployed hapi/Boom serializer emitted is UNKNOWN.

import { sendAmz, sendAmzError, ValidationException } from './awsJson.js';
import { MISSING_AUTH_HEADER, accountIdFromRequest } from './person.js';

export const COLLISION_DEFAULTS = { nbest: 2, minDistance: 1 };

export const COLLISION_ERRORS = {
  COLLISION_SERVICE_FAILED: { code: 'COLLISION_SERVICE_FAILED', statusCode: 409, message: 'Phonetic collision service failed' },
};

export const COLLISION_OPERATIONS = ['match'];

/**
 * PhoneticCollision::levenshtein_distance over phoneme-token vectors.
 * Ported from src/phonetic_collision.cc (itself the Wikibooks single-row implementation).
 */
export function levenshteinDistance(s1, s2) {
  const s1len = s1.length;
  const s2len = s2.length;
  const column = new Array(s1len + 1);
  for (let i = 0; i <= s1len; i++) column[i] = i;
  for (let x = 1; x <= s2len; x++) {
    column[0] = x;
    let lastDiagonal = x - 1;
    for (let y = 1; y <= s1len; y++) {
      const oldDiagonal = column[y];
      column[y] = Math.min(column[y] + 1, column[y - 1] + 1, lastDiagonal + (s1[y - 1] === s2[x - 1] ? 0 : 1));
      lastDiagonal = oldDiagonal;
    }
  }
  return column[s1len];
}

/**
 * Default pronunciation model. The pinned g2p FST is unreproducible; this returns the word's
 * lower-cased grapheme tokens as a single pronunciation. `nbest` is accepted for the seam but the
 * approximation has no second guess to offer.
 */
export function graphemePhonemize(word) {
  const letters = String(word ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return letters ? [letters.split('')] : [[]];
}

const split = (seq, delimiter) => String(seq).split(delimiter);
const join = (tokens) => tokens.join('-');

/** gen_phone_seq: pronunciations for a word (each joined with '-'), plus the word repeated per seq. */
function pronunciations(phonemize, word, nbest) {
  const variants = phonemize(word, nbest);
  const list = Array.isArray(variants) ? variants : [];
  return list
    .map((tokens) => join(Array.isArray(tokens) ? tokens : [tokens]))
    .filter((seq) => seq.length > 0 || list.length === 1);
}

/**
 * The archived detection algorithm. Returns the source's outputs:
 *   { collision, closestPair, distance, targetPhonemes, inputPhonemes }
 * `closestPair` is null and `distance` null when there is nothing to compare against (the native
 * binary has no defined answer for an empty input list — recorded as UNKNOWN).
 */
export function detectCollision({
  names, target, minDistance = COLLISION_DEFAULTS.minDistance, nbest = COLLISION_DEFAULTS.nbest,
  phonemize = graphemePhonemize,
}) {
  const inputWords = Array.isArray(names) ? names : [];
  const phoneSeqTarget = pronunciations(phonemize, target, nbest);
  const phoneSeqInput = [];
  const expandedInputWords = [];
  for (const word of inputWords) {
    const seqs = pronunciations(phonemize, word, nbest);
    for (const seq of seqs) {
      phoneSeqInput.push(seq);
      expandedInputWords.push(word);
    }
  }

  if (phoneSeqInput.length === 0 || phoneSeqTarget.length === 0) {
    return { collision: false, closestPair: null, distance: null, targetPhonemes: '', inputPhonemes: '' };
  }

  let minDist = 1000;
  let minSeq1 = '';
  let minSeq2 = '';
  let minIndex = 0;
  for (const phnSeq1 of phoneSeqTarget) {
    const temp1 = split(phnSeq1, '-');
    let itr = 0;
    for (const phnSeq2 of phoneSeqInput) {
      const temp2 = split(phnSeq2, '-');
      const dist = levenshteinDistance(temp1, temp2);
      if (dist < minDist) {
        minDist = dist;
        minIndex = itr;
        minSeq1 = phnSeq1;
        minSeq2 = phnSeq2;
      }
      itr += 1;
    }
  }

  const t1 = split(minSeq1, '-');
  const t2 = split(minSeq2, '-');
  // Short sequences must match exactly: the source forces min_distance to 0 when either side has
  // three or fewer tokens.
  const threshold = (t1.length <= 3 || t2.length <= 3) ? 0 : minDistance;
  return {
    collision: minDist <= threshold,
    closestPair: expandedInputWords[minIndex],
    distance: minDist,
    targetPhonemes: minSeq1,
    inputPhonemes: minSeq2,
  };
}

/** Collision_20161126 handler. `phonemize` is injectable; the default is the grapheme model. */
export function makeCollisionHandler({ phonemize = graphemePhonemize, nbest = COLLISION_DEFAULTS.nbest, minDistance = COLLISION_DEFAULTS.minDistance } = {}) {
  const handlers = {
    match: ({ body }) => {
      const result = detectCollision({
        names: body.existingNames, target: body.name, phonemize, nbest, minDistance,
      });
      return {
        success: true,
        collision: result.collision,
        closest_pair: result.closestPair,
        distance: result.distance,
      };
    },
  };

  return function collisionHandler({ req, res, body, op, log }) {
    const name = String(op).toLowerCase();
    const handler = handlers[name];
    if (!handler) return void sendAmzError(res, ValidationException, `unknown collision operation: ${op}`);
    // Match carries @parseCredentials({}); the gateway requires a signed header (person.js notes).
    if (!accountIdFromRequest(req)) return void sendAmzError(res, MISSING_AUTH_HEADER);
    const payload = body || {};
    if (typeof payload.name !== 'string') {
      return void sendAmzError(res, ValidationException, 'Invalid or missing name');
    }
    if (!Array.isArray(payload.existingNames)
      || payload.existingNames.some((item) => typeof item !== 'string' || item.length === 0)) {
      return void sendAmzError(res, ValidationException, 'Invalid or missing existingNames');
    }
    if (log) log.info('collision request', { op: name });
    try {
      return void sendAmz(res, 200, handler({ body: payload }));
    } catch (error) {
      if (error && error.statusCode) return void sendAmzError(res, error);
      log?.error?.('collision request failed', { op: name, error: error?.message });
      return void sendAmzError(res, COLLISION_ERRORS.COLLISION_SERVICE_FAILED, error?.message);
    }
  };
}
