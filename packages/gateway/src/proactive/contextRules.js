// Proactive context-rule evaluation — exact port of hub/proactive/tools/ContextTools.ts.
//
// Pinned source: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/proactive/tools/ContextTools.ts:14-221  (rules, field extraction, PoD)
//   packages/hub/src/proactive/tools/ContextTools.ts:180-183 (PART_OF_DAY / DAY_OF_WEEK)
//   packages/hub/src/proactive/tools/ContextTools.ts:212-221 (getTimezonedDate = DateTime + tz offset)
//   packages/interfaces/src/proactive/context.ts:1-30       (field + matchRule enums)
//
// The arithmetic below is the source's, not a re-derivation:
//   * EXACT/NOT/EXCLUDED comparisons use lodash.isequal (deep, key-order-insensitive).
//   * CONTAINS_ALL / CONTAINS_ANY / NOT_CONTAIN throw unless BOTH the rule value and the
//     extracted value are objects or strings (numbers/booleans/undefined are rejected), then
//     iterate a string-or-array rule value element-wise with lodash `includes`
//     (`some(collection, el => isEqual(value, el))`) or an object rule value by key with
//     `hasEqualProperty` (`dataValue.hasOwnProperty(key) && isEqual(dataValue[key], ruleValue[key])`).
//   * GREATER_THAN is `ruleValue < dataValue`, LESS_THAN is `ruleValue > dataValue`.
//   * CONTAINED_IN throws unless the rule value is a string or array, then `includes(ruleValue, dataValue)`.
//   * PART_OF_DAY uses the jibo-cai-utils PartOfDayTimes table (13 boundaries) read with the
//     timezone-adjusted Date's LOCAL accessors; DAY_OF_WEEK is that Date's getDay().
//
// Note on `includes` over a *string* collection: lodash `some('abc', pred)` iterates the
// characters, so a string rule value is matched character-by-character, not as a substring.
// The previous implementation's `dataValue.includes(el)` substring test was not the reference.

const ISO_STRING_PARSER = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(([+-])(\d\d):(\d\d)|Z)$/;

/** lodash.isequal for JSON-shaped values: deep, unordered keys, NaN-equal, array by index. */
export function isEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const aArray = Array.isArray(a);
  const bArray = Array.isArray(b);
  if (aArray !== bArray) return false;
  if (aArray) return a.length === b.length && a.every((v, i) => isEqual(v, b[i]));
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && isEqual(a[k], b[k]));
}

function isObjectOrString(value) { return typeof value === 'object' || typeof value === 'string'; }
function isStringOrArray(value) { return typeof value === 'string' || Array.isArray(value); }

/** lodash iteration order: array elements, string characters, object own values. */
function iterations(collection) {
  if (Array.isArray(collection)) return collection;
  if (typeof collection === 'string') return [...collection];
  if (collection && typeof collection === 'object') return Object.values(collection);
  return [];
}
const everyOf = (collection, predicate) => iterations(collection).every(predicate);
const someOf = (collection, predicate) => iterations(collection).some(predicate);

/** lodash.includes equivalent over the iteration order above. */
function includes(collection, value) { return someOf(collection, (element) => isEqual(value, element)); }

function hasEqualProperty(dataValue, ruleValue, key) {
  return dataValue.hasOwnProperty(key) && isEqual(dataValue[key], ruleValue[key]);
}

export function checkContextRules(pr, context, requestData) {
  if (!pr.contextRules || !pr.contextRules.length) return true;
  return pr.contextRules.every((rule) => evaluateMatchRule(rule.matchRule, extractContextData(rule.field, context, requestData), rule.value));
}

/**
 * ContextTools.evaluateMatchRule(matchRule, dataValue, ruleValue). Note the settings path
 * (SettingsRulesChecker.ts:78) calls this with (matchRule, rule.value, dataValue) — the two
 * value positions swapped, as the source does.
 */
export function evaluateMatchRule(matchRule, dataValue, ruleValue) {
  switch (matchRule) {
    case 'EXACT':
      return isEqual(dataValue, ruleValue);
    case 'NOT':
      return !isEqual(dataValue, ruleValue);
    case 'CONTAINS_ALL':
      if (!isObjectOrString(ruleValue) || !isObjectOrString(dataValue)) {
        throw new Error(`Contain rule values must be collections (arrays, objects, strings): ${ruleValue})`);
      }
      if (isStringOrArray(ruleValue)) return everyOf(ruleValue, (element) => includes(dataValue, element));
      return everyOf(Object.keys(ruleValue), (key) => hasEqualProperty(dataValue, ruleValue, key));
    case 'CONTAINS_ANY':
      if (!isObjectOrString(ruleValue) || !isObjectOrString(dataValue)) {
        throw new Error(`Contain rule values must be collections (arrays, objects, strings): ${ruleValue})`);
      }
      if (isStringOrArray(ruleValue)) return someOf(ruleValue, (element) => includes(dataValue, element));
      return someOf(Object.keys(ruleValue), (key) => hasEqualProperty(dataValue, ruleValue, key));
    case 'NOT_CONTAIN':
      if (!isObjectOrString(ruleValue) || !isObjectOrString(dataValue)) {
        throw new Error(`Contain rule values must be collections (arrays, objects, strings): ${ruleValue})`);
      }
      if (isStringOrArray(ruleValue)) return everyOf(ruleValue, (element) => !includes(dataValue, element));
      return everyOf(Object.keys(ruleValue), (key) => !hasEqualProperty(dataValue, ruleValue, key));
    case 'GREATER_THAN':
      return ruleValue < dataValue;
    case 'LESS_THAN':
      return ruleValue > dataValue;
    case 'CONTAINED_IN':
      if (!isStringOrArray(ruleValue)) {
        throw new Error(`ContainedIn rule values must be either arrays or strings: ${ruleValue}`);
      }
      return includes(ruleValue, dataValue);
    default:
      throw new Error(`unrecognized matchRule: ${matchRule}`);
  }
}

