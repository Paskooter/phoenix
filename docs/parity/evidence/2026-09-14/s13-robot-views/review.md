# S-13 robot display recapture — superseded by the 2026-09-14 acceptance audit

Date: 2026-09-14
Reference: `jiboV2/pegasus@5c0a7390539663ba749d360de348a428c088505c`
Phoenix revision for the replacement Terrible turn: `5a67215a6b64f7587a9b59376c7a6dd79f799065`
Final Moth recapture: `/home/shell/.local/share/phoenix/moth/run/s13-recapture-6afe114-20260914T000704Z`

## Review status

**SUPERSEDED.** This file records the earlier `s13-recapture-6afe114` run and
its pending status. S-13 was subsequently accepted on a later capture
(`s13-fresh-nimbus-fcfe0fe`) at Phoenix revision
`fcfe0fe9e37c85411d5e32dd134e3328a695eac9`; see
[`acceptance-audit.md`](./acceptance-audit.md) for the current
requirement-by-requirement verdict, the terminal receipt digest, the
independent visual review and anchors, and the 29-control falsification
result. The text below is retained unchanged as the historical record of the
earlier run and must not be read as the current status.

**PENDING REVIEW — NOT VERIFIED (historical, for the earlier run).** The source-backed weather, news, commute,
and calendar builders retain their 61/61 differential evidence. A fresh Moth
recapture conditionally observed five fixture-backed commute/calendar cases on
the supported BE 11.0.1 client and visually inspected twelve unique target PNGs.
Every case used strict idle preflight and returned to strict idle afterward;
production was restored and the post-restore observation was idle. This is
useful physical evidence, but S-13 remains open until the final aggregate
receipt passes `validate.mjs` and the complete falsifier run passes. No S-13
verification entry is recorded here.

The replacement Terrible turn is the
`commute-terrible-combined-v2` bundle, captured on Phoenix revision `5a67215`
with fixture work time `22:30` (10:30 PM). Its target sequence has
exactly these three MIM IDs, in order: `CommuteConfirmSpeaker`,
`CommuteDriveTerrible`, and `CommuteDepartTimeNotNormal`; the departure card
renders `Depart 10:05 PM`.

The original `tree_v01` calendar icon remains unavailable in both audited
Nimbus archives. That is a separate bounded source-package exception; Phoenix
does not provide a replacement or claim a tree-icon render.

The physical turns used the original BE `mimic_global_turn` operation with
`clientASR` text injection and `microphoneAcceptance:false`. They do not prove
microphone recognition, hotword behavior, blue-ring behavior, live Google or
Outlook accounts, Settings, OAuth, live Maps, or live weather/news/AP provider
parity.

## Source-backed view contract

The source differential at the private run directory
`.parity/runs/s13-source-root-f56193c/` passed 61/61 complete JSON rows with no
differences:

| group | rows |
| --- | ---: |
| weather | 20 |
| traffic | 7 |
| departure | 4 |
| news | 5 |
| calendar | 25 |
| **total** | **61** |

All 16 source-harness falsification controls rejected their mutations. The
comparison receipt records:

- source receipt: `98fc07a5cb7add2322a9f4775ee8067f02e3f7714375d672d8cd34c6c52798ea`;
- candidate receipt: `07d746999c821589aa63f6efaa0bb52ba761d099b640933e6aee5f71305acc08`;
- comparison: `5c856462c451a1bbc5d8e67bdf4fbc3847234e6365d3b9e3aaf1e511d4db5c04`;
- falsification: `b68e3246ca9c7d440a0d5d2939b2567dcf45b7251d059fad87aeedcc683ead9b`.

The harness pins the original source revision, candidate implementation
revision `0902410c597f8dc424af60ee98fc4d32f19a1bb0`, all six view resources,
the source and candidate dependency inputs, and the Node 8.9.4/Node 22.22.0
runtime images. It runs with networking disabled and requires the tested
revision to descend from the implementation pin.

## Fresh five-case Moth recapture

