// S-05 differential probe — Phoenix candidate PromptData.
//
// Body-identical to s05-context-matrix-source.cjs except for the import.
//
// usage: S05_CANDIDATE_ROOT=/path/to/phoenix node s05-context-matrix-candidate.mjs <contexts.json> <out.json>
import fs from 'node:fs';

const candidateRoot = process.env.S05_CANDIDATE_ROOT || '/phoenix';
const { buildPromptData } = await import(`${candidateRoot}/packages/skills/src/graph/mims/promptData.js`);

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const log = { createChild: function () { return this; }, warn: function () {} };
const safe = fn => { try { return fn(); } catch (e) { return { error: e && e.message || String(e) }; } };
const UNITS = ['milliseconds', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'];

function ageSummary(age) {
  if (age === null || age === undefined) return age === null ? null : undefined;
  const out = { value: safe(() => age.value), supplemented: safe(() => age.supplemented), string: safe(() => String(age)) };
  for (const unit of UNITS) {
    const item = age[unit];
    out[unit] = item === undefined ? undefined : {
      value: safe(() => item.value), supplemented: safe(() => item.supplemented), string: safe(() => String(item)),
    };
  }
  return out;
}
function nlSummary(value, extra) {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return { ...extra, value: safe(() => value.value), supplemented: safe(() => value.supplemented), string: safe(() => String(value)) };
}
function looperSummary(value) {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return {
    id: safe(() => value.id), firstName: safe(() => value.firstName), lastName: safe(() => value.lastName),
    gender: safe(() => value.gender), string: safe(() => String(value)),
    birthdate: value.birthdate, birthday: value.birthday, isBirthday: value.isBirthday,
    age: ageSummary(value.age), zodiac: nlSummary(value.zodiac),
  };
}
function jiboSummary(value) {
  if (value === null || value === undefined) return value === null ? null : undefined;
  return {
    id: safe(() => value.id), color: safe(() => value.color), string: safe(() => String(value)),
    birthdate: value.birthdate, birthday: value.birthday, isBirthday: value.isBirthday,
    age: ageSummary(value.age), zodiac: nlSummary(value.zodiac),
    emotion: value.emotion === null || value.emotion === undefined ? value.emotion : {
      valence: safe(() => value.emotion.valence), confidence: safe(() => value.emotion.confidence), string: safe(() => String(value.emotion)),
    },
  };
}
function locationSummary(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return {
    city: value.city, state: value.state, stateAbbr: value.stateAbbr, country: value.country,
    countryCode: value.countryCode, lat: value.lat, lng: value.lng,
    string: safe(() => String(value)), prefix: safe(() => value.prefixIn()), standard: safe(() => value.getStandardName()),
    log: safe(() => value.toLog()), isLocal: safe(() => value.isLocal), json: safe(() => value.toJSON()),
    regions: {
      us: safe(() => value.isInRegion('US')), usma: safe(() => value.isInRegion('US-MA')),
      ca: safe(() => value.isInRegion('CA')), array: safe(() => value.isInRegion(['CA', 'US'])),
      emptyArray: safe(() => value.isInRegion([])), number: safe(() => value.isInRegion(42)),
      sparseObject: safe(() => value.isInRegion({ length: 1, 0: 'CA' })), nullRegions: safe(() => value.isInRegion(null)),
    },
    equalsNull: safe(() => value.equals(null)), equalsSelf: safe(() => value.equals(value)),
  };
}
function dtSummary(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return {
    json: safe(() => value.toJSON()), string: safe(() => String(value)),
    o0: safe(() => value.toString()), display: safe(() => value.toString({ display: true })),
    timeOnly: safe(() => value.toString({ timeOnly: true })), dateOnly: safe(() => value.toString({ dateOnly: true })),
    prefix: safe(() => value.toString({ prefixOnAt: true })), prefixed: safe(() => value.prefixOnAt()),
    local: safe(() => value.getLocalTime()), relDays: safe(() => value.getRelativeDays()),
    isFuture: safe(() => value.isFuture()), mmdd: safe(() => value.getLocalMMDD()), yyyymmdd: safe(() => value.getLocalYYYYMMDD()),
    ranges: {
      valid: safe(() => value.isInRange('12/20', '1/5')), same: safe(() => value.isInRange('2/29', '3/1')),
      winter: safe(() => value.isInRange('12/1', '2/28')), summer: safe(() => value.isInRange('6/1', '9/30')),
      inverted: safe(() => value.isInRange('9/30', '6/1')), invalid: safe(() => value.isInRange('bad', '1/5')),
      zero: safe(() => value.isInRange('0/0', '13/32')),
    },
  };
}
function summarize(data) {
  return {
    speaker: looperSummary(data.speaker), referent: looperSummary(data.referent), jibo: jiboSummary(data.jibo),
    dt: {
      date: data.dt && data.dt.date, day: data.dt && data.dt.day, dayOfWeek: data.dt && data.dt.dayOfWeek,
      dayOfMonth: data.dt && data.dt.dayOfMonth, dayOfYear: data.dt && data.dt.dayOfYear,
      weekOfYear: data.dt && data.dt.weekOfYear, month: data.dt && data.dt.month,
      monthOfYear: data.dt && data.dt.monthOfYear, quarterOfYear: data.dt && data.dt.quarterOfYear,
      year: data.dt && data.dt.year, now: dtSummary(data.dt && data.dt.now),
    },
    location: data.location && {
      home: locationSummary(data.location.home), city: data.location.city, state: data.location.state,
      stateAbbr: data.location.stateAbbr, country: data.location.country, countryCode: data.location.countryCode,
      lat: data.location.lat, lng: data.location.lng,
    },
    loop: data.loop && { owner: looperSummary(data.loop.owner), list: data.loop.list, count: data.loop.count },
  };
}

const output = [];
for (const item of cases) {
  Date.now = () => Date.parse(item.now);
  let result;
  try { result = summarize(buildPromptData(item.context)); } catch (e) { result = { thrown: e && e.message || String(e) }; }
  output.push({ id: item.id, result });
}
fs.writeFileSync(process.argv[3], JSON.stringify(output));
