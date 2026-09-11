// IH query language — JS port of history/skilllaunch/db/SkillLaunchQueryBuilder.ts and the
// default match-method assignment in history/skilllaunch/validators/rule.ts.
//
// An IHQuery is compiled into a predicate over stored skill-launch records. The reference builds
// a Mongo $and of conditions; we evaluate the same conditions in memory. Field rules support
// EXACT/NOT/ONE_OF/CONTAINS/CONTAINS_ANY/CONTAINS_ALL/NOT_CONTAIN; PAYLOAD rules match the
// payload object (EXACT also requires the stored payloadSize to equal the rule's key count — the
// "EXACT via payload key-count" contract).
//
// Rule defaults: when a rule omits `match`, the reference validator assigns the FIRST allowed
// method for the field/value type pair (validators/rule.ts ALLOWED_METHODS). We apply the same
// default here so the GET/POST query variants accept the same shapes the reference accepts.
// The validation layer itself (identifier regexes, timestamps, allowed-method rejection, rule and
// conflict checks, failure payloads) lives in ./validators.js and runs in the HTTP handler
// BEFORE this builder, exactly as SkillLaunchRequestsHandler does it (I-02).

// RuleField / MatchMethod mirror the pinned interfaces
// (packages/interfaces/src/history/skilllaunch/query.ts:3-32).
export const RuleField = Object.freeze({
  SKILL_ID: 'skillID', INTENT: 'intent', PERSON_IDS: 'personIDs', PAYLOAD: 'payload',
});
export const MatchMethod = Object.freeze({
  EXACT: 'EXACT', NOT: 'NOT', ONE_OF: 'ONE_OF', CONTAINS: 'CONTAINS',
  CONTAINS_ANY: 'CONTAINS_ANY', CONTAINS_ALL: 'CONTAINS_ALL', NOT_CONTAIN: 'NOT_CONTAIN',
});

// First allowed method per `${fieldType}:${valueType}` (validators/rule.ts ALLOWED_METHODS).
const DEFAULT_MATCH = Object.freeze({
  'string:string': MatchMethod.EXACT,
  'string:array': MatchMethod.ONE_OF,
  'array:string': MatchMethod.CONTAINS,
  'array:array': MatchMethod.EXACT,
  'payload:object': MatchMethod.EXACT,
  'payload:string': MatchMethod.EXACT,
  'payload:array': MatchMethod.CONTAINS_ANY,
  'payload:boolean': MatchMethod.EXACT,
  'payload:number': MatchMethod.EXACT,
});

const STRING_FIELDS = new Set(['skillID', 'intent']);
const ARRAY_FIELDS = new Set(['personIDs']);

function fieldType(field) {
  if (STRING_FIELDS.has(field)) return 'string';
  if (ARRAY_FIELDS.has(field)) return 'array';
  if (field === RuleField.PAYLOAD) return 'payload';
  throw new Error(`Unknown field: ${field}`);
}

/**
 * Reference rule defaulting: match method defaults to the first allowed method for the
 * field/value combination. Throws the same errors the reference validator throws on
 * unsupported value types and unknown field/value pairs.
 */
