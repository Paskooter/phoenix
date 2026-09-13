// Generates the frozen adversarial PromptData context matrix for the S-05
// differential probes (s05-context-matrix-source.cjs /
// s05-context-matrix-candidate.mjs).
//
// The matrix targets the S-05 acceptance surface: pronounceable name lists,
// owner/speaker/referent selection, age/birthday/zodiac, emotion values and
// location values.  Keys are omitted (never set to undefined) so JSON keeps
// "field absent" distinct from "field null"; both cases exist in the original
// runtime data and take different code paths.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const cases = [];

const iso = '2018-05-22T19:21:00.159-04:00';
const now = '2018-05-22T23:21:00.159Z';
const bostonLocation = {
  iso,
  city: 'boston',
  state: 'Massachusetts',
  stateAbbr: 'ma',
  country: 'usa',
  countryCode: 'US',
  lat: 42.313352,
  lng: -71.1273681,
};

const user = (id, phoneticName, birthdate, extra = {}) => ({
  id, birthdate, gender: extra.gender === undefined ? 'female' : extra.gender,
  phoneticName, firstName: extra.firstName === undefined ? phoneticName : extra.firstName,
  lastName: extra.lastName === undefined ? 'Jetson' : extra.lastName,
  ...extra.overrides,
});
const baseUsers = [
  user('owner', 'George', 220924800000, { gender: 'male', firstName: 'George' }),
  user('speaker', 'Jane', 444528000000, { firstName: 'Jane' }),
  user('referent', 'Judy', 1000000000000, { firstName: 'Judy' }),
];
const jibo = { id: 'jibo', birthdate: 1495216025271, color: 'WHITE' };
const emotion = { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' };

function base(overrides = {}) {
  return {
    loop: { owner: 'owner', jibo, users: baseUsers.map(u => ({ ...u })) },
    location: { ...bostonLocation },
    perception: { peoplePresent: [], speaker: 'speaker' },
    character: { emotion: { ...emotion } },
    dialog: { referent: 'referent' },
    ...overrides,
  };
}
const push = (id, context, when = now) => cases.push({ id, now: when, context });

// --- A. loop membership / pronounceable lists -------------------------------
push('loop-empty-users', base({ loop: { owner: 'owner', jibo, users: [] } }));
push('loop-one-user', base({ loop: { owner: 'owner', jibo, users: [baseUsers[0]] } }));
push('loop-two-users', base({ loop: { owner: 'owner', jibo, users: [baseUsers[0], baseUsers[1]] } }));
push('loop-five-users', base({
  loop: {
    owner: 'owner', jibo,
    users: [...baseUsers, user('u4', 'Astro', 1500000000000), user('u5', 'Rosie', 1600000000000)],
  },
}));
push('loop-owner-only', base({ loop: { owner: 'owner', jibo, users: [baseUsers[0]] }, perception: { speaker: 'nobody' }, dialog: {} }));
push('loop-speaker-only', base({ loop: { owner: 'owner', jibo, users: [baseUsers[1]] } }));
push('loop-referent-only', base({ loop: { owner: 'owner', jibo, users: [baseUsers[2]] } }));
push('loop-no-ids-match', base({ loop: { owner: 'x', jibo, users: baseUsers.map(u => ({ ...u, id: `!${u.id}` })) } }));
push('loop-owner-equals-speaker', base({ loop: { owner: 'speaker', jibo, users: baseUsers.map(u => ({ ...u })) } }));
push('loop-all-three-same-id', base({ loop: { owner: 'speaker', jibo, users: [baseUsers[1]] }, dialog: { referent: 'speaker' } }));
push('loop-duplicate-id-first-last', base({
  loop: {
    owner: 'dup', jibo,
    users: [
      user('dup', 'First', 1000000000000),
      user('dup', 'Second', 2000000000000),
      user('dup', 'Third', 3000000000000),
    ],
  },
  perception: { speaker: 'dup' }, dialog: { referent: 'dup' },
}));
push('loop-null-phonetic', base({
  loop: { owner: 'owner', jibo, users: [
    user('owner', null, 220924800000),
    user('speaker', undefined, 444528000000),
    user('referent', '', 1000000000000),
  ] },
}));
push('loop-phonetic-with-and', base({
  loop: { owner: 'owner', jibo, users: [
    user('owner', 'George and Jane', 220924800000),
    user('speaker', 'Jane, Judy', 444528000000),
  ] },
}));
push('loop-phonetic-unicode', base({
  loop: { owner: 'owner', jibo, users: [user('owner', 'José', 220924800000), user('speaker', '王小明', 444528000000)] },
}));
push('loop-single-user-no-owner', base({ loop: { jibo, users: [baseUsers[1]] } }));
push('loop-owner-absent-field', base({ loop: { jibo, users: baseUsers.map(u => ({ ...u })) } }));
push('loop-null-id-user', base({ loop: { owner: 'owner', jibo, users: [user(null, 'Nobody', 220924800000), ...baseUsers.map(u => ({ ...u }))] } }));

// --- B. jibo / emotion ------------------------------------------------------
push('jibo-absent', base({ loop: { owner: 'owner', users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-null', base({ loop: { owner: 'owner', jibo: null, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-no-birthdate', base({ loop: { owner: 'owner', jibo: { id: 'jibo', color: 'WHITE' }, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-null-birthdate', base({ loop: { owner: 'owner', jibo: { id: 'jibo', color: 'WHITE', birthdate: null }, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-empty-birthdate', base({ loop: { owner: 'owner', jibo: { id: 'jibo', color: 'WHITE', birthdate: '' }, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-invalid-birthdate', base({ loop: { owner: 'owner', jibo: { id: 'jibo', color: 'WHITE', birthdate: 'not-a-date' }, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-string-birthdate', base({ loop: { owner: 'owner', jibo: { id: 'jibo', color: 'WHITE', birthdate: '2017-05-19T20:27:05.271Z' }, users: baseUsers.map(u => ({ ...u })) } }));
push('jibo-no-color', base({ loop: { owner: 'owner', jibo: { id: 'jibo', birthdate: 1495216025271 }, users: baseUsers.map(u => ({ ...u })) } }));
push('emotion-absent', base({ character: {} }));
push('emotion-null', base({ character: { emotion: null } }));
push('emotion-empty', base({ character: { emotion: {} } }));
push('emotion-partial', base({ character: { emotion: { name: 'HAPPY' } } }));
push('emotion-negative-valence', base({ character: { emotion: { name: 'SAD', valence: -0.9, confidence: 1 } } }));
push('emotion-numeric-name', base({ character: { emotion: { name: 42, valence: 0, confidence: 0 } } }));
push('character-absent', base({ character: undefined }));

// --- C. perception / dialog selection ---------------------------------------
push('perception-absent', base({ perception: undefined }));
push('perception-empty', base({ perception: {} }));
push('perception-null-speaker', base({ perception: { speaker: null } }));
push('perception-empty-speaker', base({ perception: { speaker: '' } }));
push('perception-unknown-speaker', base({ perception: { speaker: 'ghost' } }));
push('dialog-absent', base({ dialog: undefined }));
push('dialog-empty', base({ dialog: {} }));
push('dialog-null-referent', base({ dialog: { referent: null } }));
push('dialog-empty-referent', base({ dialog: { referent: '' } }));
push('dialog-unknown-referent', base({ dialog: { referent: 'ghost' } }));
push('loop-section-absent', base({ loop: undefined }));

// --- D. birthdays / ages / zodiac ------------------------------------------
const bdayUsers = (birthdates) => ({
  loop: { owner: 'a', jibo, users: birthdates.map((b, i) => user(['a', 'b', 'c', 'd'][i], `P${i}`, b)) },
  perception: { speaker: 'a' }, dialog: { referent: 'b' },
});
push('birthday-today', base(bdayUsers([Date.parse('1980-05-22T12:00:00.000Z'), Date.parse('1990-05-22T00:00:00.000Z')])), now);
push('birthday-tomorrow', base(bdayUsers([Date.parse('1980-05-23T12:00:00.000Z'), Date.parse('1990-05-21T00:00:00.000Z')])), now);
push('birthday-leap-day', base(bdayUsers([Date.parse('1980-02-29T12:00:00.000Z'), Date.parse('2000-02-29T00:00:00.000Z')])), '2020-02-29T04:30:00.000Z');
push('birthday-leap-day-nonleap-year', base(bdayUsers([Date.parse('1980-02-29T12:00:00.000Z'), Date.parse('2000-02-29T00:00:00.000Z')])), '2019-02-28T23:59:59.999Z');
push('birthday-epoch-zero', base(bdayUsers([0, 1])), now);
push('birthday-future', base(bdayUsers([Date.parse('2030-01-01T00:00:00.000Z'), Date.parse('2099-12-31T23:59:59.999Z')])), now);
push('birthday-hour-edge', base(bdayUsers([
  Date.parse('1980-05-22T23:59:59.999Z'), Date.parse('1980-05-23T00:00:00.000Z'),
])), now);
push('birthday-null-and-missing', base({ loop: { owner: 'a', jibo, users: [user('a', 'A', null), user('b', 'B', undefined)] }, perception: { speaker: 'a' }, dialog: { referent: 'b' } }));
push('birthday-invalid-string', base({ loop: { owner: 'a', jibo, users: [user('a', 'A', 'nope'), user('b', 'B', '1980-13-45T00:00:00.000Z')] }, perception: { speaker: 'a' }, dialog: { referent: 'b' } }));
push('birthday-number-string', base({ loop: { owner: 'a', jibo, users: [user('a', 'A', '444528000000')] }, perception: { speaker: 'a' } }));
push('birthday-date-string', base({ loop: { owner: 'a', jibo, users: [user('a', 'A', '1984-02-05')] }, perception: { speaker: 'a' } }));
push('zodiac-boundaries', base({
  loop: {
    owner: 'a', jibo,
    users: [
      user('a', 'A', Date.parse('1980-01-21T00:00:00.000Z')),
      user('b', 'B', Date.parse('1980-02-19T00:00:00.000Z')),
      user('c', 'C', Date.parse('1980-02-20T00:00:00.000Z')),
      user('d', 'D', Date.parse('1980-12-22T00:00:00.000Z')),
    ],
  },
  perception: { speaker: 'a' }, dialog: { referent: 'c' },
}));
push('age-newborn-and-old', base({
  loop: { owner: 'a', jibo, users: [user('a', 'A', Date.parse(now)), user('b', 'B', Date.parse('1900-01-01T00:00:00.000Z'))] },
  perception: { speaker: 'a' }, dialog: { referent: 'b' },
}));

// --- E. location values -----------------------------------------------------
const locations = [
  ['loc-boston-jibo-home', { ...bostonLocation }],
  ['loc-boston-uppercase', { ...bostonLocation, city: 'Boston', state: 'massachusetts', country: 'USA', stateAbbr: 'MA' }],
  ['loc-canada', { iso, city: 'toronto', state: 'Ontario', stateAbbr: 'on', country: 'canada', countryCode: 'CA', lat: 43.65, lng: -79.38 }],
  ['loc-japan', { iso, city: 'tokyo', state: 'Tokyo', stateAbbr: 'tk', country: 'japan', countryCode: 'JP', lat: 35.68, lng: 139.69 }],
  ['loc-mexico', { iso, city: 'guadalajara', state: 'Jalisco', stateAbbr: 'ja', country: 'mexico', countryCode: 'MX', lat: 20.67, lng: -103.35 }],
  ['loc-us-city-and-state', { iso, city: 'cambridge', state: 'Massachusetts', stateAbbr: 'ma', country: 'usa', countryCode: 'US', lat: 42.37, lng: -71.11 }],
  ['loc-us-no-state', { iso, city: 'boston', state: 'Massachusetts', country: 'usa', countryCode: 'US', lat: 42.313352, lng: -71.1273681 }],
  ['loc-city-only', { iso, city: 'boston' }],
  ['loc-state-only', { iso, state: 'Massachusetts' }],
  ['loc-country-only', { iso, country: 'canada', countryCode: 'CA' }],
  ['loc-no-fields', { iso }],
  ['loc-empty-object', {}],
  ['loc-null-string-fields', { iso, city: 'null', state: 'null', country: 'null', stateAbbr: 'null', countryCode: 'null', lat: null, lng: null }],
  ['loc-zero-lat-lng', { iso, city: 'null island', state: 'null', country: 'null', countryCode: 'XX', lat: 0, lng: 0 }],
  ['loc-numeric-city', { iso, city: 42, state: 43, country: 44, countryCode: 'US', stateAbbr: 'zz' }],
  ['loc-boston-case-mismatch', { ...bostonLocation, city: 'BOSTON', stateAbbr: 'MA', country: 'USA' }],
  ['loc-boston-different-stateabbr', { ...bostonLocation, stateAbbr: 'ny' }],
  ['loc-other-non-us-with-us-code', { iso, city: 'london', state: 'England', stateAbbr: 'en', country: 'united kingdom', countryCode: 'GB', lat: 51.5, lng: -0.12 }],
];
for (const [id, loc] of locations) push(id, base({ location: loc }));

// --- F. context level -------------------------------------------------------
push('context-empty', {});
push('context-location-null', base({ location: null }));
push('context-location-false', base({ location: false }));
push('context-no-location', base({ location: undefined }));
push('context-location-nan-iso', base({ location: { ...bostonLocation, iso: NaN } }));
push('context-location-number-iso', base({ location: { ...bostonLocation, iso: 0 } }));
push('context-location-bool-iso', base({ location: { ...bostonLocation, iso: true } }));
push('context-location-object-iso', base({ location: { ...bostonLocation, iso: {} } }));

// --- G. runtime clock variety ----------------------------------------------
const clocks = [
  '2016-02-29T23:30:00.000Z', '2016-12-31T23:59:59.999Z', '2017-01-01T00:00:00.000Z',
  '2020-03-08T06:59:59.999Z', '2020-11-01T05:30:00.000Z', '2026-09-11T16:00:00.000Z',
  '2019-06-21T12:00:00.000Z', '2019-12-21T12:00:00.000Z', '2021-01-01T00:00:00.000Z',
];
const clockIsos = [
  '2016-02-29T18:30:00.000-05:00', '2016-12-31T23:59:59.999-12:00', '2017-01-01T00:00:00.000+14:00',
  '2020-03-08T01:59:59.999-05:00', '2020-11-01T01:30:00.000-04:00', '2026-09-11T12:00:00.000-04:00',
  '2019-06-21T12:00:00.000+05:30', '2019-12-21T12:00:00.000+09:00', '2021-01-01T00:00:00.000Z',
];
for (let i = 0; i < clocks.length; i += 1) {
  const ctx = base({ location: { ...bostonLocation, iso: clockIsos[i] } });
  cases.push({ id: `clock-${i}`, now: clocks[i], context: ctx });
  cases.push({ id: `clock-${i}-tokyo`, now: clocks[i], context: base({ location: { ...bostonLocation, iso: clockIsos[i], city: 'tokyo', country: 'japan', countryCode: 'JP', state: 'Tokyo', stateAbbr: 'tk' } }) });
}

const out = path.join(here, '..', 'test', 'fixtures', 's05-prompt-contexts.json');
fs.writeFileSync(out, JSON.stringify(cases, null, 1));
process.stdout.write(`contexts=${cases.length}\n`);
