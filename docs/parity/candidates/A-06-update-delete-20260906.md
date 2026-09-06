# A-06 Update/Delete Settings candidate (2026-09-06)

Status: **candidate, unverified pending root review**.

This slice adds the source `UpdateSettings` and `DeleteSettings` behavior to the
standalone internal Settings listener. The robot-facing Account AWS-JSON compatibility
route keeps its existing envelope/store adapter; the internal listener now performs the
source membership check, fetches Hub manifests, validates data nodes, calls Person or
Lasso, and projects the source `{data: ...}` result/error shapes. Local Person account
and loop properties plus Lasso credential markers are persisted through the existing
store; configured peer providers use the source-shaped Person AWS targets and the Data
credential CRUD routes.

## Source and runtime evidence

- Settings source: `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`.
- Frozen source tree and hashes: `.parity/reviews/a06-root/fresh-source` and
  `.parity/reviews/a06-root/source-proof.json`.
- Compiled source/runtime used by the controls: `.parity/reviews/a06-root/compiled`
  and `.parity/reviews/a06-original-runtime/dist-runtime`.
- Original dependency pin: `@jibo/server@4.0.12`, Hapi `16.4.1`, Joi `10.5.2`,
  Boom `5.1.0`, TypeScript `2.5.3`, Node `v8.9.4` image
  `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
- Candidate worktree: `/home/shell/work/phoenix/.parity/worktrees/a06-update-delete-candidate`.
- Candidate base: `aaa3a064c221f9b0ca6156ecdc91af1c63dbde87`.

The source-derived cases and receipts are private under
`.parity/reviews/a06-update-delete-aaa3a06/`; the existing 78-case transport inputs and
captures were left unchanged. The source harness uses the pinned transpiled handler,
controllers, decorators and provider seams. A second actual `@jibo/server` TCP attempt
was prepared, but the shared Docker daemon was unavailable during that attempt; the cause was not
established; the source body/status/provider assertions below therefore come from the
pinned Node 8 handler harness, while HTTP framing remains covered by the preserved 78
case TCP capture and candidate replay.

## Differential controls

`cases.json` contains 25 source-observable Update/Delete cases covering:

- partial Person and loop updates, switch coercion, Lasso credential updates, and a
  connectable OAuth parent;
- unknown manifest keys, unknown data services, invalid values, membership failure,
  and Person/Lasso provider failures;
- specific Lasso deletion, explicit request OAuth parameters, wildcard matches and
  misses, unsupported targets, malformed wildcards, and delete failures;
- required `data`/`loopId`, top-level object, and null credential validation ordering; and
- local persistence of Person, loop, and Lasso state.

Fresh source/candidate results were compared without body normalization:

```json
{
  "cases": 25,
  "statusEqual": 25,
  "bodyEqual": 25,
  "providerCallsEqual": 25,
  "providerStateEqual": 25
}
```

Receipts:

- cases SHA-256: `681d145e939dd3f068ef9227e9f20a514b534e0514b14884a3cf982283050ddd`;
- pinned source output SHA-256: `3ec1d0b2110372572051d059398e1b01cc4a25aa7284b1955ae9f83baacd41e9`;
- candidate output SHA-256: `81b482068b6e6c0f8f6b05e812ecc7e3bfc1a4ef4444c20bb3a413e59fa74f0e`;
- differential receipt: `comparison-after-mutation.json`.

The unchanged 78-case internal TCP replay against this candidate matched the preserved
original after excluding only generated `Date`:

```json
{
  "total": 78,
  "candidateRows": 78,
  "matchesAfterDateOnly": 78,
  "differenceRows": 0,
  "differenceCounts": {},
  "providerCallMatches": 78
}
```

The replay receipt is `candidate-internal-tcp.json` with comparison
`comparison.json`; its candidate capture SHA-256 is
`fcbf25f510c9043ffe381530b6589a751d02198fca7af10c56c701a8c9ff91d5`.

## Validation

- Account tests: `66/66` passed (`node --test packages/account/test/*.test.js`).
- Common tests: `21/21` passed (`node --test packages/common/test/*.test.js`).
- Focused Update/Delete tests: `6/6` passed.
- `git diff --check` passed.
- The new worktree's `@phoenix/*` links resolve to its own `packages/*` tree.

Remaining scope includes live peer deployment and Mongo-backed Person/Lasso behavior,
source-client end-to-end integration, public SigV4 gateway acceptance, and full A-06
acceptance. Root owns integration and final verification; this candidate is not parity
verified.
