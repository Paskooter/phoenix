// PromptData — the sandbox variables MIM conditions + prompt templates evaluate against
// (port of baseskill graph/mims/.../PromptData). Built from the runtime context + skill-provided
// extras. Conditions/templates reference these by name, e.g. `speaker.firstName`, `dt.partOfDay`.

import { loadMimFile } from './loadMim.js';

export function buildPromptData(runtime = {}, skillData = {}) {
  const loop = runtime.loop || {};
  const perception = runtime.perception || {};
  const location = runtime.location || {};
  const speaker = (loop.users || []).find((u) => u.id === perception.speaker) || null;
  return {
    speaker,
    loop,
    location,
    perception,
    character: runtime.character || {},
    dialog: runtime.dialog || {},
    dt: buildDt(location.iso),
    ...skillData,
  };
}

function buildDt(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso || '');
  const hour = m ? +m[4] : new Date().getHours();
  const dow = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() : new Date().getDay();
  const partOfDay = hour < 5 ? 'NIGHT' : hour < 12 ? 'MORNING' : hour < 17 ? 'AFTERNOON' : hour < 21 ? 'EVENING' : 'NIGHT';
  return { hour, dayOfWeek: dow, partOfDay, iso };
}

export { loadMimFile };