export function resolveMatch(rule) {
  if (rule.match) return rule.match;
  const fType = fieldType(rule.field);
  const vType = Array.isArray(rule.value) ? 'array' : typeof rule.value;
  switch (vType) {
    case 'string':
    case 'array':
    case 'object':
    case 'number':
    case 'boolean':
      break;
    default:
      throw new Error(`Unsupported value type: ${vType}`);
  }
  const match = DEFAULT_MATCH[`${fType}:${vType}`];
  if (!match) throw new Error(`Cannot process this rule: ` + JSON.stringify(rule));
  return match;
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
const asArray = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/**
 * Mongo value equality. `$eq`/`$ne` against an ARRAY is element-wise and order-sensitive
 * (`{personIDs: {$eq: ['p1','p2']}}`), which is how the reference makes sorted personIDs
 * comparable — so `===` is wrong here and would never match an array rule.
 */
function eqValue(stored, wanted) {
  if (Array.isArray(stored) || Array.isArray(wanted)) {
    return Array.isArray(stored) && Array.isArray(wanted)
      && stored.length === wanted.length && stored.every((v, i) => v === wanted[i]);
  }
  return stored === wanted;
}
/** Mongo `$in`: a stored ARRAY matches when any element is in the list. */
function inList(stored, list) {
  return Array.isArray(stored)
    ? stored.some((s) => list.some((x) => eqValue(s, x)))
    : list.some((x) => eqValue(stored, x));
}
/** Mongo `$all`: the stored value must be an array containing every listed element. */
function allIn(stored, list) {
  return Array.isArray(stored) && list.every((x) => stored.some((s) => eqValue(s, x)));
}

/** Evaluate one field match method against a record value (mirrors SkillLaunchQueryBuilder). */
function matchField(recVal, method, value) {
  switch (method) {
    case MatchMethod.EXACT: return eqValue(recVal, value);
    case MatchMethod.NOT: return !eqValue(recVal, value);
    case MatchMethod.ONE_OF: return inList(recVal, asArray(value));
    case MatchMethod.CONTAINS: return inList(recVal, [value]);
    case MatchMethod.CONTAINS_ANY: return inList(recVal, asArray(value));
    case MatchMethod.CONTAINS_ALL: return allIn(recVal, asArray(value));
    case MatchMethod.NOT_CONTAIN: return !inList(recVal, asArray(value));
    default: throw new Error(`Unknown match method ${method}`);
  }
}

function payloadCondition(rule) {
  // Reference getPayloadCondition: `const payload = rule.value` and payloadFieldConditions()
  // immediately calls `Object.keys(payload)`. A null/undefined payload therefore throws
  // `Cannot convert undefined or null to object` (500) BEFORE any record is inspected — and a
  // primitive coerces the way Object.keys does (number/boolean -> [], string -> index keys).
  const payload = rule.value;
  const keys = Object.keys(payload);
  const keyEq = (rec, k) => eqValue(getPath(rec, `payload.${k}`), payload[k]);
  switch (rule.match) {
    case MatchMethod.EXACT:
      return (rec) => keys.every((k) => keyEq(rec, k)) && eqValue(rec.payloadSize, keys.length);
    case MatchMethod.NOT:
      return (rec) => keys.some((k) => !keyEq(rec, k)) || !eqValue(rec.payloadSize, keys.length);
    case MatchMethod.CONTAINS_ANY:
      return (rec) => keys.some((k) => keyEq(rec, k));
    case MatchMethod.CONTAINS_ALL:
      return (rec) => keys.every((k) => keyEq(rec, k));
    case MatchMethod.NOT_CONTAIN:
      return (rec) => keys.every((k) => !keyEq(rec, k));
    default:
      throw new Error(`Match method ${rule.match} for payload objects is not supported`);
  }
}

function ruleCondition(rule) {
  if (rule.field !== RuleField.PAYLOAD) {
    return (rec) => matchField(getPath(rec, rule.field), rule.match, rule.value);
  }
  if (rule.key) {
    return (rec) => matchField(getPath(rec, `payload.${rule.key}`), rule.match, rule.value);
  }
  return payloadCondition(rule);
}

/**
 * utils/Preformatter.preformatSkillLaunchQuery: sort an EXACT personIDs rule array IN PLACE so the
 * `$eq` comparison sees the same order the record was stored in (Preformatter sorts personIDs on
 * write). Called FIRST in the reference's buildQuery, before the robotID guard.
 */
function preformatQuery(query) {
  if (query.rules) {
    query.rules.forEach((rule) => {
      if (rule.field === 'personIDs' && rule.match === MatchMethod.EXACT && Array.isArray(rule.value)) {
        rule.value.sort();
      }
    });
  }
}

/**
 * Compile an IHQuery into a predicate (record) => boolean. Throws if robotID is missing.
 * @param {object} query
 * @returns {(record:object)=>boolean}
 */
export function buildPredicate(query) {
  preformatQuery(query);
  if (!query || !query.robotID) throw new Error('Robot ID is required');
  const conds = [(rec) => rec.robotID === query.robotID];
  for (const rule of query.rules || []) {
    rule.match = resolveMatch(rule); // reference defaulting / rejection
    conds.push(ruleCondition(rule));
  }
  if (query.notSessionID) conds.push((rec) => rec.sessionID !== query.notSessionID);
  if (query.intent) conds.push((rec) => rec.intent === query.intent);
  if (query.skillID) conds.push((rec) => rec.skillID === query.skillID);
  if (query.personID) conds.push((rec) => inList(rec.personIDs, [query.personID]));
  if (query.startTime) conds.push((rec) => rec.timestamp >= query.startTime);
  if (query.endTime) conds.push((rec) => rec.timestamp <= query.endTime);
  return (rec) => conds.every((c) => c(rec));
}