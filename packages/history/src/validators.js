// Skill-launch validation layer — faithful JS port of the pinned Pegasus validators
//   packages/history/src/skilllaunch/validators/rule.ts
//   packages/history/src/skilllaunch/validators/query.ts
//   packages/history/src/skilllaunch/validators/event.ts
//   packages/history/src/common/validation/index.ts
// @ reference 5c0a7390539663ba749d360de348a428c088505c
//
// The reference validates with joi@13.1.2 (`Joi.validate`, abortEarly: true). Phoenix keeps zero
// runtime dependencies beyond express/body-parser, so this module reproduces joi's *schemas* and
// its *message templates* directly. Every string below is the exact wire payload the pinned
// library produces; the reproduction is differentially verified against the real compiled
// validators in docs/parity/evidence/2026-09-10/i02-match-history-validation/.
//
// Message grammar (joi/lib/language.js + joi/lib/errors.js):
//   - a leaf error is `"<label>" <reason>`            (language.errors.key + leaf template)
//   - an object child error is `child "<key>" fails because [<reason>]`
//     (language.object.child is prefixed with `!!`, i.e. it suppresses the key template)
//   - an array item error is `"<label>" at position <i> fails because [<reason>]`
//   - the top-level object joins its own errors with '. ' and returns the first error only
//     (abortEarly) for schema children, but reports *every* unknown key
//   - `Joi.alternatives()` concatenates the leaf errors of every failing branch and joins them
//     with ', ' (language.alternatives.child === null -> wrapArrays slice)
//
// Ordering matters and is preserved exactly: query children are checked in schema order
// (robotID, skillID, intent, personID, notSessionID, rules, startTime, endTime), unknown keys
// last; rule validation and the conflict checks run only after joi passes and only when
// `rules.length > 0`.

/** Validation failure with a joi-shaped message (the wire contract is `error.message`). */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.isJoi = true;
  }
}

// common/validation/index.ts:5-11 — the identifier regexes, reproduced verbatim (their
// `String(regex)` form is part of the failure payload).
export const ROBOT_ID_REGEX = /^[a-zA-Z0-9-]*$/;
export const SESSION_ID_REGEX = /^[a-zA-Z0-9-]*$/;
export const SKILL_ID_REGEX = /^(@be\/)?[a-zA-Z0-9-_]*$/;
export const INTENT_REGEX = /^[a-zA-Z0-9-_]*$/;
export const PERSON_ID_REGEX = /^[a-zA-Z0-9-]*$/;

// Single definition, shared with the query builder (interfaces/.../query.ts RuleField).
import { RuleField } from './query.js';
export { RuleField };
/**
 * validators/rule.ts:15-35 — allowed match methods per `${fieldType}:${valueType}`; the FIRST
 * entry is the default when `match` is omitted (rule.ts:132).
 */
const ALLOWED_METHODS = Object.freeze({
  'string:string': ['EXACT', 'NOT'],
  'string:array': ['ONE_OF'],
  'array:string': ['CONTAINS'],
  'array:array': ['EXACT', 'NOT', 'CONTAINS_ANY', 'CONTAINS_ALL', 'NOT_CONTAIN'],
  'payload:object': ['EXACT', 'NOT', 'CONTAINS_ANY', 'CONTAINS_ALL', 'NOT_CONTAIN'],
  'payload:string': ['EXACT', 'NOT', 'CONTAINS', 'NOT_CONTAIN'],
  'payload:array': ['CONTAINS_ANY', 'CONTAINS_ALL', 'ONE_OF'],
  'payload:boolean': ['EXACT', 'NOT'],
  'payload:number': ['EXACT', 'NOT'],
});

/** rule.ts:41-53 */
function getFieldType(fieldName) {
  switch (fieldName) {
    case RuleField.SKILL_ID:
    case RuleField.INTENT: return 'string';
    case RuleField.PERSON_IDS: return 'array';
    case RuleField.PAYLOAD: return 'payload';
    default: throw new Error(`Unknown field: ${fieldName}`);
  }
}

/** rule.ts:58-64 — `typeof` after the Array.isArray check (so null -> 'object', undefined -> 'undefined'). */
function getValueType(ruleValue) {
  if (Array.isArray(ruleValue)) return 'array';
  return typeof ruleValue;
}

/** rule.ts:69-71 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * validators/rule.ts:101-135. Throws and (like the reference) MUTATES `rule.match` to the
 * default method when it is omitted.
 */
