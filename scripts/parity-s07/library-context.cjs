'use strict';

// Shared JSON-only runtime/context and deterministic RNG helpers. This file is
// deliberately CommonJS so the same bytes run under the archived Node 8 source
// container and the current Phoenix Node runtime.

const FIXED_NOW = Date.parse('2018-05-30T12:00:00.000Z');
const SPEAKER = 'test-looper-id-3';
const REFERENT = 'test-looper-id-5';
const OWNER = 'test-looper-id-2';

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function baseRuntime() {
  return {
    loop: {
      loopId: 'test-loop-id',
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'WHITE' },
      owner: OWNER,
      users: [
        { id: OWNER, accountId: 'test-account-id-2', birthdate: 220924800000, gender: 'male', phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George' },
        { id: SPEAKER, accountId: 'test-account-id-3', birthdate: 444528000000, gender: 'female', phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane' },
        { id: 'test-looper-id-4', accountId: 'test-account-id-4', birthdate: 983577600000, gender: 'female', phoneticName: 'Judy', lastName: 'Jetson', firstName: 'Judy' },
        { id: REFERENT, accountId: 'test-account-id-5', birthdate: 1065139200000, gender: 'male', phoneticName: 'Elroy', lastName: 'Jetson', firstName: 'Elroy' },
        { id: 'test-looper-id-6', accountId: 'test-account-id-6', birthdate: 953251200000, gender: 'female', phoneticName: 'Rosie', lastName: 'Jetson', firstName: 'Rosie' },
        { id: 'test-looper-id-7', accountId: 'test-account-id-7', birthdate: 953078400000, gender: 'male', phoneticName: 'Astro', lastName: 'Jetson', firstName: 'Astro' },
      ],
    },
    location: {
      lng: -71.1273681, lat: 42.313352, country: 'usa', countryCode: 'US',
      stateAbbr: 'ma', state: 'Massachusetts', city: 'boston', iso: '2018-05-30T12:00:00.000Z',
    },
    perception: { peoplePresent: [], speaker: SPEAKER },
    character: { motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 }, emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

function user(runtime, id) {
  return runtime.loop.users.find((item) => item.id === id);
}
function setBirthdate(runtime, id, year, month = 0, day = 1) {
  const item = user(runtime, id);
  if (item) item.birthdate = Date.UTC(year, month, day);
}
function setReferent(runtime, id = REFERENT) {
  runtime.dialog.referent = id;
}

function runtimeFor(profile) {
  const runtime = baseRuntime();
  if (profile.startsWith('date-')) runtime.location.iso = `${profile.slice(5)}T12:00:00.000Z`;
  switch (profile) {
    case 'no-speaker': runtime.perception.speaker = null; break;
    case 'referent': setReferent(runtime); break;
    case 'speaker-referent': setReferent(runtime); break;
    case 'no-owner': runtime.loop.owner = null; break;
    case 'owner-speaker': runtime.loop.owner = SPEAKER; break;
    case 'loop-one':
      runtime.loop.users = [user(runtime, SPEAKER)];
      runtime.loop.owner = SPEAKER;
      break;
    case 'loop-two':
      runtime.loop.users = [user(runtime, OWNER), user(runtime, SPEAKER)];
      runtime.loop.owner = OWNER;
      break;
    case 'referent-female-child':
      setReferent(runtime);
      if (user(runtime, REFERENT)) { user(runtime, REFERENT).gender = 'female'; setBirthdate(runtime, REFERENT, 2010); }
      break;
    case 'referent-male-adult':
      setReferent(runtime);
      if (user(runtime, REFERENT)) { user(runtime, REFERENT).gender = 'male'; setBirthdate(runtime, REFERENT, 1970); }
      break;
    case 'birthday-jibo': setBirthdate(runtime, 'test-looper-id-1', 2000, 4, 30); break;
    case 'birthday-speaker': setBirthdate(runtime, SPEAKER, 2000, 4, 30); break;
    case 'birthday-referent': setReferent(runtime); setBirthdate(runtime, REFERENT, 2000, 4, 30); break;
    case 'nonbirthday-referent': setReferent(runtime); setBirthdate(runtime, REFERENT, 2000, 0, 1); break;
    case 'color-BLACK': runtime.loop.jibo.color = 'BLACK'; break;
    case 'color-WHITE': runtime.loop.jibo.color = 'WHITE'; break;
    case 'region-CA':
      runtime.location.country = 'canada'; runtime.location.countryCode = 'CA'; runtime.location.stateAbbr = 'on'; runtime.location.state = 'Ontario'; runtime.location.city = 'toronto';
      break;
    case 'region-US': break;
    case 'city-new-york': runtime.location.city = 'new york'; runtime.location.state = 'New York'; runtime.location.stateAbbr = 'ny'; break;
    case 'city-boston': break;
    case 'emotion-JOYFUL': runtime.character.emotion.name = 'JOYFUL'; runtime.character.emotion.valence = 1; break;
    case 'emotion-PLEASED': runtime.character.emotion.name = 'PLEASED'; runtime.character.emotion.valence = 0.6; break;
    case 'emotion-DETERMINED': runtime.character.emotion.name = 'DETERMINED'; runtime.character.emotion.valence = 0.5; break;
    case 'emotion-CONFIDENT': runtime.character.emotion.name = 'CONFIDENT'; runtime.character.emotion.valence = 0.7; break;
    case 'emotion-NEUTRAL': runtime.character.emotion.name = 'NEUTRAL'; runtime.character.emotion.valence = 0; break;
    case 'emotion-INSECURE': runtime.character.emotion.name = 'INSECURE'; runtime.character.emotion.valence = -0.1; break;
    case 'emotion-HOPEFUL': runtime.character.emotion.name = 'HOPEFUL'; runtime.character.emotion.valence = 0.3; break;
    case 'emotion-SAD': runtime.character.emotion.name = 'SAD'; runtime.character.emotion.valence = -0.7; break;
    case 'emotion-FRUSTRATED': runtime.character.emotion.name = 'FRUSTRATED'; runtime.character.emotion.valence = -0.5; break;
    case 'emotion-positive': runtime.character.emotion.name = 'PLEASED'; runtime.character.emotion.valence = 0.0001; break;
    case 'emotion-zero': runtime.character.emotion.name = 'NEUTRAL'; runtime.character.emotion.valence = 0; break;
    case 'emotion-negative': runtime.character.emotion.name = 'SAD'; runtime.character.emotion.valence = -0.0001; break;
    case 'emotion-missing': runtime.character.emotion = null; break;
    default: break;
  }
  return runtime;
}

function rngValues(seed, count = 128) {
  let state = (Number(seed) >>> 0) || 1;
  const values = [];
  for (let i = 0; i < count; i += 1) {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    values.push((state >>> 0) / 4294967296);
  }
  return values;
}

module.exports = { FIXED_NOW, runtimeFor, rngValues, clone, SPEAKER, REFERENT, OWNER };
