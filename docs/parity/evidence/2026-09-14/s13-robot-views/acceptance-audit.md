# S-13 acceptance audit — 2026-09-14

Date: 2026-09-14
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Phoenix capture revision: `fcfe0fe9e37c85411d5e32dd134e3328a695eac9`
Matrix digest: `d7784113ca8cdf5903645c60d8bb04a4704c6af9302a9184e304657ba784e5bc`

This audit walks every written S-13 criterion against evidence that exists
now. The raw capture, the receipts and the screenshots stay private; this file
records digests and outcomes only.

## Verdict

**VERIFIED (bounded).** Both acceptance criteria have current, falsified,
source-backed evidence. The bounds in *Scope and limitations* are explicit and
unclaimed in the receipt.

## Criterion 1 — generate every original view config, dynamic field, image path, geometry, unit label and display threshold

`VERIFIED.` The 61-row report-view source differential runs the original
Pegasus helpers in `node:8.9.4-slim` and the Phoenix helpers in
`node:22.22.0-slim`, both `--network none` and read-only, and compares complete
view JSON per row.

- 61 rows, 61 matches, 0 differences (weather 20, traffic 7, depart 4, news 5,
  calendar 25).
- 16 adversarial controls all rejected: paired row omission, row reorder,
  duplicate row, row self-hash corruption, rehash output mutation, input
  provenance substitution, source provenance mutation, candidate tested
  revision mutation, non-descendant candidate revision, tagged error
  substitution, source runner substitution, candidate runner substitution,
  matrix replacement, candidate implementation mutation, candidate resource
  mutation, source dependency record mutation.

### Contract re-pin

The differential initially reported `fatal: candidate dependency changed:
package.json`. That pin is over whole-file bytes. The only delta since the pin
was written is three added npm script entries for the S-13 harness itself
(`parity:s13:provenance`, `parity:s13:finalize`, `parity:s13:falsify`). The
dependency graph did not move: `dependencies`, `devDependencies`,
`optionalDependencies`, `peerDependencies`, `overrides` and `resolutions` are
identical between the two revisions, and `package-lock.json` and
`packages/skills/package.json` still match their original pins exactly. The pin
was updated with that justification recorded in
`scripts/parity-s13-source-diff/contract.json` under
`candidate.dependencyPinNotes`, and the matrix and comparator digests were
re-pinned with it. The row comparison was already exact before and after.

## Criterion 2 — compare payloads with source fixtures and render them on a compatible robot/client

`VERIFIED.` Five fixture-backed lanes were captured on the authorized Moth
robot against the supported `@be/phoenix-parity-11-0-1` client, then bound into
one terminal receipt.

| Lane | flow shape | views | status |
| --- | --- | --- | --- |
| `commute-normal-combined` | two-stage | `trafficView`, `departTimeView` | pass |
| `commute-bad-combined` | one-stage | `trafficView`, `departTimeView` | pass |
| `commute-terrible-combined` | two-stage | `trafficView`, `departTimeView` | pass |
| `calendar-four-card-field-matrix` | one-stage | four ordered `eventView` | pass |
| `calendar-concurrent-parallel` | two-stage | two ordered `eventView` | pass |

Every lane reports `phoenixMatchesMatrix: true`, `noBypass: true` and
`claimed: true`, with an ordered display/screenshot correlation and a native
final idle snapshot.

Terminal receipt `3fc18a7c0030f037bb76b36a2f023fe7f23c6f7bd1c2c654f4bb6c1e66c1d031`
(`decision: verified_bounded`, `taskStatus: closed`, `complete: true`, 17 rows
checked). Independent strict validation over that receipt reports
`{"result":"pass","errors":0,"checkedCases":17}`.

## Flow shapes

The two shapes are not an operator choice. `UserIDFactory.checkSpeakerID`
computes `haveSpeaker || !needSpeaker`; commute and calendar single-skill
reports always need a speaker, so a recognized speaker takes the `True` edge
straight to UserID `Done` and the WhoIsThis question node — with its
`whoIsThisMenu` prelude and its local turn — is unreachable. Both edges
converge on the same `Done`, so every downstream report node, MIM path and view
payload is produced by identical code.

Three independent sources agree on all five lanes: the raw client `CONTEXT`
`data.runtime.perception.speaker`; the robot's own history service, where the
two-stage lanes carry a second `loopmember` launch in the same skill session
and the one-stage lanes carry a single identified launch; and the ordered
display actions, where only the two-stage lanes contain a `whoIsThisMenu`
prelude. `CommuteConfirmSpeaker` appears in both shapes, as
`CommuteMimLogic._getMimPaths` requires whenever `singleSkill` is set.

The receipt declares `wireFlow.shape` and `wireFlow.speakerState`, and the
validator re-derives the shape from the raw `CONTEXT` line and rejects a
receipt whose declaration disagrees, in either direction. `speakerState`
records only the boolean and the raw source locator; the looper identifier
never enters a receipt.

## Provenance

Same-session, collected before and after the capture over root SSH, read-only.
Comparison is `matched: true` with zero differences across 164 immutable file
rows.

- Phoenix `fcfe0fe9e37c85411d5e32dd134e3328a695eac9`, tree
  `f083781be01c8ec354ab92273df8065f6cb3c2a20b14e208823f4729488b8fc8` over 7,113
  tracked files from a clean detached worktree at the capture revision.
- BE `@be/phoenix-parity-11-0-1` 11.0.1, slot `phoenix-be-11-0-1-parity`.
- Nimbus `@be/nimbus` 3.0.1; asset manifest digest matches the audited manifest
  recorded in the matrix.
