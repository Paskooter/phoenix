# Q-01 bounded GQA verification

Status: **verified with `implementation: partial` at the source-shaped and replaceable-provider boundary**

Phoenix revision reviewed: `1fd3c70ae0960e90f09b782ac2f3acf12ba0f7bf`

Primary reference: `jiborobot/srv-gqa-ws@ebe1a7d38f511570060c1fbf61bec89d58419b26`

Security reference: `srv-security-gw@43a692f`

The archived GQA source, fixtures, and moved integration cases were acquired through the Jibo MCP Gitea tools. No web source was used. The machine-readable coverage receipt is `docs/parity/candidates/Q-01-archived-unit-coverage-20260913.json`; its reviewable companion is `docs/parity/candidates/Q-01-archived-unit-coverage-20260913.md`.

## Accepted service path

Classic now composes the ordinary Q-01 path by default. `packages/classic/src/index.js` creates a source-shaped `/structQA` handler, resolves the caller through the Account peer, and uses the durable file attribution store. `packages/classic/src/gqa.js` registers `GQA_20160930.Question` and `ListAttribution`. The CLI, Docker stack, native compose launcher, and authenticated stack provide a private attribution path without selecting a live-provider profile.

The Account peer verifies an explicit access key at `/api/verify`, calls `POST /listAssociatedLoops`, and selects the first accepted loop. The source Joi boundaries are retained, including missing/non-array `accountsIds`, primitive bodies, and malformed transport JSON. Direct Classic credentials preserve both `id` and `accessKeyId`; StructQA forwards the full credential context.

The file store uses private parent/file modes, strict version-1 snapshots, atomic temporary-file rename, rollback on failed persistence, corruption rejection, and restart recovery. This is a single-writer store. Concurrent processes sharing one file may lose records, and the store does not fsync the file and directory. Supported launchers use one Classic writer.

Standalone StructQA exposes the source auxiliary `/healthcheck` response `42` and developer `/fakeAccount` behavior, including malformed JSON returning literal `ERROR` with status 200. Those routes are scoped to the standalone GQA service and do not alter the common service health body or become Classic operations.

The deployed answer-skill multi-provider profile remains explicit and opt-in through `PHOENIX_GQA_DEFAULT_PROFILE=multi-provider` plus configured provider endpoints. The authenticated launcher clears that selection. With no provider profile, Classic returns the source-shaped no-answer behavior.

## Archived inventory and executable evidence

The archived inventory contains 136 named unit tests and 385 assertion calls. Every named row is classified:

- 103 covered
- 29 partial
- 0 missing
- 1 source-skipped
- 2 supporting helpers
- 1 excluded debug-only `/crash_me` route

The local evidence includes 11 GQA MIM files with all 77 prompt and metadata rows, 28 answer rows, 12 exact async scheduling rows, three fake-provider routes, 10 source-shaped news/AP cases, two auxiliary routes, Account resolution, attribution insert/retrieve/wipe, durable restart and rollback, provider request/decoder seams, error envelopes, profile selection, `/structQA`, and Classic operation dispatch.

The async replay preserves the archived 0/500/3100/4100 ms delays and 3000/4000 ms deadlines at a uniform 1:100 wall-clock scale. The scale changes elapsed time while retaining every relative deadline decision. The source `test_timeout_all` duration assertion subtracts the return time from the receive time and is therefore not evidence for an upper wall-clock bound; the local row verifies the resulting provider decision instead.

Three consecutive runs of every `packages/**/test/q01*.test.js` file passed 191/191. `npm run parity:q01:fixtures` passed with 12/12 async decisions and all omission, value-corruption, and provider-byte falsifiers rejecting mutations.

## Root falsification

Root temporarily removed `accessKeyId` from the credentials derived by the direct Classic GQA path. The named `Classic defaults compose the source-shaped GQA route with Account lookup and durable attribution` test failed because Account resolution received no usable robot access key. Restoring the full `{ id, accessKeyId }` projection made the same test pass. Earlier review also falsified case-sensitive Classic operation dispatch and the exact unknown-intent envelope, then restored both.

## Qualifications

Twenty-eight partial rows depend on live or unstable Bing, Wikipedia, Wolfram, API-AI, or AP provider output. Phoenix executes their source-shaped request, decoding, fallback, filtering, and injection seams, but this verification makes no claim about live credentials, current answers, freshness, licensing, or provider availability.

`test_against_dictionary` is partial because the complete archived `word-list/words.txt` input corpus is not available through the MCP read surface. All 344 expected output words recovered from the archive are pinned and replayed.

`tests/unit/test_pegasus.py:test_invalid_service` calls the bound `make_async_call` method with one list argument and therefore succeeds on Python's missing-argument `TypeError` before provider dispatch. The Phoenix archive row now asserts an exact `TypeError` at invalid provider-plan construction and proves that no adapter runs. This covers the only behavior the malformed source test observes without inventing a live invalid-service result.

The 340 complete input-only integration rows and the available 2,073-row prefix of `beta3-4902.txt` have no response goldens and are not counted as output parity. The archive reports the latter file as 177,307 bytes, while the MCP response ends mid-line after 69,069 code units; no complete row count is inferred from its filename.

Q-01 verifies GQA service behavior behind the source security-gateway contract. The pinned security gateway authenticates the AWS request before routing `Question` to `/structQA` and `ListAttribution` to `/retrieveAtt`; the GQA service consumes injected `x-amz-credentials` and does not verify SigV4. Phoenix's direct combined Classic GQA face preserves this LAN-trusted downstream posture. Q-01 does not claim that direct Classic exposure is a public authenticator. SigV4 verification and public exposure control remain owned by A-02/H-frontdoor.

The compose services publish host ports, so this record makes no public-exposure claim. It also makes no deployment, Android, robot, or Moth claim.

## Commands and results

```text
find packages -path '*/test/q01*.test.js' -print0 | sort -z | xargs -0 node --test
# 191/191 passed, repeated three consecutive times

npm run parity:q01:fixtures
# pass: 136 named archived tests inventoried, 385 assertions, 12/12 async rows

node --test --test-concurrency=4
# 2,101 tests: 2,092 passed, 0 failed, 9 skipped

npm run parity:check && npm run parity:gate
# parity checklist: 67/79 verified
# strict production gate: 43/43 match, 0 differences, 0 invariants, 0 coverage gaps
```

An initial uncaptured full invocation reported one failure among 2,100 tests, but the multiplexed tool output omitted the failing test. An immediate captured `test:unit` rerun passed 2,091/2,100 with nine skips, and a complete `npm test` repeated that result before the final invalid-service row was added. The first default-concurrency run after adding that row stalled after test 1,105 with only the unrelated `proactiveSettings` and `referenceEnv` workers left alive; those files passed 23/23 in isolation. The final bounded-concurrency run passed all 2,101 tests, including 2,092 passes and nine skips. No Q-01-focused run failed. The initial failure and later worker stall remain recorded here as suite-level concurrency instability rather than silently discarded.

The coverage map is accepted under Q-01's third criterion: provider-specific features that cannot be reproduced without live retired or unstable vendors remain explicit partial rows behind replaceable adapters. This verifies the bounded service contract while retaining `implementation: partial`; it does not assert complete historical live-provider parity.
