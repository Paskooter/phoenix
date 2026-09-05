// Canonicalize object key order without deleting fields or changing values.
// Volatile handling belongs to parityCompare's bounded policies and invariants.
export function normalizeMessage(value) {
  if (Array.isArray(value)) return value.map(normalizeMessage);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeMessage(value[key])]));
  }
  return value;
}
export function normalizeStream(stream) { return stream.map(normalizeMessage); }
