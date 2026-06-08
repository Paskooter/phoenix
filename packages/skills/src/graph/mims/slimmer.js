// MIM→SLIM Slimmer — port of baseskill/graph/mims/utils/slimmer/Slimmer.ts (generatePlay/Listen)
// + common/Types.ts. Given a MimConfig + PromptData, pick a prompt (by category/sub-category/index
// → condition filter → weighted random) and emit a SLIM behavior {play, listen?}. Conditions and
// prompt templates are evaluated in a node:vm sandbox against PromptData (the reference uses `vm`).

import vm from 'node:vm';
import { newMsgId } from '@phoenix/contracts';

export const MimTypes = Object.freeze({ ANNOUNCEMENT: 'announcement', OPTIONAL_RESPONSE: 'optional-response', QUESTION: 'question' });
export const PromptCategory = Object.freeze({ ENTRY: 'Entry-Core', ERROR: 'Errors', RESPONSE: 'Response' });
export const PromptSubCategory = Object.freeze({ Q: 'Q', AN: 'AN', NM: 'NM', NI: 'NI', HOLD_RETURN: 'HoldReturn', VERBOSE: 'Verbose', TRUNCATED: 'Truncated', THANKS: 'Thanks' });

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
 * Generate a SLIM ({play, listen?}) from a MIM. Returns null if no eligible prompt (and updates
 * mimState.noMatchMax/noInputMax when the exhausted sub-category is NM/NI).
 * @param {object} mim MimConfig
 * @param {{category:string, subCategory:string, index?:number}} config
 * @param {object} promptData sandbox vars for conditions + templates
 * @param {{rng?:Function, mimState?:object, log?:object}} [opts]
 */
export function generateSlim(mim, config, promptData, opts = {}) {
  const { rng = Math.random, mimState, log } = opts;
  const index = config.index || 0;
  const ctx = vm.createContext({ ...promptData });

  let prompts = (mim.prompts || []).filter((p) => p.prompt_category === config.category && p.prompt_sub_category === config.subCategory);
  // index only matters for the Errors category (NoMatch/NoInput escalation)
  prompts = prompts.filter((p) => (p.prompt_category === PromptCategory.ERROR ? p.index === index : true));
  const valid = prompts.filter((p) => {
    if (!p.condition) return true;
    try { return !!vm.runInContext(p.condition, ctx); }
    catch (e) { log?.warn?.('prompt condition error', { prompt_id: p.prompt_id, error: e.message }); return false; }
  });

  if (!valid.length) {
    if (mimState) {
      if (config.subCategory === PromptSubCategory.NM) mimState.noMatchMax = true;
      else if (config.subCategory === PromptSubCategory.NI) mimState.noInputMax = true;
    }
    return null;
  }

  const choice = weightedSample(valid.map((p) => ({ data: p, weight: p.weight || 1 })), rng);
  let esml = choice.prompt;
  try { esml = vm.runInContext('`' + choice.prompt + '`', ctx); }
  catch (e) { log?.warn?.('prompt template error', { prompt_id: choice.prompt_id, error: e.message }); }

  const play = {
    id: newMsgId(),
    type: 'PLAY',
    autoRuleConfig: choice.auto_rule_override != null ? choice.auto_rule_override : (mim.es_auto_tagging || true),
    esml,
    meta: { prompt_id: choice.prompt_id, prompt_sub_category: choice.prompt_sub_category, mim_id: mim.mim_id, mim_type: mim.mim_type },
  };
  const slim = { play };
  if (mim.mim_type === MimTypes.QUESTION || mim.mim_type === MimTypes.OPTIONAL_RESPONSE) {
    slim.listen = { id: newMsgId(), type: 'LISTEN', rule: mim.rule_name };
  }
  return slim;
}
