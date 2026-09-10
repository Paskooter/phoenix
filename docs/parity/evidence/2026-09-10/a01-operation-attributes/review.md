# A-01 verification — operation map and per-operation attributes

**Date:** 2026-09-10
**Phoenix revision:** wave-5 integration (`root/integrate-wave5-20260910`)
**Result:** pass — all four acceptance criteria closed

## What was already accepted before this session

The candidate map (`docs/parity/candidates/A-01-operation-map.json`, 169 rows)
already carried, for every wire operation: the Phoenix handler, the pinned
source controller, the consumer, the owning parity task, and a defined
verification scenario. `scripts/parity-coverage/a01_operation_map.py validate`
passed. Criterion 1 (assignment), criterion 3 (services with no client API
file) and criterion 4 (`Settings_20160801.GetSettings` recovery) were satisfied.

Criterion 4 deserves a specific note: `Settings_20160801.GetSettings` has **no**
surviving API model. It was recovered from consumer call sites, and the row
records the exact headers, request body and line references, with the missing
model stated as an explicit unknown. It remains **independently mapped** from
`Settings_20171219`, as the criterion requires — the two settings surfaces are
not merged.

## The gap this work closed

Criterion 2 requires auth/ownership, schema, errors, persistence and observable
side effects **per operation**. Only 57 of 169 rows carried an `attributes`
block (`Account_20151111` 28, `Loop_20160324` 23, `OOBE_20161026` 5,
`Settings_20160801` 1). **112 rows across 24 target prefixes had none.**

Three workers filled those 112 rows from pinned source, in disjoint slices:

| slice | operations | prefixes |
|---|---:|---|
| messaging | 39 | Jot ×2, Person, Media |
| device | 37 | Key, Robot, Update, ROM, Backup, Push, Notification, Collision, Lps |
| integrations | 36 | IFTTT, Log, OauthClients, Settings 20171219, GQA, NLP, VoiceTraining ×3 |

Each slice touched only its own rows — the merge took 112 rows with **zero**
conflicting edits.

## Root's independent check

Candidate self-reports were not the basis of acceptance.
`scripts/parity-coverage/a01_verify_attributes.py` re-derives criterion 2 from
the merged map alone and is written to fail loudly:

- every required attribute key present and **non-placeholder** (a row that looks
  complete but says nothing is the failure mode that matters)
- `authenticationMode` addresses **both** auth layers
- every cited revision is a full 40-char sha
- `runtimeStatus` honest — nothing claims to have been run
- `unknowns` entries are non-empty strings

`--falsify` corrupts the map six ways and asserts each is detected. All six are
caught. An earlier version of the revision case corrupted `inventoryEvidence`
rather than `attributes` and silently proved nothing; that is fixed, and the
comparator is only trusted because the falsification passes.

**Result: 169/169 rows, 0 problems.**

## The two-layer auth correction

Account auth is decided in **two** repositories, and this verification exposed
that the original 57 rows only recorded one of them.

1. **Gateway** — `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`
   `src/controllers/auth.ctrl.ts` holds `unauthorizedMethods` (20 targets
   callable with no Authorization header), `unsignedMethods` (empty at this pin)
   and `unactiveMethods` (`Account_20151111.Remove` only).
2. **Handler** — the `@parseCredentials({})` decorator, which governs what the
   handler *reads*, not who may *call* it.

A handler decorator does **not** override the gateway allow-list. All 57
pre-existing rows were backfilled with the gateway layer, verbatim from source;
the 112 wave-5 rows already carried it because the brief demanded it.

This independently confirms a correction made earlier in the session: root had
briefly "fixed" `Account_20151111.GetAccountByAccessToken` to require
credentials on the strength of its `@parseCredentials({})` decorator, and was
wrong — the target is in `unauthorizedMethods`, so it is reachable unsigned.
The gateway list extracted here contains it, and that fix was reverted.

Twelve targets are gateway-anonymous: 9 Account, 1 Loop
(`UpdateAgreementStatus`), 2 OOBE (`GetStatus`, `SetupRobot`).

## Honest scope

- The map is a **static** deliverable. All 169 verification scenarios remain
  `runtimeStatus: "not-run"` — criterion 1 requires a scenario be *assigned*,
  not executed, and nothing here claims otherwise. Executing them is the work of
  the per-service tasks.
- Rows for archive-only services (Jot, Person, several VoiceTraining prefixes)
  rest on server-side source and consumer call sites, with the absence of a
  formal API model recorded per row.
- `denominator.prefixAmbiguity` (the `Jot_20160126` vs literal `Jot_20160512`
  conflict) is **not** resolved here. Workers were explicitly told not to decide
  it; rows map the declared prefix and record the conflict as an unknown.
- The VoiceTraining historical/current name mismatch is likewise recorded, not
  reconciled.
- Phoenix-side `phoenixHandler.present` reflects what is registered today;
  `false` entries (e.g. VoiceTraining) are honest gaps, not defects.

## Reproduce

```bash
python3 scripts/parity-coverage/a01_operation_map.py validate
python3 scripts/parity-coverage/a01_verify_attributes.py
python3 scripts/parity-coverage/a01_verify_attributes.py --falsify
```

Suite at verification: **995 tests, 988 pass, 0 fail, 0 cancelled, 7 skipped**,
parity gate `{"result":"match","cases":43,"differences":0}`.
