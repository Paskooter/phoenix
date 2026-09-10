// Proactive settings-rule evaluation — port of hub/proactive/tools/SettingsRulesChecker.ts.
//
// getDomainList collects every `rule.skill` named by any proactive registration, so the
// caller issues ONE Settings.GetSettings request for all implicated domains. A PR with no
// settingsRules is always eligible; a rule that cannot be evaluated (no map at all, no
// entry for the rule's skill, no entry for the rule's key) fails the PR. That fail-closed
// shape is what makes a missing settings service, an unknown person and a disabled
// preference all resolve the same way as the reference.
//
// Fidelity note: the source passes `(rule.matchRule, rule.value, dataValue)` to
// ContextTools.evaluateMatchRule — the value/data positions swapped relative to
// checkContextRules. Settings matchRules are limited to EXACT/NOT by config validation
// (skillConfigValidation.js settingsMatches), and both compare symmetrically with deep
// equality, so the swap is unobservable; it is reproduced here to keep the call site a
// literal port.
//
// Pinned source: pegasus@5c0a7390539663ba749d360de348a428c088505c
//   packages/hub/src/proactive/tools/SettingsRulesChecker.ts:22-87.

import { evaluateMatchRule } from './contextRules.js';

/** All skill domains named by settingsRules across the proactive skill configs. */
export function getDomainList(proactiveSkillConfigs) {
  const domains = new Set();
  for (const psc of proactiveSkillConfigs) {
    for (const pr of (psc.proactives || [])) {
      if (pr.settingsRules && pr.settingsRules.length) {
        for (const rule of pr.settingsRules) domains.add(rule.skill);
      }
    }
  }
  return [...domains];
}

/** Filter proactive registrations for Settings eligibility. */
export function checkSettingsRegistrations(proactiveRegistrations, skillSettingsMap) {
  return proactiveRegistrations.filter((pr) => checkSettingsRules(pr, skillSettingsMap));
}

/** Evaluate one registration's settingsRules against the retrieved settings map. */
export function checkSettingsRules(pr, skillSettingsMap) {
  if (!pr.settingsRules || !pr.settingsRules.length) {
    return true; // if no settings rules, eligible
  }
  // if we have no skill settings (person may be unknown) then we can't evaluate settings
  // rules and are therefore not eligible
  if (!skillSettingsMap) return false;
  return pr.settingsRules.every((rule) => {
    const skillSetting = skillSettingsMap.get(rule.skill);
    if (!skillSetting) return false;
    if (!Object.prototype.hasOwnProperty.call(skillSetting, rule.key)) return false;
    // (matchRule, rule.value, dataValue): the source's swapped argument order.
    return evaluateMatchRule(rule.matchRule, rule.value, skillSetting[rule.key]);
  });
}

/**
 * Retrieve settings for every skill implicated in the proactive registrations, in one
 * request (source getSkillSettingsMap). No domains short-circuits without a request.
 */
export async function getSkillSettingsMap(proactiveSkillConfigs, accountId, loopId, transId, settingsClient, log) {
  const domains = getDomainList(proactiveSkillConfigs);
  if (domains.length === 0) return new Map();
  return settingsClient.getSettings(accountId, loopId, transId, domains, log);
}
