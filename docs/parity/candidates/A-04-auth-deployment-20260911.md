# A-04 gate 6 — authentication and deployment restart sequences

Status: **candidate; awaiting root review.** A-04 is not closed. This write-up
covers only gate 6 from
[A-04-acceptance-index-20260908.md](A-04-acceptance-index-20260908.md).
Gates 1–5 were not redone.

Task id: `a04-auth-deployment-20260911`  
Worktree branch: `grok/candidate-a04-auth-deployment-20260911`  
Base revision: `1a410c1`  
Harness revision: `bb3d085a30f616d28cc582e0a4b75789a3b5e9c3`

## Gate

> Signed Account/Classic controls cover the implemented public Loop boundary
> and reject forged internal credential metadata. The remaining deployment
> check is the signed Account→Classic state sequences above after restart,
> with configured local transports and the source callback exceptions kept
> separate from ordinary Loop calls. Equivalent local transports, synthetic
> fixtures and non-destructive installed-client checks are acceptable
> evidence; AWS cloud deployment and destructive real-family mutation are
> outside this task.

## What changed

No production Account/Classic behavior was changed. The gate is proved by
reusing the gate 1 harness:

1. `scripts/parity-a04/run-state-sequences.sh` — same source controller run,
   then Phoenix Account/Classic, then original generated client sequences,
   then **SIGUSR1 restart** of the Account and Classic HTTP servers from the
   same store files, then a post-restart original-client phase.
2. `state-sequences-server.mjs` now launches configured local SMTP and HTTP
   invitation transports (not the contained no-op defaults) and rebuilds
   Account/Classic from disk on SIGUSR1.
3. `state-sequences-client.cjs` `SEQUENCE_PHASE=post` — surviving-loop
   List/GetRobot, next valid Invite, signed SetLegalGuardian, unsigned
   UpdateAgreementStatus, unsigned ordinary Loop, forged `x-amz-credentials`.
4. `compare-state-sequences.py` — gate 1 dimensions from the pre-restart
   captures plus 17 post-restart comparisons.
5. `packages/account/test/loopAuthDeployment.test.js` — three Node 22
   Account→Classic controls locking restart state, transports, and the
   callback/ordinary-Loop split.

Command:

```bash
bash scripts/parity-a04/run-state-sequences.sh
python3 scripts/parity-a04/compare-state-sequences.py
node --test packages/account/test/loopAuthDeployment.test.js
npm test
```

Evidence: `.parity/reviews/a04-auth-deployment-20260911/` (gitignored).

## Source pins actually read

Pinned artifacts were read through the Jibo MCP (`gitea_read_file`). **No
original Account Hapi/Mongo process was started.**

| Artifact | Pin |
| --- | --- |
| Account service | `jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2` |
| Loop controller | `src/controllers/loop.ctrl.ts` SHA-256 `8eab9312ba611b1dc5735599521bf73f1dbd2ede49f8da53ad3b4b543d729024` |
| Public gateway | `jiborobot/srv-security-gw@43a692fe7670660aaed6ab5979c6c83039eb711c`; `auth.ctrl.ts` SHA-256 `776c0908cbb5e842fe7866e7d1e6640578c390d604536c76652707b50785881d` |
| Executed compiled controller | SHA-256 `c7025c7ca9596ab24adb1f81b8a7ac3fd47c2b33b79428565f7e399dbd9f574f` |
| Generated API | `@jibo/jibo-server-client@3.0.110` package.json SHA-256 `3ad05cb8b2d532e6daa0beec6b967fcbf9a82ee86ac5a92c488746b390831c4d` |
| Node image | `node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c` (v8.9.4) |

### Auth policy, as read from `auth.ctrl.ts`

`unauthorizedMethods` (absent `Authorization` is allowed; a supplied header is
still verified) includes exactly these Loop targets:

- `Loop_20160324.AcceptInvitationByCode`
- `Loop_20160324.DeclineInvitationByCode`
- `Loop_20160324.UpdateAgreementStatus`

`unsignedMethods` is **empty**. `SetLegalGuardian` is **not** on the
unauthorized list; source requires a signed owner. EchoSign is the provider
that later posts `UpdateAgreementStatus` without a Loop caller signature.
`x-amz-credentials` is not consulted by this gateway controller.

Phoenix already matches that split at `robotFace.js` (`anonymousTarget`).
This gate measures it **after** Account/Classic restart.

## Verified by execution

Original-client calls: **36 pre-restart** (18 Account + 18 Classic) and
**32 post-restart** (16 Account + 16 Classic). Source controller: **22**
handler steps across the five named sequences. Classic forwarding for the
pre-restart 18 hops: request body SHA, response status, and response body SHA
identical to the upstream Account hop. `compare-state-sequences.py`:
**33/33** match, including exact Classic forwarding.

Restart: SIGUSR1 closed the Account and Classic HTTP servers, opened new
`Store` instances from the same JSON files, constructed new
`createAccountService` / `createClassicEntrypoint`, and listened again.
`restartCount` is 1. Local SMTP and HTTP event fixtures stayed up.

### 1. Gate 1 sequences after restart

Post-restart ListLoopMembers on the surviving invite loop still has owner and
robot `accepted`, accept-guest `removed`, decline-guest `declined`. ListLoops
omits the cleared and removed loops. GetRobot on those deleted loop ids
returns **404 `LOOP_NOT_FOUND`**. The next valid InviteLoopMember (new
unknown email) returns **200** with that member `invited`. Account outbox is
empty after drain; LoopUpdated still uses robot account and skill `-1`.

