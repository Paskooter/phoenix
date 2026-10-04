// Select a route before calling conversation processing: Assist executes actions.
// Custom sentences need explicit invocation or an exact owner-selected shortcut;
// arbitrary transcripts never probe HA.
const LIGHT_CONTROLS = new Set([
  'lightsOn', 'lightsGroupOn', 'lightsOff', 'lightsGroupOff', 'lightsUp', 'lightsGroupUp',
  'lightsDown', 'lightsGroupDown', 'lightsUpCompletely', 'lightsGroupUpCompletely',
  'lightsWarm', 'lightsGroupWarm', 'lightsCool', 'lightsGroupCool', 'lightsColor', 'lightsColorGroup',
]);
const TARGET = /\b(?:lights?|lamps?|switch(?:es)?)\b/i;
const COLORS = '(?:red|green|blue|yellow|orange|purple|pink|white|warm white|cool white|cyan|magenta)';
const STATE_TARGET = /\b(?:lights?|lamps?|switch(?:es)?|fans?|doors?|windows?|blinds?|locks?|garage)\b/i;
const NAME = "[\\p{L}\\p{N}][\\p{L}\\p{N}' -]{0,70}";
const STATES = '(?:on|off|open|closed|locked|unlocked)';
const STATE_QUESTION = new RegExp(`^(?:is|are) (?:the )?${NAME} (?:still )?${STATES}$`, 'iu');
const STATE_DESCRIPTION = new RegExp(`^(?:what is|what's) (?:the )?(?:state of (?:the )?${NAME}|${NAME} state)$`, 'iu');
const MEASUREMENT_QUESTION = new RegExp(`^(?:what is|what's) (?:the )?(?:(?:temperature|humidity) (?:in|of) (?:the )?${NAME}|${NAME} (?:temperature|humidity))$`, 'iu');
const ROOM_REFERENCE = /\b(?:here|this room)\b/i;
const COMPOUND = /\b(?:and then|and|then|after|before|in \d+|for \d+)\b/i;
const FOLLOW_UP_TURN = /^(?:please )?(?:turn|switch) (?:(?:it|them|those) (?:on|off)|(?:on|off) (?:it|them|those))$/i;
const FOLLOW_UP_SET = new RegExp(`^(?:please )?(?:set|change) (?:it|them|those)(?: brightness)? to (?:(?:100|[1-9]?\\d) ?(?:percent|%)|${COLORS})$`, 'i');
const FOLLOW_UP_RELATIVE = /^make (?:it|them|those) (?:dimmer|brighter)$/i;
const FOLLOW_UP_QUERY = new RegExp(`^(?:is it|are they|are those) (?:still )?${STATES}$`, 'i');
const FOLLOW_UP_ROOM = new RegExp(`^and in (?:the )?${NAME}$`, 'iu');
const FOLLOW_UP_ROOM_TARGET = new RegExp(`^what about (?:the )?${NAME} (?:lights?|temperature|humidity)$`, 'iu');
const RESERVED_INTENT = /^(?:volume|sleep$|stop$|cancel|repeat$|lights(?:Setup|DeleteData|HowTo)|askFor(?:Time|Date)$|requestWeather|weather|requestTellJiboContent$)/i;
const RESERVED_DOMAIN = new Set(['global_commands', 'clock', 'timer', 'alarm', 'weather']);
const RESERVED_TEXT = [
  /\b(?:volume|sleep|weather|forecast|jokes?|alarms?|timers?)\b/i,
  /^(?:stop|cancel|never ?mind|forget it|enough|quit|exit|repeat|say that again)(?: |$)/i,
  /^(?:go|turn) (?:back|home)(?: |$)/i,
  /^(?:what(?:'s| is)?|tell me|do you know) .*\b(?:time|date|day)\b/i,
  /^(?:turn|switch) (?:it )?(?:up|down)$/i,
  /^(?:louder|quieter|mute|unmute)(?: |$)/i,
  /^(?:help me )?(?:set ?up|connect|pair|configure|delete|remove|reset|forget|show).*\b(?:hue|lights?)\b/i,
  /\b(?:hue|lights?)\b.*\b(?:setup|set up|pairing|configuration)\b/i,
  new RegExp(`^(?:good ?night|goodbye|bye|yes|no|ok(?:ay)?|thanks?|thank you|black|${COLORS})$`, 'i'),
  /^(?:cancel|stop|never\s?mind|forget it|help|go to sleep|sleep|wake up|be quiet|quiet|shut up|mute|unmute|listen|look at me|come here)(?:\b|$)/i,
  /\b(?:your (?:voice|camera)|hue (?:setup|bridge|pairing)|pair (?:with )?hue)\b/i,
  /^(?:what(?:'s| is) (?:the )?(?:time|date)|tell (?:me )?(?:a )?joke|(?:take|snap) (?:a )?(?:photo|picture)|(?:show|tell) (?:me )?(?:the )?weather|how(?:'s| is) (?:the )?weather|(?:set|cancel|stop|delete) (?:a |an |the |my )?(?:alarm|timer)|(?:play|pause|resume|skip) (?:music|a song|the song)|(?:connect|disconnect|set up|reset|pair) (?:to )?(?:hue|wifi|wi-fi|bluetooth))\b/i,
];

export function normalizeHomePhrase(text) {
  return text.trim().replace(/\u2019/g, "'").replace(/[.!?]+$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// These checks happen before the read-only Account selection request as well
// as before execution. An exact shortcut cannot take over native commands.
export function homeCommandEligible(text, { hotphrase = false, activeSkill = null, nlu = null } = {}) {
  if (activeSkill && !hotphrase) return false;
  if (typeof text !== 'string' || !text.trim() || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) return false;
  const normalized = normalizeHomePhrase(text);
  // Preserve deliberate, explicit invocation, including before linking.
  if (/^(?:please )?(?:ask|tell) home assistant to .+$/i.test(normalized)) return true;
  if (RESERVED_INTENT.test(nlu?.intent || '') || RESERVED_DOMAIN.has(nlu?.entities?.domain)) return false;
  const ordinary = normalized.replace(/^(?:hey )?jibo[, ]+/, '').replace(/^please /, '');
  return !RESERVED_TEXT.some((pattern) => pattern.test(ordinary));
}

function enabled(selection) { return selection === true || selection?.enabled === true; }
function supports(selection, capability) {
  return enabled(selection) && Array.isArray(selection?.capabilities) && selection.capabilities.includes(capability);
}

function classifiedNativeRoute({ nlu = null, nativeDecision = undefined }) {
  // The classifier's registered skill decision is the boundary for routines,
  // rather than an ever-growing list of spoken aliases. Native domain/skill
  // metadata also protects ordinary commands when that skill is disabled.
  if (nlu?.entities?.domain || nlu?.entities?.skill) return true;
  if (nativeDecision !== undefined) return !!nativeDecision?.skillID;
  // Callers without the classifier decision must fail closed on an intent.
  return !!nlu?.intent;
}

function queryText(text) {
  if (COMPOUND.test(text) || /\b(?:turn|set|change|activate|run|start|outside|outdoors?)\b/i.test(text)) return false;
  return (STATE_TARGET.test(text) && (STATE_QUESTION.test(text) || STATE_DESCRIPTION.test(text)))
    || MEASUREMENT_QUESTION.test(text);
}

function followUpText(text) {
  if (FOLLOW_UP_TURN.test(text) || FOLLOW_UP_SET.test(text) || FOLLOW_UP_QUERY.test(text) || FOLLOW_UP_RELATIVE.test(text)) return true;
  if (FOLLOW_UP_ROOM.test(text)) return !COMPOUND.test(text.slice('and in '.length))
    && !/\b(?:turn|switch|set|change|activate|run|start)\b/i.test(text);
  return FOLLOW_UP_ROOM_TARGET.test(text) && !COMPOUND.test(text)
    && !/\b(?:turn|switch|set|change|activate|run|start)\b/i.test(text);
}

export function homeCommandCandidate(text, options = {}) {
  const { nlu = null, selection = null, now = Date.now() } = options;
  // Preserve a running skill's answers, including words such as "blue" or
  // sentences it deliberately asked for. A new hotphrase is a global turn.
  if (!homeCommandEligible(text, options)) return null;
  const normalized = text.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  const explicit = /^(?:please )?(?:ask|tell) home assistant to (.+)$/i.exec(normalized);
  const candidate = (value, kind = 'command', extra = {}) => ({ text: value, explicit: false, route: { kind }, ...extra });
  if (explicit) return candidate(explicit[1], supports(selection, 'state_queries') && queryText(normalizeHomePhrase(explicit[1]))
    ? 'query' : 'command', { explicit: true });
  const plain = normalizeHomePhrase(text);
  const relative = FOLLOW_UP_RELATIVE.test(plain);
  if (relative && classifiedNativeRoute(options)) return null;
  const followUp = selection?.follow_up;
  if (supports(selection, 'follow_up') && followUp?.available === true
    && Number.isSafeInteger(followUp.expires_at_ms) && followUp.expires_at_ms > now
    && followUp.expires_at_ms <= now + 30_000 && followUpText(plain)) return candidate(normalized, 'follow_up');
  if (relative) return null; // Cached-target wording must not fall through to a routine.
  if (supports(selection, 'state_queries') && queryText(plain)
    && (!ROOM_REFERENCE.test(plain) || supports(selection, 'room_context'))) return candidate(normalized, 'query');
  if (!classifiedNativeRoute(options) && supports(selection, 'routine_shortcuts') && Array.isArray(selection.shortcuts)) {
    const shortcut = selection.shortcuts.find((item) => typeof item?.phrase === 'string' && item.phrase.length <= 80
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.id)
      && normalizeHomePhrase(item.phrase) === plain);
    if (shortcut) return { text: normalized, explicit: false, route: { kind: 'routine', shortcut_id: shortcut.id } };
  }
  if (COMPOUND.test(normalized)) return null;
  // Room references are meaningful only to a connector that negotiated the
  // registered robot's device context; no client-supplied area is forwarded.
  if (ROOM_REFERENCE.test(normalized) && !supports(selection, 'room_context')) return null;
  if (/^(?:please )?(?:turn|switch) (?:the )?(?:lights?|lamps?|switch(?:es)?) (?:on|off) (?:in )?(?:here|this room)$/i.test(normalized)) {
    return candidate(normalized);
  }
  if (new RegExp(`^(?:please )?(?:set|change) (?:the )?(?:lights?|lamps?) (?:in )?(?:here|this room)(?: color)? to ${COLORS}$`, 'i').test(normalized)) {
    return candidate(normalized);
  }
  // Test the object, not the verb: "switch on dance mode" contains the word
  // switch but names no household light, lamp or switch.
  const prefixControl = /^(?:please )?(?:turn|switch) (?:on|off) (?:the )?(.+)$/i.exec(normalized);
  const suffixControl = /^(?:please )?(?:turn|switch) (?:the )?(.+) (?:on|off)$/i.exec(normalized);
  if (TARGET.test(prefixControl?.[1] || '') || TARGET.test(suffixControl?.[1] || '')) {
    return candidate(normalized);
  }
  if (/^(?:please )?(?:set|change) .+\bbrightness\b.+(?:percent|%)$/i.test(normalized)
    && /\b(?:lights?|lamps?)\b/i.test(normalized)) return candidate(normalized);
  if (new RegExp(`^(?:please )?(?:set|change) .+\\b(?:lights?|lamps?)\\b(?: color)? to ${COLORS}$`, 'i').test(normalized)) {
    return candidate(normalized);
  }
  if (/^(?:please )?(?:activate|run|start) (?:the )?.+ (?:scene|script)$/i.test(normalized)) {
    return candidate(normalized);
  }
  if (LIGHT_CONTROLS.has(nlu?.intent) && Array.isArray(nlu.rules) && nlu.rules.includes('launch')) {
    return candidate(normalized);
  }
  return null;
}
