# S-13 physical capture toolkit

This directory defines the bounded physical display acceptance boundary for
Phoenix. [`matrix.json`](./matrix.json) is the ordered immutable contract;
[`validate.mjs`](./validate.mjs) is a pure fail-closed validator; and
[`assemble.mjs`](./assemble.mjs) orders a capture manifest into one receipt
without letting a producer omit or reorder matrix rows. The toolkit reads
bytes only. It does not start Phoenix, invoke a provider, open a native
socket, talk to Moth, deploy, or push.

Reviewers can use the step-by-step [review checklist](./review-checklist.md)
after running the validator and falsifier.

The matrix is pinned to Phoenix base revision
`0902410c597f8dc424af60ee98fc4d32f19a1bb0` and archived source revision
`5c0a7390539663ba749d360de348a428c088505c`. Its canonical matrix digest is
`abfaa887de44b6d17712ce11d825ea4565d9e8750a9b57d51d5eeeb64e1a072d`; its
ordered case inventory digest is
`b2410705ee0b7b2f8096fd974a06fdf8b7e983d63c544394a96019ac11671d53`.
The validator duplicates both pins, so rewriting `matrix.json` integrity
fields cannot redefine the acceptance contract.

The 17 rows are ordered as follows:

1. `commute-normal-combined`, `commute-bad-combined`, and
   `commute-terrible-combined` capture traffic and departure views in one
   action. `commute-pm-departure-combined` is conditional because the S-11
   61-row source lane owns AM/PM coverage; it is captured only when a separate
   PM fixture can run without a static clock injection, otherwise it is
   explicitly `skipped`.
2. `calendar-four-card-field-matrix` is one ordered tomorrow turn containing
   full-day, a `:25` birthday summary that truncates, the on-hour fallback
   rendered as `2`/`PM` at the base x positions, and a night dog card. The
   sequence proves `shift()` order and the single-skill `leaveEmpty` behavior.
3. `calendar-concurrent-parallel` is a separate same-time two-card turn. Both
   cards intentionally use `eventView`; their ordinals remain distinct and the
   action includes `CalendarParallelEvent`.
4. `calendar-tree-park-nature` stays unclaimed and blocked for the missing
   `tree_v01.crn` and PNG source assets.
5. Five S-11 and three S-12 no-view assertions open staged copies of their
   linked source JSON, verify their raw digest, parse the source row, and
   require no view/screenshot claim.
6. `weather-revalidation` and `news-revalidation` may reference the prior
   accepted public hardware receipts by exact bytes. A new capture can use
   the same matrix slots with full artifacts, but an old receipt is not
   silently relabeled as a current-date capture.

The runtime clock is resolved when the receipt is produced. Commute work
times use the captured local clock plus 60 minutes, with the conditional PM
policy resolving the next local 17:05. Calendar events use the next local
civil date in `America/New_York`, including DST boundaries. No hard-coded June
date is allowed to masquerade as a current physical capture.

## Receipt contract

Every physical/revalidation row binds:

- Phoenix revision plus BE, client, Nimbus, native firmware/SSM provenance,
  package and binary hashes, loaded paths, and the audited Nimbus asset
  manifest;
- the preflight-selected original SDK operation, endpoint, transport mode,
  body field, explicit runtime context source, and context hash;
- exact phrase/body, request hash, microphone-acceptance state, resolved
  commute preferences, tomorrow calendar date, provider fixture projection,
  and the SHA-256 of a private fixture artifact;
- Phoenix, native, and wire action payloads with recomputed raw/canonical
  hashes, ordered MIM IDs, ordered view IDs/contracts, and equality checks;
- stack receipt JSON, native report JSON, wire/provider JSONL, action JSON,
  private provider fixture JSON, request/trans/case/operation identity, action
  payload, provider calls, timestamps, a standalone context/timezone anchor,
  and final idle records;
- ordered screenshots keyed by `(case ordinal, view ordinal, view ID)`, with
  stable duration, visual-review flag, byte count, SHA-256, real PNG signature,
  complete chunk framing/length/CRC, valid IHDR dimensions, IDAT, and final
  IEND. Duplicate `eventView` IDs are separate files; `turn.py` retains their
  occurrence/capture keys and the receipt must preserve those identities;
- every view open/close interval, `@be/idle`/`eyeView`/`Idle`,
  `ttsTalking:false`, restored observers, and a final transition to idle.

