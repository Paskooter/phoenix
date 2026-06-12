// MIM unification — port of baseskill/graph/mims/utils/unify/Unify.ts. Merges a skill-provided
// MIM into a base MIM (default strategy: skill prompts replace base prompts; an optional
// transform function can do custom unification).

import { loadMims } from './utils.js';

/**
 * @param {{baseProvider:any, mimProvider?:any, transform?:Function}} options
 * @param {object} data current skill data
 * @returns {Promise<object>} unified MimConfig
 */
export async function unifyMims(options, data) {
  const log = data.log;
  if (!options.baseProvider) throw new Error('Missing base MIM for unification.');
  const mims = await loadAndPrep(options, data, log);

  let unifiedMim;
  if (options.transform && mims.skillMim) {
    try {
      unifiedMim = options.transform(data, mims.skillMim, mims.baseMim);
    } catch (error) {
      log?.warn?.('Provided MIM unification transform function threw an error; switching to default merge strategy.', { error: error.message });
    }
  }
  return unifiedMim || injectPromptsIntoBase(mims.skillMim, mims.baseMim, log);
}

function injectPromptsIntoBase(skillMim, baseMim, log) {
  if (!skillMim) {
    log?.warn?.(`No MIM was provided by the skill, this isn't recommended; defaulting to base MIM defaults.`);
  } else if (skillMim && !skillMim.prompts) {
    log?.warn?.('Skill provided MIM contains no prompts; defaulting to base MIM defaults.');
  } else {
    baseMim.prompts = skillMim.prompts;
  }
  return baseMim;
}

async function loadAndPrep(options, data, log) {
  const skillMims = options.mimProvider ? await loadMims(options.mimProvider, data) : [];
  const baseMims = await loadMims(options.baseProvider, data);

  if (skillMims.length > 1) log?.warn?.('More than 1 MIM was provided by the skill; defaulting to the 1st.');
  if (!baseMims.length) throw new Error('Missing base MIM provided.');

  return { skillMim: skillMims.length ? skillMims[0] : null, baseMim: baseMims[0] };
}
