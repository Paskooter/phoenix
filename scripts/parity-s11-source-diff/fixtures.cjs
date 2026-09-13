'use strict';

// The archived Commute.test.js uses TestUtils to create Maps and Calendar
// payloads.  This file is the small deterministic equivalent shared by the
// source oracle and the Phoenix candidate.  The parser, MIM logic, and view
// builder always come from the side under test.

var DAY_MS = 24 * 60 * 60 * 1000;

var DEFAULT_OPTS = {
  commute: { minsBaseline: 10, minsInTraffic: 10 },
  calendar: { numberOfEvents: 1, hrsUntilFirstEvent: 4 },
  localISO: '2017-11-09T08:00:00.000-05:00',
};

var DEFAULT_PREFS = {
  weather: { active: true },
  commute: {
    active: true,
    workTime: { hour: 9, min: 0 },
    origin: { lat: 42, lng: 24 },
    destination: { lat: 24, lng: 42 },
    mode: 'driving',
    complete: true,
  },
  calendar: { active: true, googlePersonalCreds: true },
  news: {
    active: true,
    activeNewsCategories: { general: true, technology: true, sports: true, business: true },
  },
  cats: { active: 'all' },
};

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function merge(base, patch) {
  if (patch === undefined) return clone(base);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  var result = (base && typeof base === 'object' && !Array.isArray(base)) ? clone(base) : {};
  Object.keys(patch).forEach(function (key) {
    result[key] = (patch[key] && typeof patch[key] === 'object' && !Array.isArray(patch[key]))
      ? merge(result[key], patch[key])
      : clone(patch[key]);
  });
  return result;
}

function makeOptions(run) { return merge(DEFAULT_OPTS, run.opts || {}); }
function makePrefs(run) {
  var prefs = merge(DEFAULT_PREFS, run.prefs || {});
  if (run.replacePrefs) {
    Object.keys(run.replacePrefs).forEach(function (key) {
      prefs[key] = clone(run.replacePrefs[key]);
    });
  }
  var cats = prefs.cats || {};
  var active = cats.active;
  if (!cats || active === undefined || active === 'all') active = ['weather', 'calendar', 'commute', 'news'];
  else if (active === 'none') active = [];
  else if (cats.userNotIDed) active = ['weather', 'news'];
  var includes = function (category) {
    return Array.isArray(active) ? active.indexOf(category) !== -1 : String(active).indexOf(category) !== -1;
  };
  ['weather', 'calendar', 'commute', 'news'].forEach(function (category) {
    prefs[category] = merge(prefs[category], { active: includes(category) });
  });
  return prefs;
}

function offsetFromISO(iso) {
  var match = /([+-])(\d{2}):?(\d{2})\s*$/.exec(String(iso));
  if (!match) return { ms: 0, text: 'Z' };
  var minutes = Number(match[2]) * 60 + Number(match[3]);
  return {
    ms: (match[1] === '-' ? -1 : 1) * minutes * 60 * 1000,
    text: match[1] + match[2] + ':' + match[3],
  };
}

function pad(value, width) {
  var text = String(value);
  while (text.length < width) text = '0' + text;
  return text;
}

// jibo-data-utils DateTime.toISOString() preserves the input timezone offset.
// Keep the same contract without importing a date library into the harness.
function isoAt(iso, deltaMs) {
  var offset = offsetFromISO(iso);
  var local = new Date(Date.parse(iso) + deltaMs + offset.ms);
  return pad(local.getUTCFullYear(), 4) + '-' + pad(local.getUTCMonth() + 1, 2) + '-' +
    pad(local.getUTCDate(), 2) + 'T' + pad(local.getUTCHours(), 2) + ':' +
    pad(local.getUTCMinutes(), 2) + ':' + pad(local.getUTCSeconds(), 2) + '.' +
    pad(local.getUTCMilliseconds(), 3) + offset.text;
}

function createRawCalendarData(opts, calPrefs) {
  var connected = calPrefs && (calPrefs.googlePersonalCreds || calPrefs.googleWorkCreds
    || calPrefs.outlookPersonalCreds || calPrefs.outlookWorkCreds);
  if (!connected) return null;
  if (opts === null) return undefined;
  if (opts && opts.rawData) return clone(opts.rawData);
  var merged = merge({
    numberOfEvents: 1,
    hrsUntilFirstEvent: 1,
    hrsBetweenEvents: 4,
    summaryText: 'Event',
    localISO: '2017-11-09T08:00:00.000-05:00',
    addFullDayEvent: null,
  }, opts || {});
  var events = [];
  if (merged.addFullDayEvent) {
    var fullDayISO = isoAt(merged.localISO, 0);
    // TestUtils creates a DateTime at local midnight, then optionally adds a
    // calendar day.  These fixtures are away from a DST boundary.
    fullDayISO = isoAt(fullDayISO.slice(0, 11) + '00:00:00.000' + offsetFromISO(fullDayISO).text,
      merged.addFullDayEvent.tomorrow ? DAY_MS : 0);
    events.push({
      summary: 'Wedding Anniversary',
      start: { dateTime: fullDayISO, timestamp: Date.parse(fullDayISO) },
      fullDay: true,
    });
  }
  for (var i = 0; i < merged.numberOfEvents; i += 1) {
    var dateTime = isoAt(merged.localISO,
      (merged.hrsUntilFirstEvent + merged.hrsBetweenEvents * i) * 60 * 60 * 1000);
    events.push({
      summary: merged.summaryText ? merged.summaryText + ' ' + (i + 1) : null,
      start: { dateTime: dateTime, timestamp: Date.parse(dateTime) },
      fullDay: false,
    });
  }
  return events;
}