- Native firmware `3.3.0 InDev`, SSM 16.0.0, client node `v6.9.2`.

The collector's stable projection previously compared the whole firmware
object, including `rawOutputSha256` — the digest of the robot's rolling
`/tmp/messages` syslog, which the robot appends to while the capture runs. That
made every genuine before/after pair differ. It now compares the firmware
identity. The log is deliberately excluded from the immutable file rows, and
those rows are still compared exactly.

## Independent visual review

Authored by a separate reviewer agent that opened each image, not by the
producing agent: `independent-visual-reviewer-deepseek-v4.1-flash`,
`independentReviewer: true`, `allPassed: true`, 12 of 12 records `pass`, review
digest `021752c12c27af03a3181e85cc2194e7553cab7a25cc985a8d71dab647f20e53`.

Root re-verified every record against the files: all 12 paths, digests and byte
lengths reproduce, no record is missing or duplicated. The review discriminates
rather than rubber-stamps — it separates the three traffic severities (green
ring, yellow warning triangle, red octagon, matching
`trafficNormal`/`trafficBad`/`trafficTerrible`) and reads three distinct
departure times (`1:40`, `1:35`, `1:25`, all `AM`) that match the contract
exactly. A second reviewer agent reached the same 12 verdicts independently.

## Independent validation anchors

Attested by `independent-validation-witness-deepseek-v4.1-flash` after
re-deriving each binding: the review digest recomputed from the staged file;
the falsification record observed to be non-provisional with 29 controls all
rejected and all exit codes non-zero; the provenance content checked field by
field; and the capture window chosen from the evidence
(`2026-09-14T04:46:28.000Z` to `2026-09-14T04:49:09.000Z`), containing all 12
capture timestamps and sitting inside both provenance snapshots with gaps well
under the five-minute bound.

## Receipt-bound falsification

The real 29-control falsifier ran against the terminal receipt: `result: pass`,
29 of 29 rejected, `provisional: false`.

Its first real run exposed three defects, all now repaired:

1. `no-view-screenshot-injection` and `blocked-tree-claim` resolved their target
   row through a closure over the shared baseline instead of the clone under
   validation. The mutation landed on the original object, so the first control
   reported `accepted` without testing anything and every later control cloned
   a polluted baseline.
2. `action-payload-mutation` and `view-contract-mutation` wrote to
   `actual.action.mimIds` / `.viewIds`, the older fixture shape; a v2 receipt
   carries them under `action.projection`, so both crashed.
3. With those fixed, `local-turn-body-contract-mutation` was accepted. It forges
   `handle.nluRules`, but the recorded handle's real field is `rules` and the
   validator never compared the handle to its raw source. The local-turn body
   contract was declared in the matrix and unenforced in the receipt. The Tl
   handle is now bound to the raw follow-up call.

Root additionally falsified the terminal receipt directly, restoring it after
each: forging a one-stage lane into two-stage (fail), corrupting one screenshot
byte (fail), dropping the `Tl` stage from a two-stage lane (fail), flipping
`speakerState.identified` (fail), downgrading a falsification control to
`accepted` (fail). The unmutated receipt re-validates clean.

## Test suite

61 tests pass across `scripts/parity-s13-physical/test.mjs`, `test-v2.mjs`,
`shape.test.mjs`, `finalize.test.mjs`, `scripts/parity-robot/s13-fixture.test.mjs`
and `scripts/parity-s13-provenance/collect.test.mjs`, plus 2 in
`scripts/parity-s13-source-diff/test.mjs`. 16 of those are flow-shape controls
added with this change, covering both directions of the shape contract and the
producer's refusal of raw evidence that contradicts either shape.

## Scope and limitations

Explicit in the receipt and unclaimed:

- `commute-pm-departure-combined` is skipped: `pmDepartureAvailable` is false.
  S-11's 61-row source lane owns AM/PM coverage.
- `calendar-tree-park-nature` stays blocked. The original `tree_v01.crn` asset
  is absent from both audited Nimbus archives. That is an original-package
  defect; Phoenix supplies no substitute and claims no tree-icon render.
- `weather-revalidation` and `news-revalidation` are referenced against their
  prior accepted receipts by exact bytes, not re-captured.
- The eight linked no-view rows are asserted from their source receipts, with
  no view or screenshot claim.

Outside this boundary entirely: the capture uses `mimic_global_turn` with
`clientASR` text injection and `microphoneAcceptance: false` against private
deterministic provider fixtures. It does not certify microphone recognition,
hotword, blue-ring behaviour, live Google/Outlook accounts, Settings, OAuth, or
live Maps/weather/news provider parity.

One bounded consideration from the source review: on the two-stage path
`SetLooperIDNode` can overwrite the speaker, so in principle the two shapes
could resolve different accounts. It does not affect this claim — every lane's
provider calls were served from its pinned immutable fixture, and all five
lanes report `phoenixMatchesMatrix: true` against the matrix-expected
projection.

## Reproduction

```bash
node scripts/parity-s13-source-diff/run.mjs --out .parity/runs/s13-report-views-audit
node scripts/parity-s13-source-diff/falsify.mjs --run-dir .parity/runs/s13-report-views-audit
node --test scripts/parity-s13-physical/test.mjs scripts/parity-s13-physical/test-v2.mjs \
  scripts/parity-s13-physical/shape.test.mjs scripts/parity-s13-physical/finalize.test.mjs \
  scripts/parity-robot/s13-fixture.test.mjs scripts/parity-s13-provenance/collect.test.mjs
```

The producer, finalizer, falsifier and validator steps run against the private
capture root and are recorded there; they read bytes only and never contact a
robot.
