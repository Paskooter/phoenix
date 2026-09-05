import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptData } from '../src/graph/mims/promptData.js';

function withNow(iso, fn) {
  const original = Date.now;
  Date.now = () => Date.parse(iso);
  try {
    return fn();
  } finally {
    Date.now = original;
  }
}

function context({ iso, owner = 'owner', speaker = 'speaker', referent = null } = {}) {
  return {
    loop: {
      owner,
      jibo: { id: 'jibo', birthdate: Date.parse('2017-05-19T15:27:05Z'), color: 'WHITE' },
      users: [
        { id: 'owner', birthdate: Date.parse('1977-01-01T00:00:00Z'), gender: 'male', phoneticName: 'ghoti', firstName: 'George', lastName: 'Jetson' },
        { id: 'speaker', birthdate: Date.parse('1984-02-02T00:00:00Z'), gender: 'female', phoneticName: 'Jane', firstName: 'Jane', lastName: 'Jetson' },
        { id: 'referent', birthdate: Date.parse('2001-09-09T00:00:00Z'), gender: 'female', phoneticName: 'Judy', firstName: 'Judy', lastName: 'Jetson' },
      ],
    },
    location: {
      iso,
      city: 'boston', state: 'Massachusetts', stateAbbr: 'ma', country: 'usa', countryCode: 'US',
      lat: 42.313352, lng: -71.1273681,
    },
    perception: { peoplePresent: [], speaker },
    character: { emotion: { confidence: 0.2, valence: 0.45, name: 'NEUTRAL' } },
    dialog: { referent },
  };
}

test('S-05 PromptData uses the runtime offset for date fields and DateTime', () => {
  const data = withNow('2020-03-01T04:30:00.000Z', () => buildPromptData(context({ iso: '2020-02-29T23:30:00.000-05:00' })));

  assert.equal(data.dt.date, 'February 29th');
  assert.equal(data.dt.day, 'Saturday');
  assert.equal(data.dt.dayOfWeek, '6th');
  assert.equal(data.dt.dayOfMonth, '29th');
  assert.equal(data.dt.dayOfYear, '60th');
  assert.equal(data.dt.weekOfYear, '9th');
  assert.equal(data.dt.month, 'February');
  assert.equal(data.dt.monthOfYear, '2nd');
  assert.equal(data.dt.quarterOfYear, '1st');
  assert.equal(data.dt.year, '2020');
  assert.equal(data.dt.now.timezone.offsetUTC, -5 * 60 * 60 * 1000);
  assert.equal(data.dt.now.getLocalTime().date, 29);
  assert.equal(data.dt.now.getLocalYYYYMMDD(), '20200229');
  assert.equal(String(data.dt.now), 'february 29th 2020 at 11:30 PM');
});

test('S-05 handles UTC day/month/year boundaries and seasonal windows', () => {
  const data = withNow('2020-02-29T22:30:00.000Z', () => buildPromptData(context({ iso: '2020-03-01T00:30:00.000+02:00' })));

  assert.equal(data.dt.date, 'March 1st');
  assert.equal(data.dt.day, 'Sunday');
  assert.equal(data.dt.dayOfYear, '61st');
  assert.equal(data.dt.monthOfYear, '3rd');
  assert.equal(data.dt.quarterOfYear, '1st');
  assert.equal(data.dt.year, '2020');
  assert.equal(data.dt.now.isInRange('12/20', '1/5'), false);
  assert.equal(data.dt.now.isInRange('2/29', '3/1'), true);

  const newYear = withNow('2021-01-01T05:00:00.000Z', () => buildPromptData(context({ iso: '2021-01-01T00:00:00.000-05:00' })));
  assert.equal(newYear.dt.now.isInRange('12/20', '1/5'), true);
  assert.equal(newYear.dt.now.isInRange('1/2', '1/5'), false);
});

test('S-05 preserves source loop selection, pronounceable names, typed data and location methods', () => {
  const data = withNow('2018-05-22T23:21:00.159Z', () => buildPromptData(context({
    iso: '2018-05-22T19:21:00.159-04:00', referent: null,
  })));

  assert.equal(data.speaker.id, 'speaker');
  assert.equal(data.referent, null);
  assert.equal(data.loop.owner.id, 'owner');
  assert.equal(data.loop.list, 'ghoti, Jane and Judy');
  assert.equal(data.loop.count, 3);
  assert.equal(data.speaker.zodiac.supplemented, 'an Aquarius');
  assert.equal(data.speaker.age.value, 34);
  assert.equal(data.speaker.age.days.value, 12528);
  assert.equal(data.speaker.age.days.supplemented, '12528 days');
  assert.equal(data.jibo.color, 'WHITE');
  assert.equal(String(data.jibo.emotion), 'NEUTRAL');
  assert.equal(data.jibo.emotion.valence, 0.45);
  assert.equal(data.location.home.isInRegion('US'), true);
  assert.equal(data.location.home.isInRegion('US-MA'), true);
  assert.equal(data.location.home.isInRegion('CA'), false);
});

