// Frozen-world runtime fixture — port of test-utils/src/mockRuntimeData.ts (the Jetsons loop).
// Deterministic context for behavior tests: 7 loop members with fixed birthdates, Boston
// location, frozen ISO clock, NEUTRAL emotion.

export const LOOP_ID = 'test-loop-id';
export const LOOP_OWNER_ID = 'test-looper-id-2';
export const DEFAULT_REFERENT_ID = 'test-looper-id-5';
export const DEFAULT_SPEAKER = { id: 'test-looper-id-3', accountId: 'test-account-id-3' };
export const FROZEN_ISO = '2017-12-11T16:05:52.585-05:00';

/**
 * @param {boolean|{id:string,accountId:string}} [withSpeaker=true]
 * @param {boolean} [injectReferent=false]
 * @param {string} [iso] frozen clock (ISO with offset)
 */
export function mockRuntimeData(withSpeaker = true, injectReferent = false, iso = FROZEN_ISO) {
  let speaker;
  if (withSpeaker && typeof withSpeaker === 'object') {
    if (!withSpeaker.id || !withSpeaker.accountId) throw new Error('speaker needs id + accountId');
    speaker = withSpeaker;
  } else if (withSpeaker) {
    speaker = DEFAULT_SPEAKER;
  } else {
    speaker = null;
  }

  return {
    loop: {
      loopId: LOOP_ID,
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'WHITE' },
      owner: LOOP_OWNER_ID,
      users: [
        { id: LOOP_OWNER_ID, accountId: 'test-account-id-2', birthdate: 220924800000, gender: 'male', phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George' },
        { id: speaker ? speaker.id : DEFAULT_SPEAKER.id, accountId: speaker ? speaker.accountId : DEFAULT_SPEAKER.accountId, birthdate: 444528000000, gender: 'female', phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane' },
        { id: 'test-looper-id-4', accountId: 'test-account-id-4', birthdate: 983577600000, gender: 'female', phoneticName: 'Judy', lastName: 'Jetson', firstName: 'Judy' },
        { id: DEFAULT_REFERENT_ID, accountId: 'test-account-id-5', birthdate: 1065139200000, gender: 'male', phoneticName: 'Elroy', lastName: 'Jetson', firstName: 'Elroy' },
        { id: 'test-looper-id-6', accountId: 'test-account-id-6', birthdate: 953251200000, gender: 'female', phoneticName: 'Rosie', lastName: 'Jetson', firstName: 'Rosie' },
        { id: 'test-looper-id-7', accountId: 'test-account-id-7', birthdate: 953078400000, gender: 'male', phoneticName: 'Astro', lastName: 'Jetson', firstName: 'Astro' },
      ],
    },
    location: {
      lng: -71.1273681, lat: 42.313352,
      country: 'usa', countryCode: 'US', stateAbbr: 'ma', state: 'Massachusetts', city: 'boston',
      iso,
    },
    perception: { peoplePresent: [], speaker: speaker ? speaker.id : null },
    character: {
      motivation: { playful: 0.14528444444444447, social: 0.01816055555555556 },
      emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' },
    },
    dialog: { referent: injectReferent ? DEFAULT_REFERENT_ID : null },
  };
}
