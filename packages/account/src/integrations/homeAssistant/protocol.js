export const CAPABILITIES = Object.freeze([
  'robot_roster', 'robot_action', 'room_context', 'state_queries', 'follow_up', 'routine_shortcuts',
]);
export const ROUTE_CAPABILITIES = Object.freeze(['room_context', 'state_queries', 'follow_up', 'routine_shortcuts']);
export const FOLLOW_UP_LIFETIME_MS = 30_000;
export const MAX_ANNOUNCEMENT_TEXT = 300;
export const MAX_ACTION_TIMEOUT_MS = 45_000;
export const MAX_SHORTCUTS = 16;

export const isUuid = (value) => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export const normalizePhrase = (value) => value.trim().replace(/[’]/g, "'").replace(/[.!?]+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();

// Twenty linked robots must fit one 8192-byte snapshot, including JSON string
// escaping and Unicode. Trim by complete code points, not UTF-16 halves.
export function rosterName(value) {
  const points = Array.from(String(value || 'Jibo').replace(/[\ud800-\udfff]/gu, '\ufffd')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 100);
  while (points.length && Buffer.byteLength(JSON.stringify(points.join('')), 'utf8') > 200) points.pop();
  return points.join('').trim() || 'Jibo';
}

// A saved routine must not replace Jibo's ordinary commands or setup controls.
// The Gateway independently applies this boundary before selecting a routine.
export function reservedShortcut(phrase) {
  const value = normalizePhrase(phrase).replace(/^(?:hey )?jibo[, ]+/, '').replace(/^please /, '');
  return /\b(?:volume|sleep|weather|forecast|jokes?|alarms?|timers?)\b/.test(value)
    || /^(?:stop|cancel|never ?mind|forget it|enough|quit|exit|repeat|say that again)(?: |$)/.test(value)
    || /^(?:go|turn) (?:back|home)(?: |$)/.test(value)
    || /^(?:what(?:'s| is)?|tell me|do you know) .*\b(?:time|date|day)\b/.test(value)
    || /^(?:turn|switch) (?:it )?(?:up|down)$/.test(value)
    || /^(?:louder|quieter|mute|unmute)(?: |$)/.test(value)
    || /^(?:help me )?(?:set ?up|connect|pair|configure|delete|remove|reset|forget|show).*\b(?:hue|lights?)\b/.test(value)
    || /\b(?:hue|lights?)\b.*\b(?:setup|set up|pairing|configuration)\b/.test(value)
    || /^(?:good ?night|goodbye|bye|yes|no|okay|ok|thanks?|thank you|red|green|blue|yellow|orange|purple|pink|white|black|warm white|cool white|cyan|magenta)$/.test(value)
    || /^(?:please )?(?:cancel|stop|never\s?mind|forget it|help|go to sleep|sleep|wake up|be quiet|quiet|shut up|mute|unmute|listen|look at me|come here)(?:\b|$)/.test(value)
    || /\b(?:volume|your (?:voice|camera)|hue (?:setup|bridge|pairing)|pair (?:with )?hue)\b/.test(value)
    || /^(?:please )?(?:what(?:'s| is) (?:the )?(?:time|date)|tell (?:me )?(?:a )?joke|(?:take|snap) (?:a )?(?:photo|picture)|(?:show|tell) (?:me )?(?:the )?weather|how(?:'s| is) (?:the )?weather|(?:set|cancel|stop|delete) (?:a |an |the |my )?(?:alarm|timer)|(?:play|pause|resume|skip) (?:music|a song|the song)|(?:connect|disconnect|set up|reset|pair) (?:to )?(?:hue|wifi|wi-fi|bluetooth)|(?:ask|tell) home assistant\b)/.test(value);
}

export function negotiatedCapabilities(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length
    || value.some((item) => typeof item !== 'string' || item.length > 40)) throw new Error('capabilities');
  return CAPABILITIES.filter((capability) => value.includes(capability));
}

export function validatePreferences(frame, row, session, now) {
  if (!Array.isArray(frame.shortcuts) || !Array.isArray(frame.follow_up)
    || frame.shortcuts.length > MAX_SHORTCUTS || frame.follow_up.length > row.bindings.length) throw new Error('preferences');
  if (frame.shortcuts.length && !session.capabilities.includes('routine_shortcuts')) throw new Error('capabilities');
  if (frame.follow_up.length && !session.capabilities.includes('follow_up')) throw new Error('capabilities');
  const ids = new Set(); const phrases = new Set();
  const shortcuts = frame.shortcuts.map((shortcut) => {
    if (!shortcut || !isUuid(shortcut.id) || typeof shortcut.phrase !== 'string'
      || !shortcut.phrase.trim() || shortcut.phrase.length > 80
      || /[\u0000-\u001f\u007f<>]/.test(shortcut.phrase) || reservedShortcut(shortcut.phrase)) throw new Error('shortcut');
    const id = shortcut.id.toLowerCase(); const phrase = normalizePhrase(shortcut.phrase);
    if (!phrase || ids.has(id) || phrases.has(phrase)) throw new Error('shortcut');
    ids.add(id); phrases.add(phrase);
    return { id, phrase: shortcut.phrase.trim() };
  });
  const bindings = new Set();
  const followUp = new Map(frame.follow_up.map((hint) => {
    if (!hint || !isUuid(hint.robot_id) || !row.bindings.some((binding) => binding.id === hint.robot_id)
      || bindings.has(hint.robot_id) || typeof hint.available !== 'boolean'
      || !Number.isSafeInteger(hint.expires_at_ms) || hint.expires_at_ms < 0
      || hint.expires_at_ms > now + FOLLOW_UP_LIFETIME_MS) throw new Error('follow_up');
    bindings.add(hint.robot_id);
    return [hint.robot_id, hint.available && hint.expires_at_ms > now ? hint.expires_at_ms : 0];
  }));
  return { shortcuts, followUp };
}
