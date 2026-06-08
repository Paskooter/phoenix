// Zero-dependency validator for the JSON-Schema subset Phoenix contracts use.
//
// Supported keywords: type (string | string[]; "integer" understood), const, enum,
// required, properties, additionalProperties (boolean | schema), items, minimum,
// maximum, minItems. Nullability is expressed by including "null" in `type`.
//
// Intentionally small: contracts only need structural validation of messages that
// cross a process boundary. If a contract needs a keyword not listed above, add it
// here rather than reaching for a heavyweight dependency.

/** @typedef {{ valid: boolean, errors: string[] }} ValidationResult */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // 'object' | 'string' | 'number' | 'boolean' | 'undefined'
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function check(schema, v, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if ('const' in schema && !deepEqual(schema.const, v)) {
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((e) => deepEqual(e, v))) {
    errors.push(`${path}: ${JSON.stringify(v)} not in enum ${JSON.stringify(schema.enum)}`);
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(v);
    const ok =
      types.includes(t) ||
      (types.includes('integer') && t === 'number' && Number.isInteger(v));
    if (!ok) {
      errors.push(`${path}: expected ${types.join('|')}, got ${t}`);
      return; // further checks are meaningless on a type mismatch
    }
  }

  const t = typeOf(v);
  if (t === 'object') {
    const props = schema.properties || {};
    for (const r of schema.required || []) {
      if (!(r in v)) errors.push(`${path}.${r}: required property missing`);
    }
    for (const [k, val] of Object.entries(v)) {
      if (props[k]) {
        check(props[k], val, `${path}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${k}: additional property not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        check(schema.additionalProperties, val, `${path}.${k}`, errors);
      }
    }
  } else if (t === 'array') {
    if (schema.minItems !== undefined && v.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.items) v.forEach((it, i) => check(schema.items, it, `${path}[${i}]`, errors));
  } else if (t === 'number') {
    if (schema.minimum !== undefined && v < schema.minimum) errors.push(`${path}: < minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && v > schema.maximum) errors.push(`${path}: > maximum ${schema.maximum}`);
  }
}

/**
 * Validate a value against a contract schema.
 * @param {object} schema
 * @param {unknown} value
 * @returns {ValidationResult}
 */
export function validate(schema, value) {
  const errors = [];
  check(schema, value, '$', errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Validate and throw on failure (use at trust boundaries where bad input is a bug).
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [label]
 * @returns {unknown} the value, unchanged
 */
export function assertValid(schema, value, label = 'value') {
  const { valid, errors } = validate(schema, value);
  if (!valid) {
    const err = new Error(`Invalid ${label}:\n  ${errors.join('\n  ')}`);
    err.validationErrors = errors;
    throw err;
  }
  return value;
}
