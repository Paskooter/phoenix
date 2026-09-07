# Phoenix parity execution plan

The target is a feature-complete server that preserves original Pegasus's observable behavior: HTTP/WS contracts, parser decisions, multi-turn sessions, speech and display actions, persisted data, failure behavior and interoperability with the original clients. Modern language, libraries and hosting are implementation choices; they do not justify omitted features.

This plan follows the [2026-09-05 audit](AUDIT.md). Its authoritative task ledger is [tasks.json](tasks.json); the readable [checklist](TASKS.md) is generated from it. Codex owns planning, implementation coordination, evidence review, regression prevention and release closure.

## Baseline and scope

Use original hashbrown `5c0a7390539663ba749d360de348a428c088505c` as the frozen compatibility target, and restored Pegasus `d682547a31511cd164db0913b6104eb1786455a2` as a separately identified reference. [COMPATIBILITY.md](COMPATIBILITY.md) records the client/firmware matrix, exact dependency/artifact pins, divergence classifications and companion-cloud boundary. Historical firmware candidates and ambiguous release metadata remain explicitly unverified until their consumer gates run.

Per the user's current direction, use pinned Jetstream, BE/Nimbus and Jibo Server Client source for client-contract work. [CONSUMERS.md](CONSUMERS.md) records the recovered BE 12 release, the Hashbrown SDK pin, the AWS-derived transport contract and concrete gaps. The web simulator is excluded as a parity oracle. On 2026-09-05 the user made Moth available and prioritized connecting it to this Phoenix checkout, testing and iterating. [HARDWARE.md](HARDWARE.md) records the V-04 test loop; R-04 remains the complete runtime acceptance gate. The other robot is not part of this run. Source provenance does not close hardware acceptance.

Keep three visible product tracks:

1. **Pegasus:** original hub/parser/history/lasso, skill framework and skills, original GQA integration, wire clients and configuration.
2. **Companion cloud:** Account/Loop/OOBE/Settings and the existing Phoenix Classic/OTA extensions. Required Pegasus dependencies are completed early; the rest retain their own operation-level backlog. The 26 discovered API files are a starting inventory, not proof that every cloud contract has been found.
3. **Restoration:** optional 2026 changes, such as the alternate answer/NLU behavior. Any retained profile receives its own tests and completion count.

Internal implementation changes that preserve behavior need no exception. Observable changes in DIVERGENCES.md must be repaired for compatibility or explicitly scoped to a separate supported mode. Historical labels such as “dead,” “low yield,” “wire-tested,” “household-scale,” or “simulator does not render it” do not close a feature.

Replacement providers are acceptable implementation mechanisms. Verify their adapters against frozen original upstream responses and verify current functionality separately. If an original feature cannot yet be reproduced, leave it open with the exact missing dependency/behavior. Do not replace a successful path with a no-op and count its response shape as parity.

## Execution order

The ledger has **79 tasks**: 3 management, 4 verification, 46 Pegasus, 20 companion-cloud, 1 restoration and 5 release tasks. **PM-01–PM-03 are complete.** Jot (A-19) and VoiceTraining (A-20) split newly recovered functional scope from A-18. The verified numerator is now **8**, including H-03 intent routing. These counts describe checklist granularity, not percent-complete software. Dependencies in the ledger control readiness; phase labels group the work for readability.

| Stage | Main tasks | Exit condition |
|---|---|---|
| 0. Establish trustworthy verification | PM-03, V-01–V-03, A-01 | Pinned target/consumers, runnable reference modules or documented blockers, strict failing comparison runner, mapped source coverage |
| 1. Repair public contract blockers | C-01–C-03, H-01–H-05, H-09–H-10, N-01, I-01, D-01 | Original requests reach the correct services; exact shapes/rules/settings/identity/error behavior is covered |
| 2. Complete parsing, data and state | N-02–N-08, I-02–I-03, D-02–D-07, H-06–H-08, A-02/A-06 | Named rules and local turns work; calendar/OAuth/persistence/history/provider contracts are verified |
| 3. Verify complete skill behavior | S-01–S-14, Q-01 | Full sessions, branch conditions, ESML/JCP/analytics and robot views match source fixtures |
| 4. Finish companion-cloud behavior | A-03–A-05, A-07–A-20; X-01 if retained | Every required API operation has real behavior and evidence; no placeholder is credited |
| 5. Verify the deployed product | R-01–R-04 | Unmodified clients, individual service swaps, clean install/migration, reliability and real-client journeys pass |
| 6. Release closure | R-05 | Source inventory reconciled, zero unexplained required gaps, reproducible parity report and operational/rollback instructions |

