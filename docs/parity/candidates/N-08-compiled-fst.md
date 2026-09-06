# Compiled NLU profile — root review

Status: repaired candidate `41b4696` awaits original multiple-rule HTTP controls
and a new Moth trial. It is isolated and has not been deployed or integrated.
The earlier `e586360` regression and verified rollback remain recorded below.
No full parity task is checked off.

The [multiple-rule repair review](../evidence/2026-09-06/nlu-compiled-fst/mixed-rule-review.json)
records source-scored execution for all 98 requested public graphs, explicit
artifact configuration and verified in-memory graph snapshots. Root preserved
the default AST path and added graph substitution and lazy executor controls.
After provisioning and verifying candidate-local workspace links, root reran
449 unit tests, 63 configured NLU tests and all 20,528 archived parser HTTP
responses successfully. The 43-case production comparison retains exactly the
same 648 differences as the preceding compiled candidate, with no invariant
failures or coverage gaps. Actual BE multi-rule combinations and native rule
failure handling remain under independent source review.

The [combined root review](../evidence/2026-09-06/nlu-compiled-fst/combined-root-review.json)
records 20,528/20,528 original HTTP status/data matches, 449 passing default
unit tests and 63 passing configured NLU tests. The two default-suite skips
are configuration-dependent tests that pass in the configured suite. Strict
production capture still has 648 differences across 43 cases, zero invariant
failures and zero coverage gaps. Its complete difference list matches the
earlier compiled-profile capture.

The [Moth trial](../evidence/2026-09-06/nlu-compiled-fst/moth-trial-review.json)
exposed a regression outside that fixed corpus. BE requests `launch` together
with `globals/global_commands_launch`. For “cancel the timer,” the native
launch result scores 13 and the native global command scores 7. Phoenix
compares the compiled launch score with the AST global command's unrelated
priority scale, selects the global command and loses the clock skill match.
The previous AST profile selects the clock result correctly. The
[counterexample](../evidence/2026-09-06/nlu-compiled-fst/multirule-regression.json)
retains both native results and both Phoenix outputs.

Clock display, joke playback and a timer-duration local turn succeeded on the
candidate. Those successes do not override the cancellation regression.
The robot retained its native process and configuration throughout the backend
swap and rollback. Root verified the restored clock countdown and cancellation
routing. Tests used the original BE/Jetstream client with text injection;
natural microphone wake and physical ring visibility remain unverified.

The next implementation must use source-comparable scores for every requested
rule in the selected compiled profile, verify every consumed graph/factory
snapshot, and preserve source tie and validity rules. Adding a timer exception
or scaling AST scores by a constant would not establish that behavior. A new
original-service matrix will cover actual BE rule combinations before another
full replay and robot trial.

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

Root has now verified the artifact pins, factory snapshots, startup rejection,
native integer sorting/pruning and interpreter repairs in `e586360`. The
[native control summary](../evidence/2026-09-06/nlu-compiled-fst/combined-native-controls.json)
distinguishes full ordering checks with host C++ from the archived native
parser's first-result controls. It also corrects earlier agent metadata:
the interpreter and adversarial CLI runners executed the archived binaries
on the VM with their archived libraries; their Docker/Node8 labels did not
describe those commands. Original service captures have separate Docker
receipts. No reproducible source-to-binary build claim is made.

The [service cache correction](../evidence/2026-09-06/nlu-compiled-fst/service-cache-lifecycle.json)
pins the newly recovered NLU service callsite. It creates fresh dynamic graph
groups per request while caching underlying FST bytes; the initial CACHE-001
review described a retained library parser's lifetime instead. Executing the
verified factory snapshot remains required.

The default main AST replay remains 20,233/20,528. Compiler/factory generation,
multiple-rule selection, full server behavior and microphone/ring acceptance
remain open.