export function getPersonIDs(runtime, requestData) {
  const present = (runtime.perception && runtime.perception.peoplePresent) || [];
  const speaker = runtime.perception && runtime.perception.speaker;
  const trigger = requestData.triggerData && requestData.triggerData.looperID;
  return new Set([...present.map((p) => p.id), speaker, trigger].filter((id) => id && id !== 'UNKNOWN' && id !== 'NOT_TRAINED'));
}

/**
 * TransactionHelper.getAccountId — the loop member's account ID for a person ID.
 *
 * The reference reads `runtime.loop.users` directly: a proactive CONTEXT whose loop has
 * no users list raises the same TypeError there, so no guard is added.
 */
export function getAccountId(runtime, personID) {
  if (!personID) return null;
  const looper = runtime.loop.users.find((user) => user.id === personID);
  return looper && looper.accountId;
}

export function extractContextData(field, context, requestData) {
  const runtime = context.data.runtime || {};
  const perception = runtime.perception || {};
  switch (field) {
    case 'FOCUSED_PERSON':
      return (requestData.triggerData && requestData.triggerData.looperID) || perception.speaker || 'UNKNOWN';
    case 'NUM_PEOPLE_PRESENT':
      return (perception.peoplePresent || []).length;
    case 'NUM_IDENTIFIED_PEOPLE_PRESENT':
      return getPersonIDs(runtime, requestData).size;
    case 'PERSON_IDS':
      return [...getPersonIDs(runtime, requestData)];
    case 'PART_OF_DAY':
      return getPartOfDay(getTimezonedDate((runtime.location || {}).iso));
    case 'DAY_OF_WEEK':
      return getTimezonedDate((runtime.location || {}).iso).getDay(); // 0-6, Sunday-Saturday
    case 'TRIGGER_SOURCE':
      return requestData.triggerSource;
    default:
      throw new Error(`Unknown field ${field}`);
  }
}

// --- part of day (jibo-cai-utils PartOfDayTimes / TimeUtils.getPartOfDay) ----

const PART_OF_DAY_TIMES = [
  { hour: 0, minute: 0, pod: { basic: 'NIGHT', detail: 'MID' } },
  { hour: 2, minute: 0, pod: { basic: 'NIGHT', detail: 'LATE' } },
  { hour: 4, minute: 45, pod: { basic: 'MORNING', detail: 'EARLY' } }, // EARLY_MORNING_HOURS:MINUTES
  { hour: 6, minute: 45, pod: { basic: 'MORNING', detail: 'MID' } },
  { hour: 10, minute: 0, pod: { basic: 'MORNING', detail: 'LATE' } },
  { hour: 12, minute: 0, pod: { basic: 'AFTERNOON', detail: 'EARLY' } },
  { hour: 14, minute: 0, pod: { basic: 'AFTERNOON', detail: 'MID' } },
  { hour: 16, minute: 0, pod: { basic: 'AFTERNOON', detail: 'LATE' } },
  { hour: 18, minute: 0, pod: { basic: 'EVENING', detail: 'EARLY' } },
  { hour: 20, minute: 0, pod: { basic: 'EVENING', detail: 'MID' } },
  { hour: 21, minute: 0, pod: { basic: 'EVENING', detail: 'LATE' } },
  { hour: 22, minute: 0, pod: { basic: 'NIGHT', detail: 'EARLY' } },
  { hour: 22, minute: 15, pod: { basic: 'NIGHT', detail: 'MID' } },
];

/**
 * TimeUtils.getPartOfDay(date): walk the boundaries backwards and stop at the last one whose
 * (hour, minute) is not after the input's. `date.getHours()/getMinutes()` are LOCAL accessors,
 * exactly as the source uses them.
 */
export function getPartOfDay(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  let pod = PART_OF_DAY_TIMES[0].pod;
  for (let i = PART_OF_DAY_TIMES.length - 1; i >= 0; i--) {
    pod = PART_OF_DAY_TIMES[i].pod;
    const boundary = PART_OF_DAY_TIMES[i];
    if (boundary.hour < hours || (boundary.hour === hours && boundary.minute <= minutes)) break;
  }
  return { ...pod };
}

/**
 * ContextTools.getTimezonedDate — `new Date(new DateTime(iso).utc + new DateTime(iso).timezone.offsetUTC)`.
 * DateTime parses an ISO-with-offset by taking the instant (`new Date(iso).getTime()`) and a
 * Timezone whose offsetUTC is the literal `±HH:MM` offset; `Z` (and, in the source, a Date
 * input) have offset zero. The sum re-expresses the instant as wall-clock-as-UTC, which the
 * local accessors above then read.
 */
export function getTimezonedDate(iso) {
  if (!iso) {
    // DateTime(iso) with a falsy input leaves `timezone` null, so ContextTools.ts:220
    // dereferences null. Reproduce the failure rather than inventing a default hour.
    throw new TypeError("Cannot read properties of null (reading 'offsetUTC')");
  }
  const match = ISO_STRING_PARSER.exec(iso);
  if (!match) throw new Error(`Invalid ISO date: ${iso}`);
  const instant = new Date(iso).getTime();
  const [, fullTZ, sign, hour, minute] = match;
  const offsetUTC = fullTZ === 'Z' ? 0 : (parseInt(hour, 10) * 60 + parseInt(minute, 10)) * 60 * 1000 * (sign === '-' ? -1 : 1);
  return new Date(instant + offsetUTC);
}
