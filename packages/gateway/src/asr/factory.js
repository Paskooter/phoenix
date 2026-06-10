// ASR factory + utils — port of hub/src/asr/{ASRFactory,ASRUtils}.ts.
//
// Default provider is Parakeet (self-hosted NeMo over REST). The reference also
// had a Google STT provider (ETCO_server_asrProvider=google) — dead-era creds,
// not ported [DEAD-DEP]; selecting it throws so the misconfiguration is loud.
// Only en-US / en-CA are supported, anything else throws (reference behavior).
// setASRProvider(fn) lets tests inject a fake session provider, mirroring
// ASRFactory.setASRProvider.

import { ParakeetASRSession } from './parakeetSession.js';

const PARAKEET_URL = () => process.env.ETCO_server_parakeetUrl || process.env.PARAKEET_URL || 'http://192.168.1.252:6972';

/** @type {null | ((config:object, log:object) => object)} */
let injectedProvider = null;

export function setASRProvider(provider) { injectedProvider = provider || null; }

function defaultProvider(config, log) {
  if (process.env.ETCO_server_asrProvider === 'google') {
    throw new Error('Google STT provider is not available in phoenix (dead-era credentials); use parakeet');
  }
  return new ParakeetASRSession(PARAKEET_URL(), config, log);
}

/** @param {{lang:string, hints?:string[], earlyEOS?:string[]}} config */
export function startSession(config, log) {
  switch (config.lang) {
    case 'en-US':
    case 'en-CA':
      return (injectedProvider || defaultProvider)(config, log);
    default:
      throw new Error(`Unsupported ASR language code "${config.lang}"`);
  }
}

// --- ASRUtils (hint/earlyEOS cleaning) ---------------------------------------

/** ASR template strings that expand into word lists. */
export const ASR_TEMPLATES = { $YESNO: ['yes', 'yeap', 'yeah', 'no', 'nah', 'nope', 'sure'] };

/** Global ASR hints appended to every request (when addGlobal). */
export const GLOBAL_HINTS = ['jibo'];

/**
 * Expand known $TEMPLATEs, drop unknown ones, optionally append the global
 * hints, dedupe. (ASRUtils.cleanHintsEOS)
 */
export function cleanHintsEOS(toClean, addGlobal = false, logger) {
  const cleaned = (toClean || []).reduce((final, item) => {
    if (typeof item === 'string' && item.startsWith('$')) {
      const expansion = ASR_TEMPLATES[item];
      if (expansion) final.push(...expansion);
      else logger?.warn?.(`Detected unknown ASR Template '${item}' in ASR Hints/Early EOS; removing`);
    } else {
      final.push(item);
    }
    return final;
  }, []);
  if (addGlobal) cleaned.push(...GLOBAL_HINTS);
  return Array.from(new Set(cleaned));
}