### 2. Configured local transports across restart

SMTP `127.0.0.1` (not the default no-op) and HTTP
`http://127.0.0.1:<port>/events` (not the default no-op). Pre-restart:
**4** SMTP messages (two existing-user invites × two faces) and **16** HTTP
events (LoopCreated plus membership events). Post-restart next invite:
**6** SMTP / **18** HTTP. From-address is `local-sender@synthetic.invalid`.
Event keys include `InvitedToJoinLoop`.

### 3. Callback exception kept separate from ordinary Loop calls

After restart, on both Account and Classic:

| Request | Auth | Result |
| --- | --- | --- |
| Signed `SetLegalGuardian` | SigV4 owner | 200 `{ result: "Command accepted" }` |
| Unsigned `UpdateAgreementStatus` plus forged `x-amz-credentials` | none | 200, child becomes `accepted` |
| Repeat unsigned `UpdateAgreementStatus` | none | 404 (member no longer `invited`) |
| Unsigned `ListLoops` / `InviteLoopMember` / `SetLegalGuardian` | none | 401 `MISSING_AUTH_HEADER` |
| Same three plus forged `x-amz-credentials` | none | 401 `MISSING_AUTH_HEADER` |
| Signed outsider `InviteLoopMember` plus forged `x-amz-credentials` claiming owner | SigV4 outsider | 403 `CAN_BE_ACCESSED_BY_OWNER` (Node 22 control) |

The unsigned callback does **not** leak into ordinary Loop operations.
Forged internal credential metadata is **not** a public identity after
restart.

Persisted child after the unsigned callback: `status=accepted`,
`isChild=true`, `agreementId=synthetic-agreement-2`.

## `npm test`

At harness revision `bb3d085` (this write-up is documentation only):

```text
# tests 952
# pass 945
# fail 0
# skipped 7
parity:check valid
parity:gate {"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}
```

Baseline at `1a410c1` from the main checkout is 949 / 941 / 0 fail / 8 skip.
This candidate adds three Node 22 restart controls. 945 pass / 7 skip versus
941 pass / 8 skip is those three plus the documented worktree path artifact
(`scripts/nlu-compiled-graphs-install.test.mjs` resolving
`<repo>/../../reference/...`). Log SHA-256
`90d84814b0221452061a9f438d301c2ee2c3e1c3777ed7f2e7ac27fbd5e2708b`.

## Evidence artifacts

| File | SHA-256 |
| --- | --- |
| `source-sequences.json` | `72170ea2366f1926738014c2c0202c701a8ed2da36ad3db3131b9df972ffc67a` |
| `sdk-results.json` | `b2a6b20b734231a9d73ce62857ad38328075d9330ec5f43eb1ca3eec9af0024e` |
| `sdk-post-restart.json` | `8cb62006c59d851146d8cdefc29ad57ab1a892aef48ca4260befb5c55c26c965` |
| `pre-restart.json` | `7c3130a652bc423d2ecd6f6b546a9ebaa6e7b6a5a19784df749e53cbce4d7aaf` |
| `post-restart.json` | `9abc1bc649b93965be7589b46463350715031bb0f55a6b4627ac02ae5095ef79` |
| `server-captures.json` | `767a00377c9895f96e53e310ee11fb5f1ca15b884c49dfa126325ec75cc5a6f8` |
| `comparison.json` | `399c48d3f7a7415056431486ed65c95f95ae4eba7d19a6b20c4a38fe8e19caee` |
| `review.json` | `.parity/reviews/a04-auth-deployment-20260911/review.json` |

## Inferred from source reading

- `SetLegalGuardian` is a signed owner call. Grouping it with “anonymous
  callback acceptance” in the gate text does not match `unauthorizedMethods`.
  Phoenix requires a signature; that is the source policy, not a relaxation.
- `AcceptInvitationByCode` and `DeclineInvitationByCode` are also
  unauthorized Loop targets. They remain unimplemented here; this gate did
  not add them.
- EchoSign `callbackInfo` is the unsigned `UpdateAgreementStatus` path. The
  local agreement provider is a synthetic `refreshToken`/`send`/`isSigned`
  seam, not Adobe.

## Still unknown

- AWS cloud deployment and a real SMTP/EchoSign provider.
- Destructive real-family mutation; Moth and any robot host were not
  touched.
- Original Account Hapi/Mongo process restart (source run is the existing
  controlled Node 8 controller harness).
- Kernel-level new PIDs / systemd unit restart. This evidence is an orderly
  close of the Account and Classic HTTP servers, a new `Store` from the same
  files, and listen again. Crash-mid-flush remains gate 3.
- Whether in-flight original sessions must survive deployment cutover (PLAN
  leaves that as an explicit compatibility decision).

## Candidate divergences

None measured in this gate. If root treats the in-process HTTP recycle as
insufficient for “process restart”, that is a coverage gap in the evidence,
not a Phoenix/source behavior split.

## Gate 6

The three scoped items were executed: gate 1 sequences after restart,
configured local SMTP/HTTP transports across that restart, and the source
callback exception kept separate from ordinary Loop calls, including forged
`x-amz-credentials` rejection. **Root owns the “bounded accepted” label.**