The validator uses `lstat` and `realpath` for the root, every path component,
and every artifact. Absolute paths, lexical escapes, final symlinks, and
symlinked ancestors are rejected. It opens and hashes every linked no-view
receipt, then parses S-11 graph rows or S-12 differential rows. Receipt
booleans and hashes cannot replace these byte-level and semantic checks.
`runtime.captureISO` must lie inside the earliest/latest timestamp range
recomputed from the stack/native/wire/provider artifacts; final native, wire,
and stack idle records must agree with the timeline. The context anchor must
bind a source wire trace line, source message ID, runtime location timestamp,
timezone, case, operation, and correlation IDs; a receipt-only preflight field
cannot replace it.

A source-asset block limits the claim for that row but does not invalidate
otherwise complete evidence. The expected terminal state is
`decision:"verified_bounded"`, `taskStatus:"closed"`, `complete:true`, with
`limitations` naming `calendar-tree-park-nature` and `claimed:false`. The
matrix/validator must be reviewed again when the tree assets exist.

The fixture boundary is explicit: provider responses and already-converted
commute preferences are injected inputs for this S-13 physical receipt. S-11
owns Settings/OAuth/maps preference completeness and S-12 owns calendar
provider authorization/source differential proof. This toolkit does not claim
either setup path.

## Commands

Validate a real receipt from a private capture directory:

```bash
node scripts/parity-s13-physical/validate.mjs \
  --root /private/s13-capture \
  --out /private/s13-capture/validation.json \
  /private/s13-capture/receipt.json
```

The raw-run producer consumes a private `stack.json`, fixture JSON, wire JSONL,
turn reports, optional per-case context-anchor JSON, and screenshot bytes. It
copies and hashes those inputs into a candidate receipt; it does not invent
missing ACKs, provenance, context anchors, or views. The candidate is expected
to fail closed when the run is incomplete or mismatches the matrix:

```bash
node scripts/parity-s13-physical/produce.mjs \
  --run /private/s13-final-run \
  --out /private/s13-capture-candidate
node scripts/parity-s13-physical/validate.mjs \
  --root /private/s13-capture-candidate \
  --out /private/s13-capture-candidate/validation.json \
  /private/s13-capture-candidate/receipt.json
```

For a capture split into immutable per-case bundles, pass a root manifest. The
manifest must use the matrix IDs as keys and may point each key at a separate
directory. Each entry supplies `stack`, `fixture`, `wire`, `turn`, and, for a
verified context, `context` relative to that directory:

```json
{
  "schema": "phoenix-s13-bundle-manifest-v1",
  "cases": {
    "commute-normal-combined": {
      "dir": "normal",
      "stack": "stack.json",
      "fixture": "fixture.json",
      "wire": "wire.jsonl",
      "turn": "turn.json",
      "context": "context.json"
    }
  }
}
```

Run the adapter with `--bundle-manifest /private/bundles.json`. The manifest
bytes and every referenced stack/fixture/wire/turn/context file are copied
into the private candidate and checked against the resulting receipt. A
manifest with missing case entries leaves those rows uncaptured and the
candidate rejected.

For a complete run, the capture adapter should write a manifest with one row
per matrix ID, then assemble it in matrix order:

```bash
node scripts/parity-s13-physical/assemble.mjs \
  --out /private/s13-capture/receipt.json \
  /private/s13-capture/capture-manifest.json
```

Run the focused tests and isolated falsifier:

```bash
node --test scripts/parity-s13-physical/test.mjs
S13_FALSIFICATION_OUT=/private/s13-falsification.json \
  node scripts/parity-s13-physical/falsify.mjs
```

The falsifier mutates temporary artifact bytes and trace contents, rehashes
where an attacker could, changes PNG signatures/chunks, swaps screenshot
identities, substitutes final and ancestor symlinks, tampers with linked
receipts and provenance anchors, removes native/wire requests, changes ACKs
and timeline order, moves capture time outside trace range, and verifies that
all mutations are rejected.

## Reusable capture pieces

Use [`scripts/parity-robot/turn.py`](../parity-robot/turn.py) for original
Jetstream SDK `mimicGlobalTurn`/`startLocalTurn` probes and native observation;
[`scripts/parity-robot/stack.mjs`](../parity-robot/stack.mjs) for the isolated
Phoenix stack and wire JSONL; the S-11 maps fixtures and calendar fixture seam
in [`packages/data/src/index.js`](../../packages/data/src/index.js) for
provider inputs; and the source-backed view builders in
[`packages/skills/src/report/commuteViews.js`](../../packages/skills/src/report/commuteViews.js)
and [`packages/skills/src/report/calendarViews.js`](../../packages/skills/src/report/calendarViews.js).

The smallest runtime adapter around these pieces runs operation preflight,
generates current relative fixtures, executes rows in matrix order, records
the structured artifacts beside raw reports, and names screenshots with case
and view ordinals. The validator and falsifier then supply the reviewable
receipt evidence without product changes.
