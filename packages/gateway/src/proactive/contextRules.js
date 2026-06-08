// Proactive context-rule evaluation — port of hub/proactive/tools/ContextTools.ts.
// checkContextRules(pr, context, requestData) -> bool; a PR with no contextRules is always
// eligible. Field extraction + match-rule semantics mirror the reference.

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const includesDeep = (arr, v) => Array.isArray(arr) && arr.some((e) => deepEqual(e, v));

export function checkContextRules(pr, context, requestData) {
  if (!pr.contextRules || !pr.contextRules.length) return true;
  return pr.contextRules.every((rule) => evaluateMatchRule(rule.matchRule, extractContextData(rule.field, context, requestData), rule.value));
}

export function evaluateMatchRule(matchRule, dataValue, ruleValue) {
  switch (matchRule) {
    case 'EXACT': return deepEqual(dataValue, ruleValue);
    case 'NOT': return !deepEqual(dataValue, ruleValue);
    case 'CONTAINS_ALL':
      return (Array.isArray(ruleValue) ? ruleValue : Object.keys(ruleValue)).every((el) => containsEl(dataValue, ruleValue, el));
    case 'CONTAINS_ANY':
      return (Array.isArray(ruleValue) ? ruleValue : Object.keys(ruleValue)).some((el) => containsEl(dataValue, ruleValue, el));
    case 'NOT_CONTAIN':
      return (Array.isArray(ruleValue) ? ruleValue : Object.keys(ruleValue)).every((el) => !containsEl(dataValue, ruleValue, el));
    case 'GREATER_THAN': return ruleValue < dataValue;
    case 'LESS_THAN': return ruleValue > dataValue;
    case 'CONTAINED_IN': return includesDeep(ruleValue, dataValue) || (typeof ruleValue === 'string' && ruleValue.includes(dataValue));
    default: throw new Error(`unrecognized matchRule: ${matchRule}`);
  }
}

function containsEl(dataValue, ruleValue, el) {
  if (Array.isArray(ruleValue)) return includesDeep(dataValue, el) || (typeof dataValue === 'string' && dataValue.includes(el));
  // object: compare property
  return dataValue && Object.prototype.hasOwnProperty.call(dataValue, el) && deepEqual(dataValue[el], ruleValue[el]);
}

export function getPersonIDs(runtime, requestData) {
  const present = (runtime.perception && runtime.perception.peoplePresent) || [];
  const speaker = runtime.perception && runtime.perception.speaker;
  const trigger = requestData.triggerData && requestData.triggerData.looperID;
  return new Set([...present.map((p) => p.id), speaker, trigger].filter((id) => id && id !== 'UNKNOWN' && id !== 'NOT_TRAINED'));
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
      return getPartOfDay(localHour((runtime.location || {}).iso));
    case 'DAY_OF_WEEK':
      return localDayOfWeek((runtime.location || {}).iso);
    case 'TRIGGER_SOURCE':
      return requestData.triggerSource;
    default:
      throw new Error(`Unknown field ${field}`);
  }
}

// --- local-time helpers (the iso carries the robot's tz offset) -------------

function localParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso || '');
  if (!m) { const d = new Date(); return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours() }; }
  return { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +m[4] };
}
function localHour(iso) { return localParts(iso).h; }
function localDayOfWeek(iso) { const p = localParts(iso); return new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay(); }

/** {basic, detail} part-of-day (reasonable buckets; report PR matches MORNING EARLY/MID/LATE). */
export function getPartOfDay(hour) {
  if (hour >= 5 && hour <= 11) return { basic: 'MORNING', detail: hour <= 7 ? 'EARLY' : hour <= 9 ? 'MID' : 'LATE' };
  if (hour >= 12 && hour <= 16) return { basic: 'AFTERNOON', detail: hour <= 13 ? 'EARLY' : hour <= 14 ? 'MID' : 'LATE' };
  if (hour >= 17 && hour <= 20) return { basic: 'EVENING', detail: hour <= 18 ? 'EARLY' : hour === 19 ? 'MID' : 'LATE' };
  return { basic: 'NIGHT', detail: hour >= 21 && hour <= 22 ? 'EARLY' : hour === 23 || hour === 0 ? 'MID' : 'LATE' };
}
