// Comparison-harness entry point.
//
// The full M0 runner drives a corpus (the reference's 2,573-utterance test-manifest at
// CLIENT_ASR injection level) into BOTH the Pegasus reference stack and Phoenix, then diffs the
// normalized message streams. That driver depends on the gateway/skills being runnable, so it
// arrives with M6. Today this package ships the reusable core — normalizeStream + diffStreams —
// plus this CLI placeholder. See packages/harness/README.md for the design.

import { normalizeStream } from './normalize.js';
import { diffStreams } from './diff.js';

export { normalizeStream, normalizeMessage } from './normalize.js';
export { diffStreams } from './diff.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(
    [
      'phoenix harness — comparison core (M0 runner pending M6).',
      '',
      'Programmatic use:',
      "  import { diffStreams } from '@phoenix/harness';",
      '  const diffs = diffStreams(referenceStream, phoenixStream, { level: "D2" });',
      '',
      'See packages/harness/README.md for the reference-vs-new harness design.',
    ].join('\n'),
  );
  void normalizeStream;
  void diffStreams;
}