export function validateRule(rule) {
  const ruleField = rule.field;
  const ruleValue = rule.value;
  const fieldType = getFieldType(ruleField);
  const valueType = getValueType(ruleValue);

  switch (valueType) {
    case 'string':
      if (!isNonEmptyString(ruleValue)) throw new Error(`${ruleField} items must be non-empty strings`);
      break;
    case 'array':
      if (!ruleValue.length) throw new Error(`${ruleField} arrays must be non-empty`);
      for (const item of ruleValue) {
        if (!isNonEmptyString(item)) throw new Error(`${ruleField} items must be non-empty strings`);
      }
      break;
    case 'object':
    case 'number':
    case 'boolean':
      break;
    default:
      throw new Error(`Unsupported value type: ${valueType}`);
  }

  const allowedMethods = ALLOWED_METHODS[`${fieldType}:${valueType}`];
  if (!allowedMethods || !allowedMethods.length) {
    throw new Error(`Cannot process this rule: ` + JSON.stringify(rule));
  }
  if (rule.match) {
    if (allowedMethods.indexOf(rule.match) === -1) {
      throw new Error(`Match method ${rule.match} cannot be used for ${rule.field} and value ${rule.value}`);
    }
  } else {
    rule.match = allowedMethods[0];
  }
  return rule;
}

// --- joi emulation (only the schemas the reference declares) ------------------------------------

const ISO_NUMERIC = /^[+-]?\d+(\.\d+)?$/;
const BLANK = /^\s*$/;

/** joi/lib/types/date `internals.Date.toDate` with `timestamp('javascript')` (multiplier 1). */
function toDateMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string' && !(typeof value === 'number' && !isNaN(value) && isFinite(value))) return null;
  let v = value;
  if (typeof v === 'string' && ISO_NUMERIC.test(v)) v = parseFloat(v);
  if (BLANK.test(v)) return null; // internals.invalidDate
  const ms = new Date(v * 1).getTime();
  return isNaN(ms) ? null : ms;
}

/** joi string field with `any.empty` semantics (empty === ''), returning `"<label>" <reason>`. */
function checkString(label, value, regex, { required = false } = {}) {
  if (value === undefined) return required ? `"${label}" is required` : null;
  if (typeof value !== 'string') return `"${label}" must be a string`;
  if (value === '') return `"${label}" is not allowed to be empty`;
  if (!regex.test(value)) return `"${label}" with value "${value}" fails to match the required pattern: ${regex}`;
  return null;
}

/** joi array field (no item schema). */
function checkArrayOf(label, value, { required = false } = {}) {
  if (value === undefined) return required ? `"${label}" is required` : null;
  if (!Array.isArray(value)) return `"${label}" must be an array`;
  return null;
}

/** joi `array().items(Joi.string().regex(...))` — first failing item wins (abortEarly). */
function checkArrayItems(label, value, itemSchema) {
  for (let i = 0; i < value.length; ++i) {
    const reason = itemSchema(String(i), value[i]);
    if (reason) return `"${label}" at position ${i} fails because [${reason}]`;
  }
  return null;
}

/** joi `date().optional().timestamp().raw()[.max('now')]`. */
function checkDate(label, value, { maxNow = false } = {}) {
  if (value === undefined) return null;
  const ms = toDateMs(value);
  if (ms === null) return `"${label}" must be a valid timestamp or number of milliseconds`;
  const now = Date.now(); // joi resolves 'now' once per test
  if (maxNow && ms > now) return `"${label}" must be less than or equal to "${new Date(now).toString()}"`;
  return null;
}

/** Wrap a leaf reason the way `object.child` does: `child "<key>" fails because [<reason>]`. */
const asObjectChild = (key, reason) => `child "${key}" fails because [${reason}]`;
/** Wrap a leaf reason the way `object.allowUnknown` does: `"<key>" is not allowed`. */
const asAllowUnknown = (key) => `"${key}" is not allowed`;

/**
 * joi object validation with abortEarly:true — children in schema order (first failure returns
 * immediately), then *every* unknown key in object-key order.
 * @param {object} data
 * @param {Array<[string, (v:any)=>string|null, string]>} schema [key, check, wireKey]
 */