**V-01–V-04 are verified as infrastructure.** Current lead work is
**N-08**, source-backed NLU compatibility, with independent A-06 adapter
candidates under review. A-01 operation mapping remains in the backlog. V-03's complete
original/Phoenix production baseline is retained.
[PRODUCTION.md](PRODUCTION.md) records the failing 20,534-case comparison and
reviewed integration checkpoints. [COVERAGE.md](COVERAGE.md) records 960 source
cases, 89 public operation instances and all three preserved corpora; final
corpus-to-gate links are reviewed and integrated. The
[hosted CI review](evidence/2026-09-06/ci/accepted-run/review.json) confirms
passing unit/checklist checks and strict rejection of the actual mismatch.
Bounded implementation acceptance
does not close the parent product task.

The first concrete defects to resolve once the comparison gate is available are null/error serialization (C-01), missing skill-list paths/config metadata (C-03/H-01), incorrect default skill endpoints (H-09), ignored NLU rule selection (N-01), history routes/payloads (I-01), and proactive settings (H-05). Calendar envelopes/providers and durable state follow their explicitly listed dependencies.

Consumer inspection identifies explicit gates that hardware trials must measure and repair: original CreateHubToken/SigV4 behavior (A-02/H-10), declared audio encoding support (H-07), and the full transaction/session handoff into Nimbus (H-02/H-04). These remain in their existing tasks. The full trace writer is repaired and independently controlled. Hosted CI acceptance is verified; failed historical captures remain retained.

## Parallel implementation and lead verification

1. Read the task's source/consumer tests and baseline-specific differences. State the expected behavior and choose the smallest source-backed reproduction.
2. Keep one lead integration/verification task `in_progress`. Per the user's 2026-09-05 direction, Luna Max agents may implement independent, bounded candidates from the existing backlog in parallel. Assign distinct file ownership and track each candidate in `implementationReview`; preserve unrelated changes. Split overly broad work into stable child IDs while retaining the parent acceptance.
3. Add a meaningful failing comparison or regression fixture. Record whether its expected output came from the original runtime, original test fixtures, or source inspection.
4. Implement the behavior, then run the focused comparison and affected regression tests. Retain the failing-before/passing-after evidence. Broaden testing when integration effects warrant it.
5. The lead reviews submitted candidates, corrects defects, and runs the relevant original comparisons and real-robot checks. Candidate `awaiting_review` means proposed code exists, not verified parity. An `accepted` candidate covers only its stated scope; review every complete task acceptance criterion, including negative cases, side effects and persistence where applicable, before closing the main checkbox. Record revision/configuration/artifact provenance.
6. Set `verified` only after all criteria pass. Attach evidence in the ledger, regenerate the checklist, run the tracker check and update the affected source coverage entries.
7. Report the changed behavior, test evidence, remaining risk and next ready task. Continue through the dependency order.

Use `blocked` for a task with a concrete unavailable prerequisite, recording the blocker and independent work that remains possible. It does not mean the whole project must stop. A live-provider or hardware check that cannot run remains visible; elapsed time does not turn it into a pass.

## Definition of verified parity

A task must have all of the following:

