# R-02 — clean install, native and compose startup, migration

Date: 2026-09-17
Harness: `scripts/parity-r02-install/` (built by a subagent, then re-run and
falsified by the root agent — the numbers below are from the root agent's own
run, not the agent's report).

## The criterion that was actually violated

R-02's third clause asks that verification "use temporary stores/test accounts
and avoid depending on this machine's `.env`, siblings or live robot". It was
violated in two places:

* `scripts/run-compose-stack.sh` sourced `./.env` unconditionally;
* `docker-compose.yml` carried `env_file: [{path: .env, required: false}]`.

Both pull in this developer's private configuration, including live LAN
endpoints (`PARAKEET_URL`, `LLM_URL`). A run that passes only because that file
exists proves nothing about a clean install. Both are now **opt-out** rather than
removed — `--no-env`, `PHOENIX_ENV_FILE=/dev/null`, and parametrised host ports
with the reference values as defaults — so existing use is unchanged.

## Result (root agent's run, revision 08446cc)

```
[preflight]        docker=true offset=200 collisions=0
[clean-install]    revision 08446cc614 env.absent=true npm.exit=0 install=1.02s
[native hermetic]  readiness=OK contract=23P/3F leak=503 named=none
[compose hermetic] up=OK readiness=OK contract=23P/3F leak=503 named=none
[all]              native=true compose=true migration=true
```

`env.absent=true` is the criterion-3 assertion: the clean tree is exported from
HEAD with no `.env` at all, and that is checked rather than assumed.
`leak=503` is the same property from the other side — the admin face is disabled
because `ADMIN_PASSWORD` lives in `.env`, so a 503 proves the private file did
not leak into the lane.

Port 9013 is held by an unrelated `browser-proxy` container on this host, which
is why the lanes run at an offset; the contract map shifts with them.

## The three contract failures were the CHECK being stale, not defects

Both lanes reported `23P/3F`, identically. The subagent reported them honestly as
pre-existing rather than tuning them away, which was right — but "pre-existing"
was not the whole story, and all three are now fixed at the source.

**Two WS-turn failures.** These lanes run the hub with `disableAuth`, and a
CONTEXT message cannot complete in that mode — in Phoenix **or in the original**.
`MessagePreProcessor` builds its defaults unconditionally from the socket
identity (`accountID: socket.auth.id`, reference `MessagePreProcessor.ts:21`), so
with no authenticated socket it throws before it looks at the message. Confirmed
by experiment, not just by reading: adding `accountID`/`robotID` to the CONTEXT
changes nothing, because the throw happens while building the defaults. The check
now asserts the real contract of an auth-disabled stack. Routed turns are covered
properly by `scripts/parity-r01-substitution` against the original suite with
real auth — five lanes, 13 passing each.

**One answer-skill failure.** Its default profile is the recovered GQA pipeline
(X-01), so `/v1/main` speaks the GQA envelope and requires `X-JIBO-transID`. The
old ordinary-skill body earned `Missing GQA request field data.runtime.location`;
without the header the missing-transID branch answers 400 HTML first. Both are
correct rejections. H-09's evidence (2026-09-10) recorded this POST passing, so
this is a consequence of X-01 dated 2026-09-16 — a behaviour change, not a
pre-existing failure, and worth dating rather than filing under "pre-existing".

After fixing the check: **ALL PASS, 0 failures.**

## Falsification

The harness and the check both have to be able to fail.

* Contract check pointed at empty ports: **19 failures**.
* An answer-skill on the ordinary profile answers a `SEQUENCE` where GQA answers
  a `SLIM`, so the GQA assertion is pinned to the GQA contract rather than
  passing on anything that returns JSON.
* S-06 re-checked after teardown: 11 files, 4/4 pass. The lane's generated
  registry lives in the temp clean tree, never in the working copy, and
  `offsetRegistryLeftovers()` asserts it is not left behind.

## Recorded scope reduction

One step is SKIPPED and named in the receipt: `original-db-fixtures`. R-02 asks
for migration "where available, original database fixtures" — the original
account/loop data lived in MongoDB and no restorable dump is part of the Jibo
archive. The JSON-store path is exercised instead: seed, restart persistence,
backup/restore, rollback. Stated in the open rather than quietly counted as a
pass.

## Reproduction

```bash
scripts/parity-r02-install/run.sh all --offset 200     # receipt: .parity/runs/r02/receipt.json
PHOENIX_PORT_OFFSET=300 node scripts/verify-compose-contract.mjs
PHOENIX_PORT_OFFSET=900 node scripts/verify-compose-contract.mjs   # falsification: 19 failures
```
