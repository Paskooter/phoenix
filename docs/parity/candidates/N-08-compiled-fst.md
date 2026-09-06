# Compiled NLU launch profile — root review

Status: changes requested. The implementation is isolated and has not been
deployed to Moth or integrated into main. No full parity task is checked off.

Root assembled `fb5b2ae` from the four new compiled-FST modules and an explicit
request-parser hook, preserving main's existing AST implementation. The agent's
older branch also contained unaccepted AST changes; those were not imported.

The [initial root review](../evidence/2026-09-06/nlu-compiled-fst/initial-root-review.json)
records 20,528/20,528 matches for HTTP status and complete decoded parser data,
including all four non-200 controls. Root ran the real Phoenix HTTP endpoint
against the unchanged original capture. The full unit suite had 431 passes and
one profile-dependent skip; that configured test passed separately.

The unchanged strict production comparison completed all 43 smoke cases with
648 differences, zero invariant failures and zero coverage gaps. Relative to
the current main baseline, 11 difference paths disappeared and none were added.
These remaining differences keep full server parity open. The manual capture's
missing contemporaneous command receipt is documented; final verification must
use the candidate runner's explicit compiled artifact options.

The 42,460,381-byte launch graph matches the original Pegasus Git object exactly.
The archived native parser and all 16 factory-directory files match their pinned
distribution archive. All 121 native source files match the recovered manifest.
The source revision and native binaries are separate pins; their exact build
relationship has not been established by a reproducible build.

Independent source review found behavior not established by the passing corpus:

- An arbitrary graph with a caller-supplied matching hash received the approved
  launch profile's provenance. The review reproduced the valid-country-graph case.
- Factory files were hashed at load but reread during later requests.
- Final ordering used floating-point comparisons instead of the native integer
  comparator; the native sort's tie behavior also needs direct controls.
- The native pruning limit and its mixed integer/double heap comparisons need
  source-executed cutoff controls.
- General JavaScript assignment expressions and nested interpreter values were
  narrower than the original interpreter.

Root has frozen artifact pinning, verified factory snapshots, startup rejection
of invalid profiles and configured negative controls in an isolated follow-up.
Luna Max agents are repairing the remaining executor/interpreter mechanisms.
Root will review the combined changes and repeat the full corpus and strict
production comparison before integration and a Moth trial. The current default
AST replay remains 20,233/20,528; compiler/factory generation and physical
microphone/ring acceptance remain open.
