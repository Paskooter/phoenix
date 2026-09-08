// Mongo-style identifier comparison used at Loop query boundaries.
//
// Mongoose casts a valid 24-character hexadecimal query value to ObjectId,
// so the casing of that value does not affect equality. Phoenix keeps IDs as
// strings in its file store. Preserve exact comparison for every other value
// (including friendly IDs, emails, UUID-like IDs, 12-byte strings, and invalid
// ObjectId-looking input) rather than lowercasing identifiers indiscriminately.

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export function isValidObjectIdString(value) {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

function text(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toHexString === 'function') return value.toHexString();
  return String(value);
}

/** Match source ObjectId equality while retaining exact legacy string IDs. */
export function idsEqual(left, right) {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  if (left === right) return true;
  if (left && typeof left.equals === 'function') {
    try { return left.equals(right); } catch (_) { /* use string fallback */ }
  }
  if (right && typeof right.equals === 'function') {
    try { return right.equals(left); } catch (_) { /* use string fallback */ }
  }
  const leftText = text(left);
  const rightText = text(right);
  if (leftText === rightText) return true;
  return isValidObjectIdString(leftText)
    && isValidObjectIdString(rightText)
    && leftText.toLowerCase() === rightText.toLowerCase();
}

/**
 * Read a Phoenix Map by a source-compatible ID. The fallback is deliberately
 * restricted to valid 24-hex ObjectId strings; friendly IDs and other opaque
 * strings still require an exact key.
 */
export function mapGetById(map, id) {
  if (id === undefined || id === null) return undefined;
  const direct = map.get(id);
  if (direct !== undefined) return direct;
  const stringId = text(id);
  if (typeof id !== 'string') {
    const stringValue = map.get(stringId);
    if (stringValue !== undefined) return stringValue;
  }
  if (!isValidObjectIdString(stringId)) return undefined;
  const normalized = stringId.toLowerCase();
  for (const [key, value] of map) {
    const keyText = text(key);
    if (isValidObjectIdString(keyText) && keyText.toLowerCase() === normalized) return value;
  }
  return undefined;
}
