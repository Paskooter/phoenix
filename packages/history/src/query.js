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
// (Full allowed-method rejection, identifier regexes, timestamps and conflict checks are the
// validation layer, tracked separately in I-02.)

export const RuleField = Object.freeze({ PAYLOAD: 'payload' });
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

/** Evaluate one field match method against a record value. */
function matchField(recVal, method, value) {
  switch (method) {
    case MatchMethod.EXACT: return recVal === value;
    case MatchMethod.NOT: return recVal !== value;
    case MatchMethod.ONE_OF: return asArray(value).includes(recVal);
    case MatchMethod.CONTAINS: return Array.isArray(recVal) ? recVal.includes(value) : recVal === value;
    case MatchMethod.CONTAINS_ANY: return asArray(value).some((v) => asArray(recVal).includes(v));
    case MatchMethod.CONTAINS_ALL: return asArray(value).every((v) => asArray(recVal).includes(v));
    case MatchMethod.NOT_CONTAIN: return !asArray(value).some((v) => asArray(recVal).includes(v));
    default: throw new Error(`Unknown match method ${method}`);
  }
}

function payloadCondition(rule) {
  const payload = rule.value || {};
  const keys = Object.keys(payload);
  switch (rule.match) {
    case MatchMethod.EXACT:
      return (rec) => keys.every((k) => getPath(rec, `payload.${k}`) === payload[k]) && rec.payloadSize === keys.length;
    case MatchMethod.NOT:
      return (rec) => keys.some((k) => getPath(rec, `payload.${k}`) !== payload[k]) || rec.payloadSize !== keys.length;
    case MatchMethod.CONTAINS_ANY:
      return (rec) => keys.some((k) => getPath(rec, `payload.${k}`) === payload[k]);
    case MatchMethod.CONTAINS_ALL:
      return (rec) => keys.every((k) => getPath(rec, `payload.${k}`) === payload[k]);
    case MatchMethod.NOT_CONTAIN:
      return (rec) => keys.every((k) => getPath(rec, `payload.${k}`) !== payload[k]);
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
 * Compile an IHQuery into a predicate (record) => boolean. Throws if robotID is missing.
 * @param {object} query
 * @returns {(record:object)=>boolean}
 */
export function buildPredicate(query) {
  if (!query || !query.robotID) throw new Error('Robot ID is required');
  const conds = [(rec) => rec.robotID === query.robotID];
  for (const rule of query.rules || []) {
    rule.match = resolveMatch(rule); // reference defaulting / rejection
    conds.push(ruleCondition(rule));
  }
  if (query.notSessionID) conds.push((rec) => rec.sessionID !== query.notSessionID);
  if (query.intent) conds.push((rec) => rec.intent === query.intent);
  if (query.skillID) conds.push((rec) => rec.skillID === query.skillID);
  if (query.personID) conds.push((rec) => asArray(rec.personIDs).includes(query.personID));
  if (query.startTime) conds.push((rec) => rec.timestamp >= query.startTime);
  if (query.endTime) conds.push((rec) => rec.timestamp <= query.endTime);
  return (rec) => conds.every((c) => c(rec));
}