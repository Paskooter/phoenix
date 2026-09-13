# S-13 physical capture toolkit

This directory defines the bounded physical display acceptance boundary for
Phoenix. `matrix.json` is the ordered, immutable contract. `validate.mjs` is a
pure validator: it reads the matrix, receipt, and referenced bytes, computes
SHA-256 values, and exits non-zero on any missing, stale, reordered, or
inconsistent field. It never starts a service, calls a provider, opens a
native socket, or talks to Moth.

The matrix is pinned to Phoenix base revision
`0902410c597f8dc424af60ee98fc4d32f19a1bb0` and the archived source revision
`5c0a7390539663ba749d360de348a428c088505c`. Its canonical matrix digest is
`ea64253c1ce045370d115c61b0075663abc2a8f8452b42e466646d4444ce93ea`; the
ordered case inventory digest is
`b2410705ee0b7b2f8096fd974a06fdf8b7e983d63c544394a96019ac11671d53`. Both
values are duplicated in the validator, so changing `matrix.json` and merely
rewriting its self-report does not redefine S-13.

The 17 matrix rows are ordered as follows:

1. `commute-normal-combined`, `commute-bad-combined`,
   `commute-terrible-combined`, and `commute-pm-departure-combined` exercise
   traffic and departure views in one report action. Traffic assets are the
   exact Normal/Bad/Terrible Nimbus paths; departure labels are resolved from
   the captured work time minus fixture traffic duration.
2. `calendar-four-card-field-matrix` is one ordered tomorrow turn containing
   full-day, a `:25` birthday summary that truncates, an on-hour fallback that
   renders `2 PM` with the base label positions, and a night dog card. The
   four cards prove `shift()` order and single-skill `leaveEmpty` behavior.
3. `calendar-concurrent-parallel` is a separate same-time two-card turn. Both
   cards intentionally have `eventView` as their ID; ordinal 0 and ordinal 1
   are distinct captures, and the action includes `CalendarParallelEvent`.
4. `calendar-tree-park-nature` is explicitly blocked for the missing
   `tree_v01.crn` and PNG source assets. The matrix cannot be closed while
   this row is claimed.
5. Five S-11 no-view assertions and three S-12 no-view assertions bind the
   reviewed source receipts by path and digest and require an empty view and
   screenshot list.
6. `weather-revalidation` and `news-revalidation` are current-run
   revalidation slots anchored to the prior public S-13 receipts. The old
   screenshots are references, not a substitute for a new run. Their MIM
   sequence is capture-derived because the old public receipts did not retain
   MIM IDs; the new action payload must record the non-empty sequence and bind
   it to the selected operation.

## Receipt contract

A physical or revalidation row must record all of the following:

- `provenance.phoenix`, `provenance.be`, `provenance.client`,
  `provenance.nimbus`, and `provenance.native`, including versions, loaded
  paths, source/package/binary/config hashes, Phoenix revision, and the
  audited Nimbus asset-manifest hash.
- `preflight`, which identifies the proven original SDK operation, endpoint,
  transport mode, body field, explicit runtime context source, and the
  runtime location/timezone context hash. The matrix allow-lists both
  `mimicGlobalTurn` and `startLocalTurn`; a receipt must select one after
  preflight and use that operation consistently. The validator does not infer
  that a simulator-specific shortcut is equivalent to a native local turn.
- `actual.request`, including operation, endpoint, transport mode, exact
  phrase/body, body hash, microphone-acceptance state, and the resolved
  capture-local commute/calendar inputs. Commute schedules are generated from
  the current local clock (`capture-plus-60-minutes` or the next local 17:05)
  and calendar fixtures use the next local calendar date, so the matrix does
  not depend on the frozen June examples in the source graph.
- `actual.action`, including raw and canonical payload hashes plus Phoenix,
  native, and wire payloads. Each payload carries the exact MIM sequence,
  ordered view IDs, and full view contracts. Native/Phoenix and
  wire/native equality flags are required and are checked against the matrix.
- `actual.artifacts.stackReceipt`, `nativeReport`, `wireTrace`,
  `providerTrace`, and `actionPayload`, each as a relative path whose bytes
  match its recorded digest. `actual.logs` and `actual.correlation` bind
  native action/idle events, wire action/ack messages, connection ID,
  request ID/transID, and trace range.
- `actual.screenshots`, in action order, with ordinal, view ID, stable duration,
  visual-review flag, path, byte count, and SHA-256. The identity is
  `(case ordinal, view ordinal, view ID)`. A same-ID pair must have two files;
  deduplicating `eventView` by ID is a receipt failure.
- `actual.timeline`, with every view open/close pair, `@be/idle`/`eyeView`/
  `Idle` observation, `ttsTalking:false`, restored observers, and every view
  closed before final idle. `noBypass:true` is required for physical rows.

No-view rows are assertions over the linked S-11/S-12 receipt. They contain no
physical screenshot or action artifact and cannot be converted to a pass by
adding a synthetic empty view. The tree row must remain `status:"blocked"`,
`claimed:false`, and `blockedReason:"missing-source-asset:tree"`.

A receipt with a blocked row must use `decision:"blocked"`,
`taskStatus:"open"`, and `complete:false`. If the blocked row is resolved in a
future Nimbus bundle, the matrix and validator must be changed in a reviewed
commit; a receipt cannot override this decision.

## Commands

Validate a real receipt from a private capture directory:

```bash
node scripts/parity-s13-physical/validate.mjs \
  --root /private/s13-capture \
  --out /private/s13-capture/validation.json \
  /private/s13-capture/receipt.json
```

Run focused validator tests and the isolated mutation suite:

```bash
node --test scripts/parity-s13-physical/test.mjs
S13_FALSIFICATION_OUT=/private/s13-falsification.json \
  node scripts/parity-s13-physical/falsify.mjs
```

The falsifier mutates temporary copies only. It covers matrix omission and
reorder, attempted matrix rehash, stale Phoenix revision, omitted package
version, preflight substitution, request/action/view mutations, correlation
and wire hash mismatch, same-ID screenshot reorder, idle omission, no-view
screenshot injection, tree-asset claim, and falsification-control omission.

## Reusable capture pieces and minimal adapter

Existing code already supplies the runtime pieces. Use
[`scripts/parity-robot/turn.py`](../parity-robot/turn.py) for the original
Jetstream SDK `mimicGlobalTurn`/`startLocalTurn` probes and native event
observation; use [`scripts/parity-robot/stack.mjs`](../parity-robot/stack.mjs)
for the isolated Phoenix stack and wire JSONL; use
[`scripts/parity-s11-http-graph/maps-fixtures.cjs`](../parity-s11-http-graph/maps-fixtures.cjs)
and the calendar fixture seam in
[`packages/data/src/index.js`](../../packages/data/src/index.js) for provider
inputs; and use the exact source-backed view builders in
[`packages/skills/src/report/commuteViews.js`](../../packages/skills/src/report/commuteViews.js)
and [`packages/skills/src/report/calendarViews.js`](../../packages/skills/src/report/calendarViews.js).
The S-11 and S-12 matrices/reviews named in `matrix.json` remain the semantic
oracles for action order and no-view behavior.

The smallest new runtime adapter is a receipt writer around those pieces. It
should run the operation preflight, generate the relative-date fixtures,
execute the 17 rows in matrix order, retain a focused action JSON beside the
raw native/wire/stack reports, and name screenshots with the case and view
ordinals. It must capture every `eventView` occurrence instead of using the
current `turn.py` view-ID set as the screenshot key. Hashing, order checks,
version/provenance checks, idle closure, and all falsification controls belong
in this validator; no product code or simulator shortcut is needed.
