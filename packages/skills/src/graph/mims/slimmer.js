// MIM→SLIM Slimmer — port of baseskill/graph/mims/utils/slimmer/Slimmer.ts (generateSlim,
// generateSlimSequence, generatePlay/Listen/Display) + common/Types.ts enums. Given a MimConfig +
// PromptData, pick a prompt (by category/sub-category/index → condition filter → weighted random)
// and emit SLIM protocol behaviors. Conditions and prompt templates are evaluated in a node:vm
// sandbox against PromptData (the reference uses `vm`).

import vm from 'node:vm';
import { newMsgId } from '@phoenix/contracts';
import { loadMims, isFunc } from './utils.js';
import { buildPromptData } from './promptData.js';

export const MimTypes = Object.freeze({ ANNOUNCEMENT: 'announcement', OPTIONAL_RESPONSE: 'optional-response', QUESTION: 'question' });
export const PromptCategory = Object.freeze({ ENTRY: 'Entry-Core', ERROR: 'Errors', RESPONSE: 'Response' });
export const PromptSubCategory = Object.freeze({
  QUESTION: 'Q', ANNOUNCEMENT: 'AN', NO_MATCH: 'NM', NO_INPUT: 'NI',
  HOLD_RETURN: 'HoldReturn', VERBOSE: 'Verbose', TRUNCATED: 'Truncated', THANKS: 'Thanks',
  // legacy aliases (pre-factory Phoenix call sites)
  Q: 'Q', AN: 'AN', NM: 'NM', NI: 'NI',
});

/** Fresh MIM dialog state (session.data._mim). */
export const newMimState = () => ({ noMatch: 0, noInput: 0, noMatchMax: false, noInputMax: false });

/** Weighted random selection. `rng` is injectable for deterministic tests. */
export function weightedSample(weighted, rng = Math.random) {
  const total = weighted.reduce((s, w) => s + (w.weight || 1), 0);
  let r = rng() * total;
  for (const w of weighted) { r -= (w.weight || 1); if (r <= 0) return w.data; }
  return weighted[weighted.length - 1].data;
}

/**
 * Core prompt selection + resolution (Slimmer.generatePlay): category/sub-category filter →
 * index filter (Errors only) → condition filter → weighted pick → template resolution.
 * Returns a Play behavior or undefined; on an empty NM/NI pick, flags mimState max-exhaustion.
 */
function generatePlay(mim, config, promptData, { rng = Math.random, mimState, log } = {}) {
  const prompts = mim.prompts || [];
  const autoRules = mim.es_auto_tagging;
  const ctx = vm.createContext({ ...promptData });

  const categorizedPrompts = prompts.filter((p) => p.prompt_category === config.category && p.prompt_sub_category === config.subCategory);
  if (categorizedPrompts.length) {
    // index only matters for the Errors category (NoMatch/NoInput escalation)
    const indexedPrompts = categorizedPrompts.filter((p) => (p.prompt_category === PromptCategory.ERROR ? p.index === (config.index || 0) : true));
    if (indexedPrompts.length) {
      const validPrompts = indexedPrompts.filter((p) => {
        try { return !p.condition || !!vm.runInContext(p.condition, ctx); }
        catch (e) { log?.warn?.('prompt condition error', { prompt_id: p.prompt_id, error: e.message }); return false; }
      });
      if (validPrompts.length) {
        const choice = weightedSample(validPrompts.map((p) => ({ data: p, weight: p.weight || 1 })), rng);
        let resolvedPrompt = '';
        try { resolvedPrompt = vm.runInContext('`' + choice.prompt + '`', ctx); }
        catch (e) { log?.warn?.('prompt template error', { prompt_id: choice.prompt_id, error: e.message }); }
        const autoRuleConfig = (choice.auto_rule_override != null) ? choice.auto_rule_override : autoRules;
        return {
          id: newMsgId(),
          type: 'PLAY',
          autoRuleConfig,
          esml: resolvedPrompt,
          meta: { prompt_id: choice.prompt_id, prompt_sub_category: choice.prompt_sub_category, mim_id: mim.mim_id, mim_type: mim.mim_type },
        };
      }
    }
  }
  // No prompt of the requested index — probably a maxed-out NoInput/NoMatch situation.
  if (mimState) {
    if (config.subCategory === PromptSubCategory.NO_MATCH) mimState.noMatchMax = true;
    else if (config.subCategory === PromptSubCategory.NO_INPUT) mimState.noInputMax = true;
    else log?.warn?.(`No prompts of requested index in requested category '${config.category}' and sub-category '${config.subCategory}'.`);
  }
  return undefined;
}

/** Generate a Listen behavior from a MIM (question/optional-response only). */
function generateListen(mim) {
  if (mim.mim_type === MimTypes.QUESTION || mim.mim_type === MimTypes.OPTIONAL_RESPONSE) {
    return { id: newMsgId(), type: 'LISTEN', rule: mim.rule_name };
  }
  return undefined;
}

/**
 * Generate a Display behavior from a MIM when its GUI escalation thresholds are met
 * (Slimmer.generateDisplay).
 */