function validateObject(data, schema) {
  const errors = [];
  for (const [key, check] of schema) {
    const reason = check(data[key]);
    if (reason) {
      errors.push(asObjectChild(key, reason));
      return errors; // abortEarly
    }
  }
  const known = new Set(schema.map(([key]) => key));
  for (const key of Object.keys(data)) {
    if (!known.has(key)) errors.push(asAllowUnknown(key));
  }
  return errors;
}

/** event.ts:5-15 — BaseEventFields + intent/personIDs (SkillLaunchValidations). */
function skillLaunchEventErrors(data) {
  return validateObject(data, [
    ['timestamp', (v) => checkDate('timestamp', v, { maxNow: true })],
    ['sessionID', (v) => checkString('sessionID', v, SESSION_ID_REGEX, { required: true })],
    ['robotID', (v) => checkString('robotID', v, ROBOT_ID_REGEX, { required: true })],
    ['skillID', (v) => checkString('skillID', v, SKILL_ID_REGEX, { required: true })],
    ['intent', (v) => checkString('intent', v, INTENT_REGEX)],
    ['personIDs', (v) => {
      const base = checkArrayOf('personIDs', v);
      if (base) return base;
      if (v === undefined) return null;
      return checkArrayItems('personIDs', v, (label, item) => checkString(label, item, PERSON_ID_REGEX));
    }],
  ]);
}

/** event.ts:17-19 — BaseEventFields + payload (SkillPayloadValidations). */
function skillPayloadEventErrors(data) {
  return validateObject(data, [
    ['timestamp', (v) => checkDate('timestamp', v, { maxNow: true })],
    ['sessionID', (v) => checkString('sessionID', v, SESSION_ID_REGEX, { required: true })],
    ['robotID', (v) => checkString('robotID', v, ROBOT_ID_REGEX, { required: true })],
    ['skillID', (v) => checkString('skillID', v, SKILL_ID_REGEX, { required: true })],
    ['payload', (v) => (v === undefined ? '"payload" is required' : null)],
  ]);
}

/**
 * validators/event.ts:30-32 — `Joi.alternatives().try(SkillLaunchValidations, SkillPayloadValidations)`.
 * The alternatives error concatenates every branch's errors and joins them with ', '.
 */
export function validateEvent(data) {
  const launchErrors = skillLaunchEventErrors(data);
  if (!launchErrors.length) return;
  const payloadErrors = skillPayloadEventErrors(data);
  if (!payloadErrors.length) return;
  throw new ValidationError([...launchErrors, ...payloadErrors].join(', '));
}

/**
 * validators/query.ts:9-18 — QueryValidations, in schema key order.
 */
const QUERY_CHECKS = [
  ['robotID', (v) => checkString('robotID', v, ROBOT_ID_REGEX, { required: true })],
  ['skillID', (v) => checkString('skillID', v, SKILL_ID_REGEX)],
  ['intent', (v) => checkString('intent', v, INTENT_REGEX)],
  ['personID', (v) => checkString('personID', v, PERSON_ID_REGEX)],
  ['notSessionID', (v) => checkString('notSessionID', v, SESSION_ID_REGEX)],
  ['rules', (v) => checkArrayOf('rules', v)],
  ['startTime', (v) => checkDate('startTime', v, { maxNow: true })],
  ['endTime', (v) => checkDate('endTime', v)],
];

/** query.ts:20-22 */
function hasRuleFor(query, field) {
  return query.rules && !!query.rules.find((rule) => rule.field === field);
}

/** query.ts:24-34 — conflicting exact-match + rule for the same field. */
function checkNoConflictConditions(query) {
  if (query.intent && hasRuleFor(query, RuleField.INTENT)) {
    throw new Error('You specified intent both in exact match and rules');
  }
  if (query.personID && hasRuleFor(query, RuleField.PERSON_IDS)) {
    throw new Error('You specified personID(s) both in exact match and rules');
  }
  if (query.skillID && hasRuleFor(query, RuleField.SKILL_ID)) {
    throw new Error('You specified skillID both in exact match and rules');
  }
}

/**
 * validators/query.ts:40-47. joi first (abortEarly; its errors join with '. '), then — only when
 * `rules.length > 0` — every rule and finally the conflict checks.
 */
export function validateQuery(data) {
  const errors = validateObject(data, QUERY_CHECKS);
  if (errors.length) throw new ValidationError(errors.join('. '));
  if (data.rules && data.rules.length) {
    data.rules.forEach((queryRule) => validateRule(queryRule));
    checkNoConflictConditions(data);
  }
}
