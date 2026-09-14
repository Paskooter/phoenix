# S-13 physical receipt review checklist

Use this checklist with a receipt produced from the committed matrix. Record
the validator and falsifier exit status beside the final receipt; a reviewer
should be able to reproduce each assertion from the referenced bytes.

## Before capture

- [ ] The receipt binds Phoenix revision `0902410c597f8dc424af60ee98fc4d32f19a1bb0`, BE/client/Nimbus/native versions, loaded paths, package/binary/config hashes, and the audited Nimbus asset manifest.
- [ ] Operation preflight records the actually proven original SDK operation and endpoint. `mimicGlobalTurn` and `startLocalTurn` are alternatives; the receipt does not silently substitute one for the other.
- [ ] Runtime timezone is `America/New_York`; `captureISO` and local date are generated for this run. Commute preferences are resolved from the captured local clock; calendar provider dates are local date plus one civil day.
- [ ] Each physical case has a standalone context-anchor artifact that names the source wire line/message, runtime location ISO, timezone, case, operation, and request/trans IDs. A preflight field alone is insufficient.
- [ ] The fixture boundary is acknowledged: already-converted preferences and provider injection are S-13 inputs. S-11 covers Settings/OAuth/maps preference proof; S-12 covers calendar provider authorization/source differential proof.

## Ordered cases

- [ ] Normal, Bad, and Terrible commute cases each contain traffic and departure views in the same action, with departure labels computed from resolved work time minus fixture traffic.
- [ ] The PM departure row is either physically captured under `pmDepartureAvailable:true` with a current relative fixture or marked `skipped` with its exact conditional reason. No static 17:05 clock value is accepted as a current run.
- [ ] The four-card calendar turn is one ordered action: full-day card, `:25` truncated birthday, on-hour fallback with `2`/`PM` at the base x positions, then night dog. Check `leaveEmpty` values and both summary/icon assets.
- [ ] The separate concurrent calendar action contains both same-time cards and preserves two screenshot ordinals even though both IDs are `eventView`. The action includes the parallel MIM.
- [ ] The tree/park/nature row remains `blocked`, `claimed:false`, with `missing-source-asset:tree`; its missing asset is an explicit limitation rather than an invented screenshot.
- [ ] Every S-11/S-12 no-view row stages the exact digest-pinned source receipt, opens and parses its case, and contains zero view IDs and screenshots.
- [ ] Weather/news rows either contain a fresh current-date capture or retain an exact-byte reference to the prior accepted hardware receipt; a prior receipt is not presented as current runtime evidence.

## Byte and trace checks

- [ ] Every path is relative to the private capture root. `lstat`/`realpath` shows no final or ancestor symlink and no escape. Hashes and byte counts match opened bytes.
- [ ] If per-case bundles are used, the root `phoenix-s13-bundle-manifest-v1` bytes and each case's stack/fixture/wire/turn/context mapping are copied and hash-bound.
- [ ] Stack receipt JSON, native report JSON, wire JSONL, provider JSONL, action JSON, and private provider fixture JSON all parse. Every record binds request ID, trans ID, case ID, operation, and an ISO timestamp.
- [ ] Native and wire action payloads equal the receipt payloads; provider calls equal the private fixture projection; the private fixture SHA is the SHA of the opened fixture bytes.
- [ ] The earliest/latest trace timestamps define the declared trace range and contain `runtime.captureISO`. Native, wire, provider, and stack traces end in the same idle observation; every view closes before it.
- [ ] Screenshots are ordered by case/view ordinal and view ID, remain stable for at least 500 ms, carry unique producer identities, and pass complete PNG chunk framing/length/CRC, IHDR dimension, IDAT, byte-size, and final IEND checks.

## Falsification and disposition

- [ ] `node scripts/parity-s13-physical/falsify.mjs` rejects matrix/receipt omission and reorder, stale provenance, request/action/view/correlation edits, trace and fixture edits, timestamp edits, PNG chunk/signature edits, screenshot identity swaps, symlink substitutions, no-view injection/tampering, idle omission, blocked-row claims, ACK/request removal, and control omission.
- [ ] The terminal receipt is `verified_bounded`, `closed`, and `complete:true` only after all non-blocked rows pass or a declared conditional row is skipped. `limitations` names the blocked tree row and keeps it unclaimed.
- [ ] The reviewer records any missing upstream tree asset and does not reinterpret a fixture-bound receipt as Settings/OAuth or provider authorization proof.

The prior evidence formats audited by this contract are the S-11 graph matrix
(`scripts/parity-s11-http-graph/commute-graph-matrix.json`), S-11 review
(`docs/parity/evidence/2026-09-13/s11-commute/review.md`), S-12 matrix and
differential receipt (`scripts/parity-s12/matrix.json` and
`docs/parity/evidence/2026-09-13/s12-calendar/differential-receipt.json`), and
the public weather/news receipts under `docs/parity/evidence/2026-09-05/hardware/`.