test('S-05 keeps the source date/location and loop guards independent', () => {
  const invalid = withNow('2020-02-29T04:30:00.000Z', () => buildPromptData(context({ iso: 'not-an-iso' })));
  assert.deepEqual(invalid.dt, {});
  assert.deepEqual(invalid.location, {});
  assert.equal(invalid.jibo.id, 'jibo');
  assert.equal(invalid.speaker.id, 'speaker');
  assert.equal(invalid.loop.count, 3);

  const missingIsoContext = context({ iso: '2020-01-01T00:00:00.000Z' });
  delete missingIsoContext.location.iso;
  const missingIso = withNow('2020-02-29T04:30:00.000Z', () => buildPromptData(missingIsoContext));
  assert.ok(missingIso.dt.now);
  assert.equal(missingIso.dt.now.timePeriod, 'now');
  assert.ok(missingIso.location.home);
  assert.equal(missingIso.speaker.id, 'speaker');
  assert.equal(missingIso.loop.count, 3);
});

test('S-05 rejects invalid runtime DateTime inputs while retaining the source loop offset', () => {
  for (const iso of ['2020-01-01T12:00:00+0530', true, {}, []]) {
    const data = withNow('2019-12-31T20:30:00.000Z', () => buildPromptData(context({ iso })));
    assert.deepEqual(data.dt, {});
    assert.deepEqual(data.location, {});
    assert.equal(data.loop.count, 3);
    assert.equal(data.loop.owner.isBirthday, typeof iso === 'string');
  }
});

test('S-05 preserves source partial loop state and last duplicate match', () => {
  const malformed = context({ speaker: 'owner' });
  malformed.loop.users = [malformed.loop.users[0], null];
  const partial = withNow('2020-02-29T04:30:00.000Z', () => buildPromptData(malformed));
  assert.equal(partial.jibo.id, 'jibo');
  assert.equal(partial.speaker.id, 'owner');
  assert.deepEqual(partial.loop, {});

  const duplicates = context({ speaker: 'dup' });
  duplicates.loop.owner = 'dup';
  duplicates.loop.users = [
    { id: 'dup', firstName: 'First', birthdate: Date.parse('1970-01-01T00:00:00Z'), phoneticName: 'One' },
    { id: 'dup', firstName: 'Second', birthdate: Date.parse('2001-09-09T00:00:00Z'), phoneticName: 'Two' },
  ];
  const selected = withNow('2020-02-29T04:30:00.000Z', () => buildPromptData(duplicates));
  assert.equal(selected.speaker.firstName, 'Second');
  assert.equal(selected.loop.owner.firstName, 'Second');
  assert.equal(selected.loop.count, 2);
});

test('S-05 exposes source long periods and permissive range parsing', () => {
  withNow('2020-03-01T04:30:00.000Z', () => {
    const data = buildPromptData(context({ iso: '2020-02-29T23:30:00.000-05:00' }));
    const year = data.dt.now.clone();
    year.timePeriod = 'year';
    const month = data.dt.now.clone();
    month.timePeriod = 'month';
    const week = data.dt.now.clone();
    week.timePeriod = 'week';
    const weekend = data.dt.now.clone();
    weekend.timePeriod = 'weekend';
    assert.equal(year.toString(), '2020');
    assert.equal(month.toString(), 'february');
    assert.equal(week.toString(), 'this week');
    assert.equal(weekend.toString(), 'this weekend');
    assert.equal(data.dt.now.isInRange('2/29', '2/28'), false);
    assert.equal(data.location.home.isLocal, true);
    assert.equal(data.location.home.getStandardName(), '');
    assert.equal(data.location.home.prefixIn(), '');
    assert.equal(String(data.location.home), 'Boston, MA');
  });
});

test('S-05 leaves standard data empty when location is absent', () => {
  const sourceShaped = context({ iso: '2020-01-01T00:00:00.000Z' });
  delete sourceShaped.location;
  const missingLocation = buildPromptData(sourceShaped);
  assert.equal(missingLocation.speaker, null);
  assert.deepEqual(missingLocation.dt, {});
  assert.deepEqual(missingLocation.location, {});
  assert.deepEqual(missingLocation.loop, {});

});

test('S-05 leaves empty and incomplete runtimes at source defaults', () => {
  const empty = buildPromptData({});
  assert.equal(empty.speaker, null);
  assert.equal(empty.referent, null);
  assert.equal(empty.jibo, null);
  assert.deepEqual(empty.dt, {});
  assert.deepEqual(empty.location, {});
  assert.deepEqual(empty.loop, {});

  // A location alone is enough for date/location data, but source PromptData
  // waits for all runtime sections before constructing loop members.
  const incomplete = buildPromptData({
    location: { iso: '2020-01-15T12:00:00.000Z' },
    perception: { speaker: 'u1' },
    loop: { users: [{ id: 'u1', firstName: 'Pat' }] },
  });
  assert.equal(incomplete.speaker, null);
  assert.equal(incomplete.referent, null);
  assert.equal(incomplete.jibo, null);
  assert.ok(incomplete.dt.now);
  assert.ok(incomplete.location.home);
  assert.deepEqual(incomplete.loop, {});
});