The retained Normal, Bad, and calendar case stacks record Phoenix revision
`a7d7db7cdd214fc82e3a1ef8ed92fa3390425252`; the replacement Terrible stack
records `5a67215a6b64f7587a9b59376c7a6dd79f799065`. All use Node `v22.22.0`,
authenticated Hub transport, and the supported `phoenix-be-11-0-1-parity`
client slot. The replacement-aware case bundle manifest is
`bundle-manifest-v2.json`, SHA-256
`78ddde29da0aed1c2552488c0e06d2366f33d283c619049970c4c2c6d410288d`.
The retained four fixture cases share cases digest
`77b6481bc791f6987e2c6fdbe4bf8739d0b45477776fac2bfa812c98e74b99e1`;
the replacement Terrible fixture records cases digest
`eea6abdfac20c74d9473e46adb1634af6c20b778ee43eefa95dade97bd05e8e5`.
Each case has an immutable `fixture-captured.json` copy and reports
`verifiedUnchanged:true`; the exact per-case fixture hashes are listed below.
The fixture context is `America/New_York`, local date 2026-09-13, and calendar
date 2026-09-14. The retained four fixtures use work time 9:25 PM; the
replacement Terrible fixture uses work time 10:30 PM.

| case bundle | case id | fixture SHA-256 | target captures | observed target sequence |
| --- | --- | --- | ---: | --- |
| `commute-normal-combined` | `Normal` | `8297f25ac304eebb8730538517066bb2297965f4906bfb7ed9a6761409521ad5` | 2 | `trafficView` / `trafficNormal_v01.crn`; `departTimeView` at 9:15 PM |
| `commute-bad-combined` | `Bad` | `bad549f46d7c63265163b0cc8bd06fc49f80b38e4518483d8f882f13cd9fb8c5` | 2 | `trafficView` / `trafficBad_v01.crn`; `departTimeView` at 9:10 PM |
| `commute-terrible-combined-v2` | `Terrible` | `ddb4f9001da5c00fc9f57188b576e1a19aee9ee8cffb720828c3af5260bd9f44` | 2 | `trafficView` / `trafficTerrible_v01.crn`; `departTimeView` at 10:05 PM |
| `calendar-four-card-field-matrix` | `calendar-four-card-field-matrix` | `8433b115e8e4a79b9f1d954b79cca0d82c556777f38567fb2afaf098a2ae6597` | 4 | full-day empty-time card; truncated `:25` card; 2 PM card; 8:25 PM card |
| `calendar-concurrent-parallel` | `calendar-parallel` | `943276df5482579160e50a891d84a86f332a21b69fd0b572bedb5bee5fa4b4b2` | 2 | two distinct same-ID `eventView` occurrences at 11 AM |

Each turn records one allow-listed `whoIsThisMenu` action as an
`excluded-prelude`. It is explicitly excluded from the S-13 target sequence
and has no target screenshot. The hardened replacement Terrible prelude
records `captureKey: excluded-prelude:whoIsThisMenu#1` and
`viewGeneration: 2`, in addition to `captureStatus: excluded-prelude` and the
allow-list exclusion reason. The five `eyeView` prelude PNGs are likewise
outside the twelve target PNGs. The calendar four-card run preserves four
sequential `eventView` occurrences; the parallel run preserves two separate
same-ID occurrences rather than deduplicating by view ID.

The per-case turn and wire records are retained as private-run identifiers:

| case bundle | `turn.json` SHA-256 | wire trace | wire SHA-256 |
| --- | --- | --- | --- |
| `commute-normal-combined` | `e327d1c63dcf0b7a51853b4252a61ea4534398a60ff9e5cf1004018e563012d7` | `wire-1789345988046.jsonl` | `1e98a5d10c1f25fc353a0ff013b5e140fe3e903701fdbaa9b649ad670557b6e2` |
| `commute-bad-combined` | `31943dde528dfd958120bafbe3fa72e79605ad4e58ff860230abc2d6cd1984a7` | `wire-1789346038063.jsonl` | `94b4500a2ae93fd1dd412ad4d725708cc080747bb00f103f9281004dd2406f98` |
| `commute-terrible-combined-v2` | `8f66d2b3a725b3109136c454b7796fb428a1d27bfcd51029049219e631a9d056` | `wire-1789347865719.jsonl` | `ce670e824b5d969ded1275b2f5549c07bc996b1c6d81c642626088b1b3be28c2` |
| `calendar-four-card-field-matrix` | `1054217e747c7d6a3157487ff515f9e1a84100a0893ca5fd6c35212223bfc77d` | `wire-1789346125766.jsonl` | `8db98f90d8cd6d5675e5334e052bb8cbf1c5c11f2f850886e892cb6eb1bf6024` |
| `calendar-concurrent-parallel` | `72292e04e6ad7a258fa415c43ad3384a3b891cb23a188b0c8113a3eac187f97d` | `wire-1789345914399.jsonl` | `6b5e4900feca40a04b42006440304082c42fa8e9c8a51a2daa875947d70305b9` |

