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

The ledger has **77 tasks**: 3 management, 4 verification, 46 Pegasus, 18 companion-cloud, 1 restoration and 5 release tasks. **PM-01–PM-03 are complete.** These counts describe the initial plan's granularity, not percent-complete software. Dependencies in the ledger control readiness; phase labels group the work for readability.

| Stage | Main tasks | Exit condition |
|---|---|---|
| 0. Establish trustworthy verification | PM-03, V-01–V-03, A-01 | Pinned target/consumers, runnable reference modules or documented blockers, strict failing comparison runner, mapped source coverage |
| 1. Repair public contract blockers | C-01–C-03, H-01–H-05, H-09–H-10, N-01, I-01, D-01 | Original requests reach the correct services; exact shapes/rules/settings/identity/error behavior is covered |
| 2. Complete parsing, data and state | N-02–N-08, I-02–I-03, D-02–D-07, H-06–H-08, A-02/A-06 | Named rules and local turns work; calendar/OAuth/persistence/history/provider contracts are verified |
| 3. Verify complete skill behavior | S-01–S-14, Q-01 | Full sessions, branch conditions, ESML/JCP/analytics and robot views match source fixtures |
| 4. Finish companion-cloud behavior | A-03–A-05, A-07–A-18; X-01 if retained | Every required API operation has real behavior and evidence; no placeholder is credited |
| 5. Verify the deployed product | R-01–R-04 | Unmodified clients, individual service swaps, clean install/migration, reliability and real-client journeys pass |
| 6. Release closure | R-05 | Source inventory reconciled, zero unexplained required gaps, reproducible parity report and operational/rollback instructions |

**V-01, V-02 and V-04 are verified as infrastructure.** Current lead work is
**V-03**, whose complete original/Phoenix production baseline is now retained.
[PRODUCTION.md](PRODUCTION.md) records the failing 20,534-case comparison and
reviewed integration checkpoints. [COVERAGE.md](COVERAGE.md) records 960 source
cases, 89 public operation instances and all three preserved corpora; final
corpus-to-gate links remain to be reconciled before V-03 closes. A-01 retains
the companion-cloud operation inventory. Bounded implementation acceptance
does not close the parent product task.

The first concrete defects to resolve once the comparison gate is available are null/error serialization (C-01), missing skill-list paths/config metadata (C-03/H-01), incorrect default skill endpoints (H-09), ignored NLU rule selection (N-01), history routes/payloads (I-01), and proactive settings (H-05). Calendar envelopes/providers and durable state follow their explicitly listed dependencies.

Consumer inspection identifies explicit gates that hardware trials must measure and repair: original CreateHubToken/SigV4 behavior (A-02/H-10), declared audio encoding support (H-07), and the full transaction/session handoff into Nimbus (H-02/H-04). These remain in their existing tasks. The full trace writer is repaired and independently controlled. V-03 now owns final coverage-link review; failed historical captures remain retained.

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

Current main passes **384 unit tests** and still fails its strict 43-case smoke
with **659 field differences**, zero invariants and one unhosted action gap.
The complete `057f67c` baseline has **49,155 field differences across 20,534
cases**, zero invariants and 97 gap instances across both sides. Exact action
objects agree in 20,170/20,434 comparisons. The complete baseline predates the
latest A-02/S-01 integration; all dimensions and limitations are retained in
[PRODUCTION.md](PRODUCTION.md). No complete product workstream is certified.

Future long captures should use an isolated, fixed verification worktree so
main can continue receiving reviewed commits and pushes while evidence stays
pinned. Never modify that worktree's code or HEAD during a capture.

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