- An exact source/consumer contract and a pinned baseline. Comments or an atlas summary cannot overrule conflicting executable behavior.
- Reproducible positive, negative and boundary cases appropriate to that behavior.
- Passing comparisons for required status/headers/envelopes, field absence versus null/empty, request and response order, identities and side effects.
- For conversational tasks: intent **and entities and rules**, selected skill/memo, MIM/ESML/JCP/display/analytics, and complete continuation behavior.
- For stateful tasks: persistence/restart/retention and ownership, including error cases.
- For timing/randomness: bounded timing assertions and seeded or distribution-based checks. Normalization must not erase the property being tested.
- A reviewed evidence entry with source revision, Phoenix revision/working-tree fingerprint, command, fixture/configuration, date, result and retained artifact.

The user's 2026-09-07 clarification prioritizes substantive compatibility.
Harmless error wording and internal diagnostic metadata are nonblocking when
the relevant robot/client path does not depend on them. Apply the
[consumer-focused policy](COMPATIBILITY.md#observable-compatibility-policy)
when reviewing earlier strict comparisons; preserve status/codes, data,
selection, side effects and recovery requirements.

Source-derived fixtures are legitimate evidence but must be labeled as such. They do not pretend the original runtime ran. Where acceptance explicitly requires an original-client, differential, live-provider or hardware check, the task stays open until that check is completed.

Reference session internals can remain opaque only if their externally observable continuation is verified. Whether in-flight original sessions must survive deployment cutover is an explicit compatibility decision; wholesale session deletion in a normalizer is insufficient evidence.

## How progress is measured

Maintain independent measures:

| Measure | Meaning |
|---|---|
| Implementation state | Existing code is partial, missing, stubbed, unassessed, etc.; never inferred from task checkbox state |
| Verified tasks by track | Acceptance-complete items divided by the current task count; useful workflow progress, not weighted feature completion |
| Source coverage | Operations/rules/scenario families/assets mapped to tests; covered, missing and unknown counts |
| Behavioral agreement | Exact numerators/denominators by corpus, profile and service, including no-match and failure cases |
| Release readiness | Integration, durability, deployment, provider and hardware gates still outstanding |

Do not average NLU accuracy with API coverage or present test pass rates as overall completion. Splitting/adding tasks changes task counts and must not manufacture progress. Reopen a verified task when its contract, dependencies or implementation changes invalidate its evidence.

The latest accepted tree, integrated unchanged on main, passes **677 unit tests**, with seven explicit skips, and the default
strict **43-case smoke profile with zero differences, invariants or coverage
gaps**. The [Settings Lasso review](evidence/2026-09-06/settings-lasso/review.json)
adds 48 exact original Node 8 transport controls, including post-timeout
redirect requests. The [Settings Person review](evidence/2026-09-07/settings-person/review.json)
accepts 26 full service-boundary controls, 37 transport controls and seven
original robot error-extractor controls. The [Settings Hub review](evidence/2026-09-07/settings-hub/review.json)
adds 40 payload/wire, 11 redirect/deadline and eight complete service-response
controls; every following valid request succeeds. The [error-code follow-up](evidence/2026-09-07/settings-hub-projection/review.json)
adds 22 source controls, preserving provider codes on reads and mutations while
keeping ordinary internal codes out of the response. Full A-06 remains open.
The [compiled inventory approval repair](evidence/2026-09-07/nlu-inventory-approval/review.json)
restores configured startup after the first-name inventory changed; nine configured
checks and both default and compiled strict 43-case profiles pass. The default AST
profile now has **52 differences across 20,528 requests**, down from 149. The
[character-class review](evidence/2026-09-07/nlu-class-words/review.json) records
five further repairs, zero new failure IDs and unchanged residual outputs;
97 earlier failing cases are now repaired in total.
The [new complete compiled-profile comparison](evidence/2026-09-06/production/residual-repair-full-compiled/review.json)
on frozen `ef0457f` has **zero field differences across 20,534 cases**, zero
invariants and 16 gap instances across the same eight unhosted external-answer
cases. All captured parser, routing, action, session, analytics and provider
fields agree. The H-03 empty-name and S-03 fallback repairs removed all 11
differences from the preceding compiled run; broader task acceptance remains
open. Integrated-main confirmation passed after two retained ASR fixture
timeouts and passing unchanged predecessor/current focused controls. The
earlier default-profile `057f67c` baseline retains its
49,155 differences; profiles and limitations remain explicit in
[PRODUCTION.md](PRODUCTION.md). H-03 intent routing is now verified: 35 original
functional controls, 48 applicable original tests, seven large/repeated tie
controls and all 20,528 full-corpus routing decisions agree. The
[routing review](evidence/2026-09-07/intent-router/review.json) closes that task;
the complete launch/session lifecycle remains H-04. No complete product workstream
is certified.

Future long captures should use an isolated, fixed verification worktree so
main can continue receiving reviewed commits and pushes while evidence stays
pinned. Never modify that worktree's code or HEAD during a capture.

The [earlier explicit-weight candidate review](evidence/2026-09-07/nlu-explicit-weight/review.json)
retains the rejected 176-difference run and its 60 new failures. The final native
operator repair removes all 60 of those regressions and passes the full frozen
HTTP replay. Twenty-five executable native semantic controls agree; three native
runtime failures remain qualified. The subsequent factory/arbitration repair
completed its independent full replay with 57 residual differences; the later
character-class repair reduces that to 52. The [portable graph runtime](evidence/2026-09-07/nlu-portable-snapshot/review.json)
is now accepted after a complete 20,534-case replay with zero differences/invariants
and the same eight unhosted external-answer cases. The [bundle installer and
native/Compose startup](evidence/2026-09-07/nlu-snapshot-deployment/review.json)
are accepted. A [temporary authenticated portable-parser Moth trial](evidence/2026-09-07/hardware/portable-snapshot/review.json)
passed with rollback; persistent deployment and microphone/ring acceptance remain open. A proposed hand-written rule-pair tie table was rejected; future
changes must reproduce general source semantics.

The [H-04 launch review](evidence/2026-09-07/skill-launch/review.json) accepts
bounded older-release mediation and launch/update/redirect history behavior.
All 171 original mediator controls and 12 HTTP launch controls agree; nine
previously failing history/request controls now pass. The [continued-session review](evidence/2026-09-07/listen-continuation/review.json)
also accepts source trace defaults and complete launch/update request and action
fields across two turns, with 92 raw/structural guards. The original control
uses its executable socket reader/handler; Phoenix uses an actual WebSocket
connection. The [disconnect review](evidence/2026-09-07/listen-disconnect/review.json)
also accepts three early-close/provider/timeout cases with 140 guards. Full
original-client transport and deployed acceptance remain open, so the verified
checklist stays at 8/79. Harmless diagnostic differences follow the user
policy; structured error identities still require consumer checks.

## Tracker commands

```bash
npm run parity:status                 # counts and next task whose dependencies are verified
npm run parity:status -- --json       # machine-readable status
npm run parity:status -- --write      # regenerate TASKS.md after changing tasks.json
npm run parity:check                  # reject invalid dependencies/evidence or stale checklist

node scripts/parity-probes.mjs --out /tmp/phoenix-probes.json
```

The probe command starts temporary local services and records observations. It deliberately does not label the resulting run a parity pass. Its cases should become regression/differential gates as the corresponding defects are repaired.

To close a product task, add a verification entry like this after reviewing its artifact:

```json
{
  "date": "YYYY-MM-DD",
  "basis": "reference differential",
  "referenceRevision": "<source commit and fixture version>",
  "phoenixRevision": "<commit plus working-tree fingerprint if dirty>",
  "command": "<exact reproducer/comparison command>",
  "artifact": "docs/parity/evidence/<run>/<result-file>",
  "result": "pass",
  "notes": "<acceptance coverage, limitations and reviewer>"
}
```

The tracker also shows separate candidate implementation checkboxes (`working`, `awaiting_review`, `changes_requested`, `accepted`). Only the lead updates these review decisions and final parity status. Agents submit code and focused evidence reports; their test results alone cannot close a task.

Implementation agents work in separate Git worktrees and branches, created from
a private snapshot of the current workspace. Each has its own dependency tree
with workspace links resolving inside that checkout. Moth runs the lead's
checkout. The lead reviews each candidate diff and applies one candidate at a
time for integration and robot testing; an agent's edits cannot hot-change the
robot's backend. Shared historical reference caches are read-only inputs.

The tracker validates metadata, evidence file presence, dependencies, cycles and stale generated output. It cannot establish that evidence is truthful or complete; evidence review remains the project manager's responsibility. V-02 supplies a strict foundational HTTP/hub gate; V-03 expands source coverage and production corpus grading.

## Lifecycle risks to resolve in the tasks

| Risk | Management response |
|---|---|
| Comparing against the wrong era of Pegasus | PM-03 pins original/restored variants and never blends their scores |
| Incomplete or old oracle artifacts | V-01/V-03 recover version-matched artifacts and label missing provenance |
| Positive-only corpus gives misleading confidence | V-02/V-03 add negative cases, full fields and failure exits |
| Dead provider credentials hide a missing success path | D-03/D-04/Q-01 use original fake-provider fixtures, then verify a supported current adapter |
| Historical sessions/data fail across migration | I-03/S-01/R-02 verify persistence, cutover and rollback explicitly |
| Physical UI/firmware behavior cannot be exercised in a sim | S-13/R-04 keep a real-consumer gate; record firmware and test conditions |
| Broad Classic scope conceals unidentified operations | A-01 maps all discovered targets and investigates non-SDK contracts |

The audit, plan and compatibility manifest are complete; engineering verification is underway. Later release operations, especially robot wiping or firmware changes, need a concrete validated procedure and authorization at the time of execution. No hardware change is required for isolated reference execution.

The latest bounded [listen disconnect/timeout review](evidence/2026-09-07/listen-disconnect/review.json) passes three original-source cases and 140 guards. Its integrated tree passes 591 unit tests and strict43; full H-04 and deployed robot acceptance remain open.

The [GQA core adapter review](evidence/2026-09-07/gqa-core/review.json) accepts the explicit factory/HTTP adapter with20 complete source HTTP controls,473 blocked-term and193 NLP controls. The [explicit Wikipedia profile review](evidence/2026-09-07/gqa-wikipedia/review.json) adds 34 complete response/recovery cases, 40 provider requests and 68 original Hub client exchanges, with nine root behavior corrections. Other provider and deployment acceptance remains separate and Q-01 stays open. The [portable-parser Moth trial](evidence/2026-09-07/hardware/portable-snapshot/review.json) passed native authentication, clock rendering, joke playback calls and restored the prior backend; it does not close microphone/ring or persistent deployment acceptance.

The [suspension HTTP/state repair](candidates/A-04-suspension-root-pending-20260907.md)
is integrated after root testing, original-client and actual-controller controls.
Downstream LoopUpdated notifications, full signature verification and whole
A-04 remain open. The [multi-provider candidate](candidates/Q-01-multiprovider-root-pending-20260907.md)
has 36 passing root response/recovery comparisons with original dependencies,
plus 12 connection/decode failure and same-provider recovery cases. The repaired
Unicode candidate passes 210 root comparisons against original provider output;
packaging and combined integration remain pending.

The [punctuation candidate was rejected](evidence/2026-09-07/nlu-punctuation-rejected/review.json):
it repairs one full-corpus case but adds seven failures involving “c.e.s.”,
raising residual differences from 52 to 58. Main retains the accepted parser.
These bounded reviews do not change the 8/79 fully verified task count.

The [authenticated development launcher](../../scripts/parity-robot/AUTHENTICATED.md)
is integrated with a Classic HTTPS server that retains notification upgrades.
Thirty local checks, 678 unit tests and strict43 pass. A
[real Moth trial](evidence/2026-09-07/hardware/authenticated-launcher/review.json)
verified native TLS token issuance, both authenticated Hub paths, clock rendering
and a synthetic proactive exchange, followed by independent rollback checks.
Persistent deployment, reboot supervision and microphone/ring acceptance remain open.

The explicit [GQA multi-provider profile](candidates/Q-01-multiprovider-root-pending-20260907.md)
is integrated after root source comparison, generator reproduction and final
regression review. It preserves provider ordering/recovery and Unicode answer
selection, and fixes repeated date placeholders in spoken Wolfram templates.
Default deployment, account/attribution and full Q-01 remain open.

The [combined punctuation repair](evidence/2026-09-07/nlu-punctuation-literals/review.json)
is accepted: the default AST full corpus now has 51 residual differences, down
from 52, with no new or changed failures. Root independently reviewed the full
capture and passed fresh native/HTTP checks plus 716 units and strict43.
The durable notification candidate remains unverified: root reproduced
in-memory state changes after failed persistence and requested a repair.

The [optional account lookup deadline](candidates/H-10-account-deadline-20260907.md)
now prevents a stalled account endpoint from holding a Hub upgrade indefinitely.
Both socket paths recover after a rejected lookup, and actual Account service
revocation/reactivation checks pass. Native expiry/refetch and persistent
authenticated deployment remain open. README authentication and TLS guidance
now describes the native signed-token exchange and current launcher accurately.

The [Account snapshot restart repair](candidates/H-10-account-store-permissions-20260907.md)
keeps credential files private across saves by library/standalone callers.
Root verified a real Account mutation followed by launcher restart and reuse of
the issued token on both Hub paths. The final suite passes720 units and strict43.
Notification follow-up review also reproduced storage-fault crashes in socket
callbacks/polling and a concurrent outbox update left waiting for explicit recovery;
those substantive delivery failures remain with the agent for repair.

The [notification follow-up](candidates/A-10-notification-root-review-20260907.md)
is now accepted for local persistence, socket delivery and the explicit
suspension outbox. Root reproduced recovery from the earlier callback/race
failures, fresh original Node8 behavior and local TLS restart delivery;740 units
and strict43 pass. Verified token/account identity, default event publishing
and robot acceptance remain open. The separate `$w03` parser proposal is
rejected because a native-confirmed relative wildcard selection regresses;
main retains the51-residual baseline.

The [launcher supervision control](evidence/2026-09-07/launcher-supervision/review.json)
accepts the Linux user-service template after a real process failure and
automatic restart. Issued Hub credentials and a pending TLS notification
survive; explicit stop remains stopped, and the owned test unit/configuration
and listeners are removed. Moth deployment, forwarding/trust dependencies and
reboot acceptance remain separate. A passive180-second Moth observation saw
no native speech events and provides no new microphone or ring proof.

The [authenticated Moth backend](evidence/2026-09-07/moth-authenticated-stage/review.json)
is staged under the tested user service. Local signed TLS issuance and both
authenticated Hub paths pass using the matching private robot identity. Moth
has not switched to it; forwarding, trust and native acceptance remain open.
The [notification identity candidate](evidence/2026-09-07/notification-auth-validation/review.json)
requires repair because malformed signed requests rotate an existing token.
This is a substantive state change; harmless error prose remains nonblocking.

The [GQA account/attribution integration](candidates/Q-01-account-attribution-root-20260907.md)
is accepted for explicit account lookup and storage configuration. Root8 actual
HTTP comparisons and source insertion/account calls match;750 units and strict43
pass. Historical Python and real Mongo evidence were reviewed separately.
Malformed HTTP boundaries, live providers, default deployment and Q-01 remain open.

Moth is now [connected to supervised authenticated Phoenix](evidence/2026-09-07/hardware/supervised-authenticated/review.json).
Root verified native TLS issuance and both Hub paths, a clock turn after normal
service restart, and independent idle/health/configuration/credential checks.
The older backend is available for rollback. The robot trust bind still needs
a boot-persistent solution; microphone/ring and Notification remain open.

The [authenticated notification bridge](candidates/A-10-authenticated-bridge-root-20260907.md)
is accepted for the colocated launcher. Root repaired omitted/null HTTP body
handling before token mutation, matched23 original Hapi cases, and verified
TLS account isolation and restart recovery;751 units and strict43 pass.
Moth remains on29ffac3 until a separate deployment check. Notification socket
configuration and remaining Loop-save producers are the next A-10 work.
