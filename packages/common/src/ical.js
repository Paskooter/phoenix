// Small, dependency-free RFC 5545 parser used by the account subscription store and the
// report skill. It deliberately returns the report skill's event shape rather than exposing
// parser internals to either caller.

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPANSIONS = 10000;
const WEEKDAYS = Object.freeze({ SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 });
const RECURRENCE_KEYS = new Set([
  'FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST',
]);

export class IcalParseError extends Error {
  constructor(message) {
    super(`iCal: ${message}`);
    this.name = 'IcalParseError';
  }
}

function parseError(message) {
  throw new IcalParseError(message);
}

/** RFC 5545 content lines may continue on a line beginning with SP or HTAB. */
export function unfoldIcalLines(input) {
  if (typeof input !== 'string') parseError('calendar body must be text');
  const physical = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines = [];
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length) {
      lines.push(line);
    }
  }
  return lines;
}

function unquote(value) {
  const text = String(value ?? '');
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"')
    ? text.slice(1, -1) : text;
}

function parseContentLine(line) {
  const colon = line.indexOf(':');
  if (colon <= 0) parseError('malformed content line');
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const pieces = left.split(';');
  const namePart = pieces.shift();
  const dotted = namePart.lastIndexOf('.');
  const name = namePart.slice(dotted + 1).toUpperCase();
  const params = {};
  for (const piece of pieces) {
    const equals = piece.indexOf('=');
    if (equals <= 0) parseError('malformed content-line parameter');
    params[piece.slice(0, equals).toUpperCase()] = unquote(piece.slice(equals + 1));
  }
  return { name, params, value };
}

function firstProperty(properties, name) {
  return properties.find((property) => property.name === name) || null;
}

function allProperties(properties, name) {
  return properties.filter((property) => property.name === name);
}

function unescapeText(value) {
  return String(value ?? '').replace(/\\([nN,;\\])/g, (_match, token) => {
    if (token === 'n' || token === 'N') return '\n';
    return token;
  });
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeWindow(options) {
  const start = options.windowStart instanceof Date ? options.windowStart.getTime() : Number(options.windowStart);
  const end = options.windowEnd instanceof Date ? options.windowEnd.getTime() : Number(options.windowEnd);
  return {
    start: isFiniteNumber(start) ? start : null,
    end: isFiniteNumber(end) ? end : null,
  };
}

function fixedOffsetMinutes(zone) {
  const normalized = String(zone || '').toUpperCase();
  if (!normalized || normalized === 'UTC' || normalized === 'GMT' || normalized === 'Z'
    || normalized === 'ETC/UTC' || normalized === 'ETC/GMT') return 0;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(normalized);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (hours > 23 || minutes > 59) parseError('invalid timezone offset');
  return (match[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
}

function assertTimeZone(zone) {
  const candidate = String(zone || 'UTC');
  if (fixedOffsetMinutes(candidate) !== null) return candidate;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format();
  } catch {
    parseError('unsupported timezone');
  }
  return candidate;
}

function civilMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0);
}

function civilParts(ms) {
  const date = new Date(ms);
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
    hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds(),
  };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidCivilDate(year, month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function addCivilDays(parts, days) {
  const date = new Date(civilMs(parts) + days * DAY_MS);
  return civilParts(date.getTime());
}

function addCivilMonths(parts, months) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + months, 1, parts.hour || 0, parts.minute || 0, parts.second || 0));
  return {
    year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: Math.min(parts.day, daysInMonth(date.getUTCFullYear(), date.getUTCMonth() + 1)),
    hour: parts.hour || 0, minute: parts.minute || 0, second: parts.second || 0,
  };
}

