// An ordered list of fallback recognizers behind Parakeet in `auto` mode.
//
// PHOENIX_ASR_FALLBACK_ORDER (default "parakeet,openrouter,google") names who
// takes a window when Parakeet cannot. The chain is the failover transport's
// single "secondary" (failoverTransport.js), so Parakeet's health tracking,
// replay and timing stay exactly as they were:
//
//   * A new turn or a mid-stream switch goes to the first member that is
//     available now (configured, not paused, within budget). Google streams;
//     a batch-only member (OpenRouter, custom) gets a BatchRecognizerSocket,
//     which recognizes the window at end of speech.
//   * A finished window (batch) is tried on each available member in order:
//     when OpenRouter fails, the same WAV goes to Google. Each member's own
//     failure handling (pause, log, ledger) still applies.
//   * An empty transcript is a result, not a failure: it is never retried
//     elsewhere (that would bill silence twice).

import { asrFailureFields } from '@phoenix/common';
import { BatchRecognizerSocket } from './batchSocket.js';

const BYTES_PER_SECOND = 32000;

export function createFallbackChain(members, { log = null } = {}) {
  let active = null;
  let fellBackFrom = null;
  let cancelled = false;
  const firstAvailable = (seconds) => members.find((member) => member.available(seconds)) || null;

  const chain = {
    name: 'fallback',
    get members() { return members; },
    available(seconds) { return members.some((member) => member.available(seconds)); },
    async probeStreaming() {
      const member = firstAvailable();
      if (!member) return false;
      active = member;
      return member.streams === false ? false : member.probeStreaming();
    },
    openStream() {
      const member = firstAvailable();
      if (!member) throw Object.assign(new Error('No fallback recognizer is available'), { code: 'ASR_UNKNOWN' });
      active = member;
      if (member.streams !== false) return member.openStream();
      return new BatchRecognizerSocket({ recognize: (wav) => chain.recognizeWav(wav) });
    },
    async recognizeWav(wav) {
      const seconds = Math.ceil(Math.max(0, wav.length - 44) / BYTES_PER_SECOND);
      let lastError = null;
      for (const member of members) {
        if (cancelled) break;
        if (!member.available(seconds)) continue;
        active = member;
        try {
          return await member.recognizeWav(wav);
        } catch (err) {
          if (cancelled) throw err;
          lastError = err;
          fellBackFrom = fellBackFrom || member.name;
          log?.warn?.('[asr] fallback recognizer failed; trying the next one', asrFailureFields(err, { provider: member.name }));
        }
      }
      if (lastError) throw lastError;
      throw Object.assign(new Error(cancelled ? 'ASR recognition aborted' : 'No fallback recognizer is available'), { code: 'ASR_UNKNOWN' });
    },
    describe() {
      const description = (active || members[0])?.describe?.() || { provider: (active || members[0])?.name || 'unknown' };
      return fellBackFrom && fellBackFrom !== description.provider ? { ...description, fallbackFrom: fellBackFrom } : description;
    },
    cancel() {
      cancelled = true;
      for (const member of members) member.cancel?.();
    },
  };
  return chain;
}
