// Normalize messages before diffing reference vs new (docs/atlas/verification-strategy.md §"Normalize").
//
// Strip everything non-deterministic or implementation-private so that two byte-different but
// behaviorally-equal streams compare equal:
//   - envelope volatiles: msgID, ts, timings
//   - skill.session CONTENTS (assert round-trip presence only; nodeID assignment is the new
//     impl's own concern) -> replaced with a stable marker
//   - port-bearing URLs anywhere in the tree -> host:PORT collapsed
//
// Keep the discriminator `type`, `final`, and all behavioral payload.

const VOLATILE_KEYS = new Set(['msgID', 'ts', 'timings']);
const URL_WITH_PORT = /\b(https?:\/\/[^/:\s"]+):\d+/g;

function scrubUrls(v) {
  return typeof v === 'string' ? v.replace(URL_WITH_PORT, '$1:PORT') : v;
}

/**
 * Deep-normalize a single message.
 * @param {unknown} msg
 * @returns {unknown}
 */
export function normalizeMessage(msg) {
  return walk(msg);

  function walk(node, key) {
    if (Array.isArray(node)) return node.map((n) => walk(n));
    if (node && typeof node === 'object') {
      // A skill session: keep its presence and id-shape but blank the opaque contents.
      if (key === 'session' && ('nodeID' in node || 'data' in node)) {
        return { _session: true };
      }
      const out = {};
      for (const [k, val] of Object.entries(node)) {
        if (VOLATILE_KEYS.has(k)) continue;
        out[k] = walk(val, k);
      }
      return out;
    }
    return scrubUrls(node);
  }
}

/** Normalize an ordered stream of messages. */
export function normalizeStream(stream) {
  return stream.map(normalizeMessage);
}