export function generateDisplay(mim, config, viewData, log) {
  if (mim.gui && (mim.no_matches_for_gui !== undefined || mim.no_inputs_for_gui !== undefined)) {
    if ((config.noMatch >= mim.no_matches_for_gui) || (config.noInput >= mim.no_inputs_for_gui)) {
      const view = resolveView(mim.gui, viewData, log);
      const skillDisplay = { type: 'SKILL', name: 'MIM_VIEW', context: view };
      const cancelAction = { type: 'HIDE_DISPLAY', name: 'HIDE_MIM_VIEW' }; // temporary onCancel to satisfy RCP
      return {
        id: newMsgId(), type: 'DISPLAY', name: 'PEGASUS_VIEW',
        view: skillDisplay, layer: 0, overlay: undefined, visible: true, keepDisplay: false, onCancel: [cancelAction],
      };
    }
  }
  return undefined;
}

/** Resolve mim.gui.data against skill-provided viewData (Slimmer.resolveView). */
function resolveView(mimGui, viewData, log) {
  if (!mimGui) return null;
  if (mimGui.type === 'File') { log?.warn?.('View cannot be of type "File"'); return null; }
  if (!viewData) return mimGui;
  if (typeof mimGui.data === 'string' && !mimGui.data.match(/^\s*{/)) {
    try {
      const viewDataObject = vm.createContext(viewData);
      viewData = vm.runInContext('(function() { return ' + mimGui.data + '})()', viewDataObject);
    } catch (e) { log?.warn?.('Error resolving view:', e.message); }
  } else {
    log?.warn?.('Overwriting mim.gui.data with provided viewData');
  }
  if (!viewIsValid(mimGui, viewData)) { log?.warn?.('Provided view data is not valid, not overwriting mim.gui'); return mimGui; }
  return Object.assign({}, mimGui, { data: viewData });
}

function viewIsValid(mimGui, viewData) {
  return (mimGui.type === 'Javascript' && !!viewData.viewConfig)
    || (mimGui.type === 'Menu' && !!viewData.buttons);
}

/** Resolve providers → loaded mims + merged PromptData + viewData (Slimmer.loadAndPrep). */
async function loadAndPrep(providers, data, log) {
  const mims = await loadMims(providers.mimDataProvider, data);
  const viewData = isFunc(providers.viewDataProvider) ? providers.viewDataProvider(data) : providers.viewDataProvider;
  const skillPromptData = isFunc(providers.promptDataProvider) ? providers.promptDataProvider(data) : providers.promptDataProvider;
  // Reference PromptData exposes skill data as the `skill` property (prompts say
  // `${skill.weather.summary}`); Phoenix additionally spreads it at the root (chitchat precedent).
  const sd = skillPromptData || {};
  const promptData = buildPromptData(data.runtime, { ...sd, skill: sd });
  return { mims, promptData, viewData };
}

/**
 * Generate a SLIM behavior — the reference Slimmer entry point.
 * @param {{category:string, subCategory:string, noMatch:number, noInput:number, index?:number}} config
 * @param {{mimDataProvider?:any, promptDataProvider?:any, viewDataProvider?:any}} providers
 * @param {object} data current skill data
 * @param {{rng?:Function}} [opts] injectable RNG for deterministic tests
 * @returns {Promise<object|null>} SLIM protocol behavior or null when no eligible prompt
 */
export async function generateSlim(config, providers, data, opts = {}) {
  const log = data.log;
  const { mims, promptData, viewData } = await loadAndPrep(providers, data, log);
  if (!mims.length) return null;
  if (mims.length > 1) throw new Error('Multiple MIM paths provided to Slim; see SlimSequence.');
  const mim = mims[0];
  const mimState = data.skill.session.data._mim;
  const slimConfig = {
    play: generatePlay(mim, config, promptData, { rng: opts.rng, mimState, log }),
    listen: generateListen(mim),
    display: generateDisplay(mim, config, viewData, log),
  };
  return slimConfig.play ? { id: newMsgId(), type: 'SLIM', config: slimConfig } : null;
}

/**
 * Generate a SEQUENCE of SLIMs from multiple announcement MIMs (mega-MAN assembly).
 */
export async function generateSlimSequence(config, providers, data, opts = {}) {
  const log = data.log;
  const { mims, promptData, viewData } = await loadAndPrep(providers, data, log);
  if (!mims.length) return null;
  if (mims.some((mim) => mim.mim_type !== MimTypes.ANNOUNCEMENT)) {
    throw new Error('SlimSequences can only contain Announcements');
  }
  const mimState = data.skill.session.data._mim;
  const slims = mims
    .map((mim) => ({
      id: newMsgId(), type: 'SLIM',
      config: {
        play: generatePlay(mim, config, promptData, { rng: opts.rng, mimState, log }),
        display: generateDisplay(mim, config, viewData, log),
      },
    }))
    .filter((slim) => slim.config.play); // SLIMs that yielded no prompt are dropped (per reference)
  if (!slims.length) return null;
  return { id: newMsgId(), type: 'SEQUENCE', children: slims };
}

/**
 * LEGACY low-level Slimmer (pre-factory Phoenix call sites: chitchat, color-skill): pick a prompt
 * from an in-memory MimConfig and return a FLAT {play, listen?} (callers wrap via buildJcpFromSlim).
 */
export function generateSlimFromMim(mim, config, promptData, opts = {}) {
  const { rng = Math.random, mimState, log } = opts;
  const play = generatePlay(mim, { ...config, index: config.index || 0 }, promptData, { rng, mimState, log });
  if (!play) return null;
  const slim = { play };
  const listen = generateListen(mim);
  if (listen) slim.listen = listen;
  return slim;
}
