// ASR factory + utils — port of hub/src/asr/{ASRFactory,ASRUtils}.ts.
//
// Default provider is Parakeet (self-hosted NeMo over REST). The original
// provider is Google Cloud STT streaming (ETCO_server_asrProvider=google); it is
// ported behind the same seam and drives whatever recognizer stream is configured
// (the original ETCO_server_gspeechMockAddress/Port mock seam, or an injected
// recognizer factory). Selecting it without a recognizer seam throws loudly —
// dead-era credentials must not silently degrade the client-visible contract.
// Only en-US / en-CA are supported, anything else throws (reference behavior).
// setASRProvider(fn) lets tests inject a fake session provider, mirroring
// ASRFactory.setASRProvider.

import { ParakeetASRSession } from './parakeetSession.js';
import { GoogleASRProvider } from './googleProvider.js';

const PARAKEET_URL = () => process.env.ETCO_server_parakeetUrl || process.env.PARAKEET_URL || 'http://192.168.1.252:6972';

/** @type {null | ((config:object, log:object) => object)} */
let injectedProvider = null;

export function setASRProvider(provider) { injectedProvider = provider || null; }

function defaultProvider(config, log) {
  if (process.env.ETCO_server_asrProvider === 'google') {
    return GoogleASRProvider.startSession(config, log);
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
