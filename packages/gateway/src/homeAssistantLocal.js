// This declaration is a routing preference, never pairing or wake authority.
// The enrolled native receiver makes the final decision before any LAN request.
export const LOCAL_HOME_SKILL_ID = '@be/home-assistant';
export const LOCAL_HOME_FIELD = 'phoenix_local_home';

const CAPABILITIES = new Set([
  'robot_roster', 'robot_action', 'room_context', 'state_queries', 'follow_up', 'routine_shortcuts',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) && Object.hasOwn(value, key);
const only = (value, keys) => object(value) && Object.keys(value).every((key) => keys.includes(key));

export function localHomeDeclared(data) {
  // Old/unsupported placements still opt out of cloud execution. Only the
  // actual native CONTEXT root carrier below can provide usable preferences.
  return own(data, LOCAL_HOME_FIELD) || own(data?.general, LOCAL_HOME_FIELD);
}

export function localHomeSelection(data, now = Date.now()) {
  if (!own(data, LOCAL_HOME_FIELD) || own(data.general, LOCAL_HOME_FIELD)) return null;
  const value = data[LOCAL_HOME_FIELD];
  if (!only(value, ['v', 'capabilities', 'shortcuts', 'follow_up']) || value.v !== 1
    || !Array.isArray(value.capabilities) || value.capabilities.length > CAPABILITIES.size
    || value.capabilities.some((capability) => !CAPABILITIES.has(capability))
    || new Set(value.capabilities).size !== value.capabilities.length
    || !Array.isArray(value.shortcuts) || value.shortcuts.length > 16) return null;
  const shortcuts = [];
  const ids = new Set();
  for (const item of value.shortcuts) {
    if (!only(item, ['id', 'phrase']) || typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id)
      || typeof item.phrase !== 'string' || !item.phrase.trim() || item.phrase.length > 80
      || /[\u0000-\u001f\u007f]/.test(item.phrase)) return null;
    ids.add(item.id);
    shortcuts.push(Object.freeze({ id: item.id, phrase: item.phrase }));
  }
  let followUp = { available: false, expires_at_ms: 0 };
  if (value.follow_up !== undefined) {
    const hint = value.follow_up;
    if (!only(hint, ['available', 'expires_at_ms']) || typeof hint.available !== 'boolean'
      || !Number.isSafeInteger(hint.expires_at_ms) || hint.expires_at_ms < 0
      || (hint.available && hint.expires_at_ms > now + 30_000)) return null;
    // Expired availability cannot revive or extend itself during this turn.
    if (hint.available && hint.expires_at_ms > now) {
      followUp = { available: true, expires_at_ms: hint.expires_at_ms };
    }
  }
  return Object.freeze({
    enabled: true,
    capabilities: Object.freeze([...value.capabilities]),
    shortcuts: Object.freeze(shortcuts),
    follow_up: Object.freeze(followUp),
  });
}

export function localHomeNlu(nlu, text, route) {
  // ListenResult preserves NLU entities in the shipped SDK; unknown top-level
  // response fields are discarded. Never copy declaration data into this hint.
  const hint = { v: 1, text, route: { kind: route.kind } };
  if (route.kind === 'routine') hint.route.shortcut_id = route.shortcut_id;
  return { ...nlu, entities: { ...nlu?.entities, [LOCAL_HOME_FIELD]: hint } };
}
