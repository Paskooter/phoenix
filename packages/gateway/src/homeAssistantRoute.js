// Select a route before calling conversation processing: Assist executes actions.
// Custom sentences need explicit invocation, an exact owner-selected shortcut,
// or the parser's decision that the turn is a smart-home request
// (HOME_COMMAND_INTENT, packages/nlu/src/decisionLayer.js); arbitrary
// transcripts never probe HA.
const LIGHT_CONTROLS = new Set([
  'lightsOn', 'lightsGroupOn', 'lightsOff', 'lightsGroupOff', 'lightsUp', 'lightsGroupUp',
  'lightsDown', 'lightsGroupDown', 'lightsUpCompletely', 'lightsGroupUpCompletely',
  'lightsWarm', 'lightsGroupWarm', 'lightsCool', 'lightsGroupCool', 'lightsColor', 'lightsColorGroup',
]);
// Household devices people switch on and off by name. Speech recognition
// writes air conditioning as "AC", "A/C" or "A.C.".
const DEVICES = "lights?|lamps?|switch(?:es)?|fans?|ac|a/c|a\\.c\\.?|air ?conditioners?|air ?conditioning"
  + '|heaters?|heat|heating|thermostats?|tvs?|televisions?|plugs?|outlets?|sockets?'
  + '|(?:de)?humidifiers?|(?:air )?purifiers?|sprinklers?|vacuums?';
const TARGET = new RegExp(`(?:^|[\\s,])(?:${DEVICES})(?=$|[\\s,.!?])`, 'i');
const COLORS = '(?:red|green|blue|yellow|orange|purple|pink|white|warm white|cool white|cyan|magenta)';
const STATE_TARGET = new RegExp(`(?:^|[\\s,])(?:${DEVICES}|doors?|windows?|blinds?|locks?|garage)(?=$|[\\s,.!?])`, 'i');
// Jibo's own parts are never a household device ("turn off your light").
const OWN_PART = /^(?:your|yourself)\b/i;
// The decision layer's smart-home choice, and the grammar's thermostat rule,
// which otherwise answers that Jibo cannot manage one.
export const HOME_COMMAND_INTENT = 'phoenixHomeCommand';
const HOME_INTENTS = new Set([HOME_COMMAND_INTENT, 'requestManageThermostat']);
// A question about state ("is the dryer done"), not a polite request ("do you
// mind turning on the fan", "how about some light").
const QUESTION = /^(?:is|are|was|were|does|did|has|have|what|what's|whats|which|who|where|when|how(?:'s| is| are| many| much| warm| hot| cold| long| bright))\b/i;
// The on-robot Hue skill. Once Home Assistant is linked it owns the lights, and
// Hue never takes a turn (ListenTransaction._performRouting).
export const HUE_SKILL_ID = '@be/hue-control';
// A delay or a sequence: Home Assistant would run it at once. A classified home
// command may still name several devices ("the kitchen and living room
// lights"); nothing else may combine requests (COMPOUND).
const NUMBER = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|and)';
const NUMBER_WORD = `(?:\\d+(?:\\.\\d+)?|a|an|a few|a couple of|half an?|${NUMBER}(?:[- ]${NUMBER}){0,4})`;
const CLOCK_TIME = "at (?:(?:\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::\\d{2})? ?(?:am|pm|a\\.m\\.|p\\.m\\.|o'clock)|\\d{1,2}:\\d{2}|noon|midnight)";
const SEQUENCED = new RegExp(`\\b(?:and then|then|after|before|until|later|tomorrow|tonight|${CLOCK_TIME}|(?:in|for) ${NUMBER_WORD} ?(?:seconds?|secs?|minutes?|mins?|hours?|hrs?))\\b`, 'i');
const NAME = "[\\p{L}\\p{N}][\\p{L}\\p{N}' -]{0,70}";
const STATES = '(?:on|off|open|closed|locked|unlocked)';
const STATE_QUESTION = new RegExp(`^(?:is|are) (?:the )?${NAME} (?:still )?${STATES}$`, 'iu');
const STATE_DESCRIPTION = new RegExp(`^(?:what is|what's) (?:the )?(?:state of (?:the )?${NAME}|${NAME} state)$`, 'iu');
const MEASUREMENT_QUESTION = new RegExp(`^(?:what is|what's) (?:the )?(?:(?:temperature|humidity) (?:in|of) (?:the )?${NAME}|${NAME} (?:temperature|humidity))$`, 'iu');
const ROOM_REFERENCE = /\b(?:here|this room)\b/i;
const COMPOUND = new RegExp(`\\b(?:and|in \\d+|for \\d+)\\b|${SEQUENCED.source}`, 'i');
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
  /\b(?:your(?: own)?|jibo's) (?:lights?|lamps?|fans?|voice|camera)\b|\b(?:yourself|you off|you down)\b/i,
  /^(?:play|watch|stream|put on) .*\b(?:tv shows?|television shows?|movies?|films?|episodes?|videos?)\b/i,
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
  if (SEQUENCED.test(normalized)) return false;
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
  if (explicit) {
    const question = QUESTION.test(normalizeHomePhrase(explicit[1]));
    if (question && !supports(selection, 'state_queries')) return null;
    return candidate(explicit[1], question ? 'query' : 'command', { explicit: true });
  }
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
  // A command the classifier already placed in the home (a Hue light rule, the
  // grammar's thermostat rule or the decision layer's smart-home choice).
  const classified = (LIGHT_CONTROLS.has(nlu?.intent) || HOME_INTENTS.has(nlu?.intent))
    && Array.isArray(nlu.rules) && nlu.rules.includes('launch');
  if (classified && !SEQUENCED.test(normalized)
    && (!ROOM_REFERENCE.test(normalized) || supports(selection, 'room_context'))) {
    // Home Assistant's own agent resolves the device names, so it gets the
    // words as spoken. A question takes the read-only state-query route, which
    // needs a connector that answers them; a light rule is always a command.
    if (LIGHT_CONTROLS.has(nlu.intent) || !QUESTION.test(plain)) return candidate(normalized);
    return supports(selection, 'state_queries') ? candidate(normalized, 'query') : null;
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
  const controlled = prefixControl?.[1] || suffixControl?.[1] || '';
  if (TARGET.test(controlled) && !OWN_PART.test(controlled)) {
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
  return null;
}
