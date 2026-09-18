// Controllable in-process peers for R-03 transaction measurements.
// These are test doubles, not HTTP/ASR/provider performance measurements.
// Settlement timestamps prove late work; no inert 'aborted' flag claims cancellation.
function pendingCall(calls, metadata, { delayMs, fail, hang }, result) {
  const call = { startedAt: Date.now(), settledAt: null, ...structuredClone(metadata) };
  calls.push(call);
  if (hang) return new Promise(() => {});
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      call.settledAt = Date.now();
      if (fail) reject(Object.assign(new Error(fail.message || 'peer failed'), fail));
      else resolve(result);
    }, delayMs);
  });
}

export function makeParser({ delayMs = 0, fail = null, hang = false, result } = {}) {
  const calls = [];
  return {
    calls,
    handleNLU(input, trace) {
      return pendingCall(calls, { input, trace }, { delayMs, fail, hang },
        result ?? { intent: 'launchTest', rules: ['launch'], entities: {} });
    },
  };
}

export function makeSkill({ delayMs = 0, fail = null, hang = false, action } = {}) {
  const calls = [];
  const launchOrUpdate = (skillID, input, trace, isUpdate = false) => pendingCall(
    calls, { skillID, input, trace, isUpdate }, { delayMs, fail, hang },
    { response: action ?? { type: 'SKILL_ACTION', data: { skill: { id: skillID } } } },
  );
  return { calls, launchOrUpdate, launch: launchOrUpdate };
}

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

// Nearest-rank percentiles; no interpolation or alteration of raw samples.
export function percentiles(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { n: sorted.length, p50: at(50), p95: at(95), max: sorted.at(-1) };
}