## Visual review and idle restoration

The replacement-aware direct visual review metadata is `visual-review-v2.json`,
SHA-256
`1fcc4c68c96bc00f8ae2e70e89d918e53039d1368793da0d430ca2bcab19af8d`.
It records `targetCount:12`, `allPassed:true`, and reviewer
`root-agent-direct-visual-inspection` at 2026-09-14T01:06:23Z. The twelve
unique target PNGs all have a valid PNG signature and 1281x721 IHDR dimensions.
The contact sheet is `visual-review-contact-sheet.jpg`, SHA-256
`77f1e766c747fae9901a61094f8870cff7b98c14a220be620bd3f2732d62b09a`.

All five case turns required idle preflight and report
`preflight.idle:true` with `@be/idle`, `eyeView`, `Idle`, and
`talking:false`. Their final observed states likewise returned to
`@be/idle`, `eyeView`, `Idle`, with `talking:false`; every case has an empty
`captureErrors` list. Production was restored after the replacement run. The
subsequent private `post-v2-restore-observe.json` has SHA-256
`859ac4b5b8745d61b5da044220027fa33c537f603087d7bb254d6df2285041b8` and
reported `@be/idle`, `eyeView`, `Idle`, `talking:false`, with no events,
screenshots, or capture errors.

## Receipt review status and scope

The recapture directory contains five per-case stacks, immutable fixture
copies, native turn records, wire traces, screenshots, and visual-review
metadata. It does not contain a complete aggregate
`phoenix.parity.s13.physical-capture-receipt`, a passing `validate.mjs` result,
or a passing final falsifier result. The five-case evidence therefore remains
pending aggregate receipt assembly and review. S-13 must not be marked verified
until the final receipt validator and falsifier pass; the task ledger keeps its
verification array empty.

The five fixture-backed physical cases do not close the remaining matrix rows:
the missing-source `tree` row, linked no-view assertions, and weather/news
revalidation remain outside this recapture. The source asset exception remains
separate from the pending receipt review.

The recapture uses the private deterministic Phoenix Data fixture seam. It does
not certify live Google, Outlook, or Maps provider responses; Settings,
OAuth, account state, microphone recognition, hotword, blue-ring behavior, and
live weather/news/AP transport remain outside this evidence.

## Asset boundary

The archived BE 11.0.1 and BE 12.0.0 Nimbus trees have the same 150-file
asset manifest, `b541f1e3ac39aa634dd416d28a51e6a191b5de78b10abd95ce1a523979f8c272`.
Both lack:

```text
node_modules/@be/nimbus/assets/personal-report-skill/calendar/icons/tree_v01.crn
node_modules/@be/nimbus/assets/personal-report-skill/calendar/icons/tree_v01.png
```

The source `calendarIconWords.json` maps `tree|park|nature` to that identifier.
The physical matrix keeps this row blocked and unclaimed until a future Nimbus
bundle supplies both files. No synthetic asset is acceptable.

## Reproduction

The source portion is reproducible from a clean worktree with:

```bash
node scripts/parity-s13-source-diff/run.mjs --out .parity/runs/s13-report-views
node scripts/parity-s13-source-diff/falsify.mjs --run-dir .parity/runs/s13-report-views
node --test scripts/parity-s13-source-diff/test.mjs scripts/parity-s13-physical/test.mjs
npm run parity:check
```

The Moth portion is retained privately at the recapture path above. It uses
the original Jetstream SDK text-injection operation and is not reproduced by a
simulator or a local shortcut.
