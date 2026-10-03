// Select a route before calling conversation processing: Assist executes actions.
// Custom sentences need explicit invocation; arbitrary transcripts never probe HA.
const LIGHT_CONTROLS = new Set([
  'lightsOn', 'lightsGroupOn', 'lightsOff', 'lightsGroupOff', 'lightsUp', 'lightsGroupUp',
  'lightsDown', 'lightsGroupDown', 'lightsUpCompletely', 'lightsGroupUpCompletely',
  'lightsWarm', 'lightsGroupWarm', 'lightsCool', 'lightsGroupCool', 'lightsColor', 'lightsColorGroup',
]);
const TARGET = /\b(?:lights?|lamps?|switch(?:es)?)\b/i;
const COLORS = '(?:red|green|blue|yellow|orange|purple|pink|white|warm white|cool white|cyan|magenta)';

export function homeCommandCandidate(text, { hotphrase = false, activeSkill = null, nlu = null } = {}) {
  // Preserve a running skill's answers, including words such as "blue" or
  // sentences it deliberately asked for. A new hotphrase is a global turn.
  if (activeSkill && !hotphrase) return null;
  if (typeof text !== 'string' || text.length > 500) return null;
  const normalized = text.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  const explicit = /^(?:please )?(?:ask|tell) home assistant to (.+)$/i.exec(normalized);
  if (explicit) return { text: explicit[1], explicit: true };
  if (/\b(?:and then|and|then|after|before|in \d+|for \d+)\b/i.test(normalized)) return null;
  if (/^(?:please )?(?:turn|switch) (?:on|off) (?:the )?.+$/i.test(normalized) && TARGET.test(normalized)) {
    return { text: normalized, explicit: false };
  }
  if (/^(?:please )?(?:turn|switch) (?:the )?.+ (?:on|off)$/i.test(normalized) && TARGET.test(normalized)) {
    return { text: normalized, explicit: false };
  }
  if (/^(?:please )?(?:set|change) .+\bbrightness\b.+(?:percent|%)$/i.test(normalized)
    && /\b(?:lights?|lamps?)\b/i.test(normalized)) return { text: normalized, explicit: false };
  if (new RegExp(`^(?:please )?(?:set|change) .+\\b(?:lights?|lamps?)\\b(?: color)? to ${COLORS}$`, 'i').test(normalized)) {
    return { text: normalized, explicit: false };
  }
  if (/^(?:please )?(?:activate|run|start) (?:the )?.+ (?:scene|script)$/i.test(normalized)) {
    return { text: normalized, explicit: false };
  }
  if (LIGHT_CONTROLS.has(nlu?.intent) && Array.isArray(nlu.rules) && nlu.rules.includes('launch')) {
    return { text: normalized, explicit: false };
  }
  return null;
}
