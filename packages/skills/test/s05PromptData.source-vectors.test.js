import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptData } from '../src/graph/mims/promptData.js';

// These vectors are taken from the frozen Pegasus Node8 PromptData test and a
// direct run of its compiled PromptData.js with the same fixed clock. Keeping
// the input context and primitive assertions here makes the source comparison
// reproducible without starting the original service or depending on a golden.
const STILL_TODAY_UTC = '2018-05-22T19:21:00.159-04:00';
const IS_TOMORROW_UTC = '2018-05-22T21:21:00.159-04:00';

function sourceContext(iso) {
  return {
    loop: {
      owner: 'test-looper-id-2',
      jibo: { id: 'test-looper-id-1', birthdate: 1495216025271, color: 'WHITE' },
      users: [
        {
          id: 'test-looper-id-2', birthdate: 220924800000, gender: 'male',
          phoneticName: 'ghoti', lastName: 'Jetson', firstName: 'George',
        },
        {
          id: 'test-looper-id-3', birthdate: 444528000000, gender: 'female',
          phoneticName: 'Jane', lastName: 'Jetson', firstName: 'Jane',
        },
      ],
    },
    location: {
      iso, city: 'boston', state: 'Massachusetts', stateAbbr: 'ma',
      country: 'usa', countryCode: 'US', lat: 42.313352, lng: -71.1273681,
    },
    perception: { peoplePresent: [], speaker: 'test-looper-id-3' },
    character: { emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent: null },
  };
}

function withNow(iso, fn) {
  const original = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

test('S-05 source timezone vectors keep the original local day', () => {
  assert.equal(withNow(STILL_TODAY_UTC, () => buildPromptData(sourceContext(STILL_TODAY_UTC)).dt.day), 'Tuesday');
  assert.equal(withNow(IS_TOMORROW_UTC, () => buildPromptData(sourceContext(IS_TOMORROW_UTC)).dt.day), 'Tuesday');
});

test('S-05 source birthday and age vector keeps Node8 values', () => {
  const actual = withNow(STILL_TODAY_UTC, () => {
    const data = buildPromptData(sourceContext(STILL_TODAY_UTC));
    return {
      values: {
        date: data.dt.date,
        day: data.dt.day,
        weekOfYear: data.dt.weekOfYear,
        now: String(data.dt.now),
        birthdate: data.speaker.birthdate,
        birthday: data.speaker.birthday,
        isBirthday: data.speaker.isBirthday,
        zodiac: data.speaker.zodiac.supplemented,
        age: {
          milliseconds: data.speaker.age.milliseconds.value,
          seconds: data.speaker.age.seconds.value,
          minutes: data.speaker.age.minutes.value,
          hours: data.speaker.age.hours.value,
          days: data.speaker.age.days.value,
          weeks: data.speaker.age.weeks.value,
          months: data.speaker.age.months.value,
          years: data.speaker.age.years.value,
        },
      },
      nowJSON: data.dt.now.toJSON(),
    };
  });
  assert.deepEqual(actual.values, {
    date: 'May 22nd',
    day: 'Tuesday',
    weekOfYear: '21st',
    now: '7:21 PM',
    birthdate: 'February 2nd 1984',
    birthday: 'February 2nd',
    isBirthday: false,
    zodiac: 'an Aquarius',
    age: {
      milliseconds: 1082503260159,
      seconds: 1082503260,
      minutes: 18041721,
      hours: 300695,
      days: 12528,
      weeks: 1789,
      months: 411,
      years: 34,
    },
  });
  assert.deepEqual(actual.nowJSON, {
    __type: 'DateTime',
    utc: 1527031260159,
    timezone: { __type: 'Timezone', offsetUTC: -14400000, name: 'Unknown', id: 'Unknown' },
    durationDays: 0,
    durationHours: 0,
    durationMinutes: 0,
    timePeriod: 'minute',
  });
});
