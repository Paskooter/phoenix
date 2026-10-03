# Current status reconciliation — 2026-10-03

This review aligns current summaries with accepted evidence and the checkout
starting at `bf2733f28e8e6e130ec07a3b1f590b9279616fa9`. It does not rerun the
historical hardware trials. Owner-reported OTA testing has its
[separate acceptance record](../ota-owner-certification/README.md).

The task ledger had retained initial missing/stub/in-memory findings after
verification. Fifty-five findings were rewritten from their accepted records,
keeping concrete provider and hardware qualifications. Historical candidate
scopes are labeled separately from final acceptance.

Later fixes also supersede these specific earlier limitations:

| Earlier claim | Current evidence |
|---|---|
| Missing pinned HubErrorCode values (C02a) | `packages/contracts/src/constants.js` contains all nine pinned values. H-02 accepts repaired PARSER error frames; additional Phoenix-only codes are explicitly identified in source. |
| Clock time factory, conditional actions and factory namespace block N-03 | [N-03 acceptance](../../2026-09-13/n03-time-factory/review.md), the final N-03 ledger receipt, current rule inventory and `timeFactory.test.js` cover the recovered time action and all 20 public local rules. Other unsupported factories retain their own inventory boundaries. |
| ORS supplies no traffic, so poor/terrible commute is unreachable | `packages/data/src/maps.js` now uses TomTom with `computeTravelTimeFor=all`; [D07b](../../../../DIVERGENCES.md#d07b--no-traffic-model-closed-2026-09-15-openrouteservice-replaced-by-tomtom) records the measured traffic result. Real transit and omitted route fields remain gaps. |
| N-06, N-07, S-01, D-04 and A-19 are still only candidates | Their final accepted ledger entries and later closed divergence records supersede the earlier candidate snapshots. Physical session cutover and the specific accepted implementation differences remain visible. |
| A-19 evidence exists only in ignored local files | The original passing receipt is preserved as [a sanitized tracked artifact](../../2026-09-16/a19-jot-sdk/README.md), with its original hash and omitted token/payload fields documented. |

Current inventory: [VERIFICATION-GAPS.md](../../../VERIFICATION-GAPS.md).
Validate generated acceptance with `npm run parity:check`; reproduce the
existing focused time/schema checks with
`node --test packages/nlu/test/timeFactory.test.js packages/contracts/test/contracts.test.js packages/contracts/test/wire-messages.test.js`.
Those commands inspect/test source behavior, rather than certifying a new
physical robot trial.