function createRawCommuteData(opts) {
  if (opts === null) return undefined;
  var merged = Object.assign({ minsBaseline: 18, minsInTraffic: 25 }, opts || {});
  function legData(minutes) {
    return { text: minutes + ' mins', value: minutes * 60 };
  }
  return {
    routes: [{ legs: [{
      duration: legData(merged.minsBaseline),
      duration_in_traffic: merged.minsInTraffic && legData(merged.minsInTraffic),
    }] }],
  };
}

function makeRuntime(localISO) {
  return {
    perception: {},
    loop: { loopId: 'loop-1', users: [] },
    location: { iso: localISO },
  };
}

function makeLog() {
  var log = {
    createChild: function () { return log; },
    debug: function () {},
    info: function () {},
    warn: function () {},
    error: function () {},
  };
  return log;
}

function makeSkillData(userPrefs, localISO) {
  return {
    skill: { session: { data: { _personalReport: {} } } },
    local: { views: {}, userPrefs: userPrefs },
    runtime: makeRuntime(localISO),
    log: makeLog(),
    req: { jibo: { transID: 'placeholder-trans-id' } },
  };
}

function materialize(run) {
  var opts = makeOptions(run);
  var prefs = makePrefs(run);
  var rawCommute = run.mapsData === null ? null : createRawCommuteData(opts.commute);
  // Commute.test.js calls Object.assign({ localISO }, opts.calendar), including
  // when opts.calendar is null. Object.assign ignores null and therefore still
  // supplies the default calendar event; retain that source-backed behavior.
  var rawCalendar = createRawCalendarData(Object.assign({ localISO: opts.localISO }, opts.calendar), prefs.calendar);
  return {
    opts: opts,
    prefs: prefs,
    localISO: opts.localISO,
    rawCommute: rawCommute,
    rawCalendar: rawCalendar,
    data: makeSkillData(prefs, opts.localISO),
  };
}

function projectUndefined(value) {
  return value === undefined ? { __phoenixType: 'undefined' } : value;
}

function encode(value) {
  if (value === undefined) return projectUndefined(value);
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    var result = {};
    Object.keys(value).forEach(function (key) { result[key] = encode(value[key]); });
    return result;
  }
  return value;
}

function projectMimPath(value, roots) {
  if (typeof value !== 'string') return projectUndefined(value);
  var normalized = value.replace(/\\/g, '/');
  roots = roots || {};
  var sourceRoot = String(roots.sourceMimRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  var candidateRoot = String(roots.candidateMimRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (sourceRoot && normalized.indexOf(sourceRoot + '/') === 0) return 'mims/en-us/' + normalized.slice(sourceRoot.length + 1);
  if (candidateRoot && normalized.indexOf(candidateRoot + '/') === 0) return 'mims/en-us/' + normalized.slice(candidateRoot.length + 1);
  // An unrecognized root or inserted directory remains visible in the
  // projection and therefore cannot be hidden by basename normalization.
  return normalized;
}

function projectDateTime(dt) {
  if (dt === undefined) return projectUndefined(dt);
  if (dt === null) return null;
  var local = dt.getLocalTime();
  return {
    utc: dt.utc,
    timeOnly: dt.toString({ timeOnly: true }),
    local: {
      year: local.year,
      monthNum: local.monthNum,
      date: local.date,
      hour: local.hour,
      minute: local.minute,
    },
  };
}

function projectCommute(commute) {
  if (commute === undefined) return projectUndefined(commute);
  if (commute === null) return null;
  return encode({
    departDT: projectDateTime(commute.departDT),
    arriveDT: projectDateTime(commute.arriveDT),
    minsLeft: commute.minsLeft,
    modeIsDriving: commute.modeIsDriving,
    eventIsEarly: commute.eventIsEarly,
    durationMins: commute.durationMins,
    extraMins: commute.extraMins,
  });
}

function projectView(view) { return view === undefined ? projectUndefined(view) : encode(clone(view)); }

function projectLocal(local, roots) {
  return {
    commute: projectCommute(local && local.commute),
    mims: ((local && local.mimPaths) || []).map(function (value) { return projectMimPath(value, roots); }),
    views: {
      commuteTraffic: projectView(local && local.views && local.views.commuteTraffic),
      commuteDepart: projectView(local && local.views && local.views.commuteDepart),
    },
  };
}

function stable(value) {
  if (value === undefined) return projectUndefined(value);
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce(function (out, key) {
      out[key] = stable(value[key]);
      return out;
    }, {});
  }
  if (typeof value === 'number' && isNaN(value)) return 'NaN';
  return value;
}

module.exports = {
  clone: clone,
  makeOptions: makeOptions,
  makePrefs: makePrefs,
  createRawCalendarData: createRawCalendarData,
  createRawCommuteData: createRawCommuteData,
  makeSkillData: makeSkillData,
  materialize: materialize,
  projectCommute: projectCommute,
  projectLocal: projectLocal,
  projectMimPath: projectMimPath,
  projectUndefined: projectUndefined,
  encode: encode,
  stable: stable,
};