function partsEqual(a, b) {
  return a.year === b.year && a.month === b.month && a.day === b.day
    && a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

function zoneParts(timestamp, zone) {
  const fixed = fixedOffsetMinutes(zone);
  if (fixed !== null) return civilParts(timestamp + fixed * 60 * 1000);
  const pieces = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(pieces.filter((piece) => piece.type !== 'literal').map((piece) => [piece.type, piece.value]));
  return {
    year: Number(values.year), month: Number(values.month), day: Number(values.day),
    hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
  };
}

function offsetAt(timestamp, zone) {
  const fixed = fixedOffsetMinutes(zone);
  if (fixed !== null) return fixed;
  return Math.round((civilMs(zoneParts(timestamp, zone)) - timestamp) / 60000);
}

function localPartsToTimestamp(parts, zone) {
  const fixed = fixedOffsetMinutes(zone);
  if (fixed !== null) return civilMs(parts) - fixed * 60 * 1000;
  let guess = civilMs(parts);
  // A couple of iterations handles both normal DST changes and the offset change at
  // midnight in zones such as Pacific/Apia. Intl is the timezone database of record.
  for (let i = 0; i < 5; i += 1) guess = civilMs(parts) - offsetAt(guess, zone) * 60 * 1000;
  const actual = zoneParts(guess, zone);
  if (!partsEqual(actual, parts)) {
    // A nonexistent wall time is not representable. Rejecting it makes a bad source
    // visible instead of shifting a meeting by an hour without telling the owner.
    parseError('nonexistent local time');
  }
  return guess;
}

function offsetText(minutes) {
  if (minutes === 0) return 'Z';
  const sign = minutes < 0 ? '-' : '+';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function formatDateTime(timestamp, zone) {
  const local = zoneParts(timestamp, zone);
  const date = `${String(local.year).padStart(4, '0')}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  const time = `${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:${String(local.second).padStart(2, '0')}`;
  return `${date}T${time}${offsetText(offsetAt(timestamp, zone))}`;
}

function parseDateValue(value, params, defaultZone) {
  const raw = String(value || '').trim();
  const zoneParam = params.TZID ? unquote(params.TZID) : null;
  const valueType = String(params.VALUE || '').toUpperCase();
  const dateOnly = valueType === 'DATE' || /^\d{8}$/.test(raw);
  if (dateOnly) {
    if (!/^\d{8}$/.test(raw)) parseError('invalid DATE value');
    const parts = {
      year: Number(raw.slice(0, 4)), month: Number(raw.slice(4, 6)), day: Number(raw.slice(6, 8)),
      hour: 0, minute: 0, second: 0,
    };
    if (!isValidCivilDate(parts.year, parts.month, parts.day)) parseError('invalid DATE value');
    const zone = assertTimeZone(zoneParam || defaultZone || 'UTC');
    return { ...parts, dateOnly: true, zone, timestamp: localPartsToTimestamp(parts, zone) };
  }

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/i.exec(raw);
  if (!match) parseError('invalid DATE-TIME value');
  const parts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6]),
  };
  if (!isValidCivilDate(parts.year, parts.month, parts.day) || parts.hour > 23 || parts.minute > 59 || parts.second > 59) {
    parseError('invalid DATE-TIME value');
  }
  const zone = match[7] ? 'UTC' : assertTimeZone(zoneParam || defaultZone || 'UTC');
  return { ...parts, dateOnly: false, zone, timestamp: localPartsToTimestamp(parts, zone) };
}

function parseDuration(value) {
  const match = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value || '').trim());
  if (!match || match[1] === undefined && match[2] === undefined && match[3] === undefined
    && match[4] === undefined && match[5] === undefined) parseError('invalid DURATION value');
  const weeks = Number(match[1] || 0);
  const days = Number(match[2] || 0) + weeks * 7;
  const hours = Number(match[3] || 0);
  const minutes = Number(match[4] || 0);
  const seconds = Number(match[5] || 0);
  return { days, milliseconds: (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 };
}

function parseRule(value, defaultZone) {
  const rule = {};
  for (const part of String(value || '').split(';')) {
    const equals = part.indexOf('=');
    if (equals <= 0) parseError('malformed RRULE');
    const key = part.slice(0, equals).toUpperCase();
    const raw = part.slice(equals + 1);
    if (!RECURRENCE_KEYS.has(key)) {
      // Unsupported recurrence is an explicit parse failure, never a silently dropped event.
      parseError('unsupported RRULE component');
    }
    if (key === 'FREQ') rule.freq = raw.toUpperCase();
    else if (key === 'INTERVAL' || key === 'COUNT') {
      const number = Number(raw);
      if (!Number.isInteger(number) || number < 1) parseError('invalid RRULE number');
      rule[key.toLowerCase()] = number;
    } else if (key === 'BYMONTH' || key === 'BYMONTHDAY') {
      const numbers = raw.split(',').map((partValue) => Number(partValue));
      if (!numbers.length || numbers.some((number) => !Number.isInteger(number) || number === 0)) parseError('invalid RRULE list');
      rule[key.toLowerCase()] = numbers;
    } else if (key === 'BYDAY') {
      rule.byday = raw.split(',').map((token) => {
        const match = /^([+-]?\d{1,2})?([A-Z]{2})$/i.exec(token);
        if (!match || WEEKDAYS[match[2].toUpperCase()] === undefined) parseError('invalid RRULE BYDAY');
        return { ordinal: match[1] ? Number(match[1]) : null, day: match[2].toUpperCase() };
      });
    } else if (key === 'WKST') {
      const wkst = raw.toUpperCase();
      if (WEEKDAYS[wkst] === undefined) parseError('invalid RRULE WKST');
      rule.wkst = wkst;
    } else if (key === 'UNTIL') {
      rule.until = parseDateValue(raw, {}, defaultZone);
      if (rule.until.dateOnly) rule.until.timestamp = localPartsToTimestamp(addCivilDays(rule.until, 1), rule.until.zone) - 1;
    }
  }
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) parseError('unsupported RRULE FREQ');
  if (rule.byday?.some((entry) => entry.ordinal !== null)
    && (rule.freq === 'DAILY' || rule.freq === 'WEEKLY')) {
    parseError('ordinal BYDAY is supported only for monthly and yearly RRULEs');
  }
  rule.interval = rule.interval || 1;
  return rule;
}

function weekday(parts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function compareCivil(a, b) {
  return civilMs(a) - civilMs(b);
}

function matchesSimpleFilters(parts, rule, base) {
  if (rule.bymonth && !rule.bymonth.includes(parts.month)) return false;
  if (rule.bymonthday) {
    const max = daysInMonth(parts.year, parts.month);
    const allowed = rule.bymonthday.map((day) => (day < 0 ? max + day + 1 : day));
    if (!allowed.includes(parts.day)) return false;
  }
  if (rule.byday && rule.freq !== 'MONTHLY' && rule.freq !== 'YEARLY') {
    const allowed = rule.byday.filter((entry) => entry.ordinal === null).map((entry) => WEEKDAYS[entry.day]);
    if (allowed.length && !allowed.includes(weekday(parts))) return false;
  }
  void base;
  return true;
}

function monthCandidates(year, month, rule, base) {
  const max = daysInMonth(year, month);
  const dates = new Set();
  if (rule.bymonthday) {
    for (const day of rule.bymonthday) {
      const actual = day < 0 ? max + day + 1 : day;
      if (actual >= 1 && actual <= max) dates.add(actual);
    }
    if (rule.byday) {
      if (rule.byday.some((entry) => entry.ordinal !== null)) {
        parseError('ordinal BYDAY cannot be combined with BYMONTHDAY');
      }
      const weekdays = rule.byday.map((entry) => WEEKDAYS[entry.day]);
      for (const day of dates) {
        if (!weekdays.includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) dates.delete(day);
      }
    }
  } else if (rule.byday) {
    for (const entry of rule.byday) {
      const target = WEEKDAYS[entry.day];
      if (entry.ordinal) {
        if (entry.ordinal > 0) {
          const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
          const day = 1 + ((target - first + 7) % 7) + (entry.ordinal - 1) * 7;
          if (day <= max) dates.add(day);
        } else {
          const last = new Date(Date.UTC(year, month - 1, max)).getUTCDay();
          const day = max - ((last - target + 7) % 7) + (entry.ordinal + 1) * 7;
          if (day >= 1) dates.add(day);
        }
      } else {
        for (let day = 1; day <= max; day += 1) {
          if (new Date(Date.UTC(year, month - 1, day)).getUTCDay() === target) dates.add(day);
        }
      }
    }
  } else if (base.day <= max) {
    dates.add(base.day);
  }
  return [...dates].sort((a, b) => a - b).map((day) => ({
    year, month, day, hour: base.hour, minute: base.minute, second: base.second,
  }));
}

function mondayOfWeek(parts, wkst) {
  const current = weekday(parts);
  const start = WEEKDAYS[wkst || 'MO'];
  return addCivilDays({ ...parts, hour: 0, minute: 0, second: 0 }, -((current - start + 7) % 7));
}

function recurrenceWindow(window, start) {
  const startTimestamp = window.start ?? start.timestamp - DAY_MS;
  const endTimestamp = window.end ?? Date.now() + 366 * DAY_MS;
  return {
    start: startTimestamp,
    end: endTimestamp,
    endCivil: civilParts(endTimestamp + offsetAt(endTimestamp, start.zone) * 60 * 1000),
  };
}

function expandRecurrence({ start, rule, exdates, rdates, window, maxOccurrences }) {
  const target = recurrenceWindow(window, start);
  const candidates = [];
  let generated = 0;
  let periods = 0;
  const base = { year: start.year, month: start.month, day: start.day, hour: start.hour, minute: start.minute, second: start.second };
  const addCandidate = (parts) => {
    if (compareCivil(parts, base) < 0 || !matchesSimpleFilters(parts, rule, base)) return false;
    const occurrence = { ...parts, dateOnly: start.dateOnly, zone: start.zone, timestamp: localPartsToTimestamp(parts, start.zone) };
    if (rule.until && occurrence.timestamp > rule.until.timestamp) return 'stop';
    generated += 1;
    if (generated > (rule.count || Number.MAX_SAFE_INTEGER)) return 'stop';
    if (!exdates.has(occurrence.timestamp) && occurrence.timestamp < target.end && occurrence.timestamp >= target.start) {
      candidates.push(occurrence);
      if (candidates.length >= maxOccurrences) parseError('RRULE expansion exceeded the occurrence limit');
    }
    return false;
  };

  while (periods < MAX_EXPANSIONS) {
    let periodCandidates;
    if (rule.freq === 'DAILY') {
      periodCandidates = [{ ...addCivilDays(base, periods * rule.interval) }];
    } else if (rule.freq === 'WEEKLY') {
      const week = addCivilDays(mondayOfWeek(base, rule.wkst), periods * rule.interval * 7);
      const bydays = rule.byday?.filter((entry) => entry.ordinal === null).map((entry) => WEEKDAYS[entry.day])
        || [weekday(base)];
      periodCandidates = bydays.map((day) => {
        const parts = addCivilDays(week, (day - WEEKDAYS[rule.wkst || 'MO'] + 7) % 7);
        return { ...parts, hour: base.hour, minute: base.minute, second: base.second };
      });
    } else if (rule.freq === 'MONTHLY') {
      const month = addCivilMonths({ ...base, day: 1 }, periods * rule.interval);
      periodCandidates = monthCandidates(month.year, month.month, rule, base);
    } else {
      const year = base.year + periods * rule.interval;
      const months = rule.bymonth || [base.month];
      periodCandidates = months.flatMap((month) => monthCandidates(year, month, rule, base));
    }

    periodCandidates.sort((a, b) => compareCivil(a, b));
    let shouldStop = false;
    for (const candidate of periodCandidates) {
      const result = addCandidate(candidate);
      if (result === 'stop') { shouldStop = true; break; }
    }
    if (shouldStop) break;
    const last = periodCandidates.at(-1);
    if (!last) {
      periods += 1;
      continue;
    }
    if (compareCivil(last, target.endCivil) > 0 && !rule.count && !rule.until) break;
    if (rule.count && generated >= rule.count) break;
    if (rule.until && localPartsToTimestamp(last, start.zone) > rule.until.timestamp) break;
    periods += 1;
  }
  if (periods >= MAX_EXPANSIONS) parseError('RRULE expansion exceeded the period limit');

  for (const rdate of rdates) {
    if (rdate.timestamp >= target.start && rdate.timestamp < target.end && !exdates.has(rdate.timestamp)) {
      candidates.push(rdate);
    }
  }
  return candidates.filter((item, index, all) => all.findIndex((other) => other.timestamp === item.timestamp) === index)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function eventOverlaps(start, end, window) {
  return (window.start === null || end > window.start) && (window.end === null || start < window.end);
}

function eventDuration(start, end, duration) {
  if (start.dateOnly) {
    const days = Math.round((civilMs(end) - civilMs(start)) / DAY_MS);
    return { dateDays: days > 0 ? days : 1, milliseconds: days * DAY_MS };
  }
  if (duration) return { dateDays: null, milliseconds: duration.milliseconds };
  return { dateDays: null, milliseconds: end.timestamp - start.timestamp };
}

function reportEvent(raw, occurrence, duration, index, recurring) {
  let end;
  if (occurrence.dateOnly) {
    const endParts = addCivilDays(occurrence, duration.dateDays || 1);
    end = { ...endParts, dateOnly: true, zone: occurrence.zone, timestamp: localPartsToTimestamp(endParts, occurrence.zone) };
  } else {
    end = { timestamp: occurrence.timestamp + duration.milliseconds, zone: occurrence.zone };
  }
  return {
    uid: raw.uid,
    ...(recurring ? { recurrenceId: raw.uid, occurrence: index + 1 } : {}),
    summary: raw.summary || 'No event description',
    title: raw.summary || 'No event description',
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.location ? { location: raw.location } : {}),
    fullDay: occurrence.dateOnly,
    start: { timestamp: occurrence.timestamp, dateTime: formatDateTime(occurrence.timestamp, occurrence.zone) },
    end: { timestamp: end.timestamp, dateTime: formatDateTime(end.timestamp, occurrence.zone) },
  };
}

function parseEvent(properties, index, options, window) {
  const startProperty = firstProperty(properties, 'DTSTART');
  if (!startProperty) parseError(`VEVENT ${index + 1} is missing DTSTART`);
  if (firstProperty(properties, 'RECURRENCE-ID')) {
    parseError('RECURRENCE-ID overrides are not expanded; remove the override or use a flattened feed');
  }
  const defaultZone = options.timeZone;
  const start = parseDateValue(startProperty.value, startProperty.params, defaultZone);
  const endProperty = firstProperty(properties, 'DTEND');
  const durationProperty = firstProperty(properties, 'DURATION');
  if (endProperty && durationProperty) parseError(`VEVENT ${index + 1} has both DTEND and DURATION`);
  let end;
  let duration;
  if (endProperty) {
    end = parseDateValue(endProperty.value, endProperty.params, start.zone);
    if (end.dateOnly !== start.dateOnly) parseError(`VEVENT ${index + 1} mixes DATE and DATE-TIME`);
    if (end.timestamp < start.timestamp) parseError(`VEVENT ${index + 1} ends before it starts`);
    duration = eventDuration(start, end, null);
  } else if (durationProperty) {
    duration = parseDuration(durationProperty.value);
    if (start.dateOnly) {
      if (duration.milliseconds <= 0 || duration.milliseconds % DAY_MS !== 0) {
        parseError('DATE DTSTART requires a whole-day positive DURATION');
      }
      duration = { dateDays: duration.milliseconds / DAY_MS, milliseconds: duration.milliseconds };
      end = { ...addCivilDays(start, duration.dateDays), dateOnly: true, zone: start.zone };
      end.timestamp = localPartsToTimestamp(end, end.zone);
    } else {
      duration = { dateDays: null, milliseconds: duration.milliseconds };
      end = { dateOnly: false, zone: start.zone, timestamp: start.timestamp + duration.milliseconds };
    }
  } else {
    if (start.dateOnly) {
      duration = { dateDays: 1, milliseconds: DAY_MS };
      end = { ...addCivilDays(start, 1), dateOnly: true, zone: start.zone };
      end.timestamp = localPartsToTimestamp(end, end.zone);
    } else {
      duration = { dateDays: null, milliseconds: 0 };
      end = { dateOnly: false, zone: start.zone, timestamp: start.timestamp };
    }
  }

  const uid = unescapeText(firstProperty(properties, 'UID')?.value || `event-${index + 1}`);
  const raw = {
    uid,
    summary: unescapeText(firstProperty(properties, 'SUMMARY')?.value || ''),
    description: unescapeText(firstProperty(properties, 'DESCRIPTION')?.value || ''),
    location: unescapeText(firstProperty(properties, 'LOCATION')?.value || ''),
  };
  const recurrenceProperty = firstProperty(properties, 'RRULE');
  const rule = recurrenceProperty ? parseRule(recurrenceProperty.value, start.zone) : null;
  const exdates = new Set(allProperties(properties, 'EXDATE').flatMap((property) => property.value.split(',')
    .map((value) => parseDateValue(value, property.params, start.zone).timestamp)));
  const rdates = allProperties(properties, 'RDATE').flatMap((property) => property.value.split(',')
    .map((value) => parseDateValue(value, property.params, start.zone)));
  const occurrences = rule
    ? expandRecurrence({ start, rule, exdates, rdates, window, maxOccurrences: options.maxOccurrences })
    : [start, ...rdates].filter((item, position, all) => all.findIndex((other) => other.timestamp === item.timestamp) === position);
  return occurrences
    .map((occurrence, occurrenceIndex) => reportEvent(raw, occurrence, duration, occurrenceIndex, Boolean(rule)))
    .filter((event) => eventOverlaps(event.start.timestamp, event.end.timestamp, window));
}

/**
 * Parse an iCalendar body and return report-compatible events.
 *
 * Supported recurrence components are DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL,
 * COUNT, UNTIL, BYDAY, BYMONTHDAY, BYMONTH and WKST, plus RDATE/EXDATE. Unsupported
 * RRULE components and RECURRENCE-ID overrides are rejected explicitly so a recurring
 * meeting is never silently lost. Callers should pass the account timezone for floating
 * times and a bounded window when expanding recurring feeds.
 */
export function parseICalendar(text, options = {}) {
  const timeZone = assertTimeZone(options.timeZone || 'UTC');
  const window = normalizeWindow(options);
  const parserOptions = {
    timeZone,
    maxOccurrences: Number.isInteger(options.maxOccurrences) && options.maxOccurrences > 0
      ? options.maxOccurrences : 1000,
  };
  const lines = unfoldIcalLines(text);
  let sawCalendar = false;
  let calendarClosed = false;
  let current = null;
  const components = [];
  const rawEvents = [];
  for (const line of lines) {
    const property = parseContentLine(line);
    if (property.name === 'BEGIN') {
      const component = property.value.toUpperCase();
      components.push(component);
      if (component === 'VCALENDAR') {
        if (sawCalendar) parseError('multiple VCALENDAR components');
        sawCalendar = true;
      } else if (component === 'VEVENT') {
        if (!sawCalendar || current) parseError('invalid VEVENT nesting');
        current = [];
      }
      continue;
    }
    if (property.name === 'END') {
      const component = property.value.toUpperCase();
      if (components.at(-1) !== component) parseError('mismatched calendar component');
      components.pop();
      if (component === 'VEVENT') {
        if (!current) parseError('END:VEVENT without BEGIN:VEVENT');
        rawEvents.push(current);
        current = null;
      } else if (component === 'VCALENDAR') {
        calendarClosed = true;
      }
      continue;
    }
    if (current && components.at(-1) === 'VEVENT') current.push(property);
  }
  if (!sawCalendar || !calendarClosed || components.length || current) parseError('incomplete VCALENDAR');
  return rawEvents.flatMap((properties, index) => parseEvent(properties, index, parserOptions, window));
}
