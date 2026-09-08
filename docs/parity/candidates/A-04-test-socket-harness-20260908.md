# A-04 test socket-harness repair

Status: **test-harness candidate, unverified; root review is required.**

This candidate starts from main `9aeb959e11832cec825da62d1aa21e5af6e1d6d6`.
It changes only five synthetic Account test request helpers:
`packages/account/test/loopMemberUpdate.test.js`,
`packages/account/test/robotLookup.test.js`,
`packages/account/test/loopMembership.test.js`,
`packages/account/test/loopHouseholdBootstrap.test.js`, and
`packages/account/test/robotFace.test.js`.

## Observed failure

The preserved diagnostics are:

- `/home/shell/work/phoenix/.parity/reviews/a04-photos-integration-root-20260908/socket-repeat-1.log`
- `/home/shell/work/phoenix/.parity/reviews/a04-photos-integration-root-20260908/main-socket-repeat-3.log`

In those runs, the same-process tests performed synchronous fixture/store or
mock-provider work between requests. Node's `fetch` pool reused a connection
after the service's 5,000 ms idle timeout. The server diagnostic recorded a
`socket-timeout` on the pooled socket at the next `fetch-start`; the test then
failed with `TypeError: fetch failed`, cause `ECONNRESET` or
`UND_ERR_SOCKET`. The failure was in the local test transport lifecycle,
before the failing request reached the handler. No product timeout or request
retry is changed here.

## Repair

The five affected helpers now add `Connection: close` to each local test
request after signing (or, for the robot-face helper, after assembling its
headers). Closing each test connection prevents an expired
keep-alive socket from being selected by Node's pool during later synchronous
fixture work. The request is still sent once, and errors are still surfaced.
This is test-only transport hygiene; production fetches and Account server
timeouts are unchanged.

## Independent loopback control

The earlier bounded control
`/home/shell/work/phoenix/.parity/reviews/a04-socket-harness-20260908/idle-fetch-control.mjs`
used a 100 ms server idle timeout and 120 ms gaps. Both default and close
modes completed 40/40 requests in that run, so it is retained as a clean
baseline and is not claimed as a failure reproduction.

The deterministic stale-pool control
`stale-pool-control.mjs` models the race directly. It marks the first socket
stale after 10 ms while leaving it in the client pool, then waits 40 ms before
the second POST. With ordinary keep-alive, the second request reused socket 1,
the fixture reset it, and the command intentionally exited `0` as a negative
control with one `UND_ERR_SOCKET` failure. With `Connection: close`, the first
socket closed, the second request used socket 2, both responses were HTTP 200,
and the command exited `0`. The control never retries either request and only
uses loopback.

Commands and results:

```text
node stale-pool-control.mjs default > stale-default.json 2> stale-default.err
# exit 0 (negative control: request 1 failed with UND_ERR_SOCKET)
node stale-pool-control.mjs close > stale-close.json 2> stale-close.err
# exit 0 (repair control: two HTTP 200 responses, zero failures)
```

The stale control's exact results are retained under the evidence directory.
The 20-iteration idle baseline was:

```text
node idle-fetch-control.mjs default > default.json 2> default.err
# exit 0, 40 responses, zero failures
node idle-fetch-control.mjs close > close.json 2> close.err
# exit 0, 40 responses, zero failures
```

## Validation

The affected test files were run with the existing socket diagnostic preload:

```text
node --import /home/shell/work/phoenix/.parity/reviews/a04-photos-integration-root-20260908/socket-diagnostics.mjs --test packages/account/test/loopMemberUpdate.test.js packages/account/test/robotLookup.test.js
```

It exited `0` with 31 tests passed and 0 failed. The receipt is
`/home/shell/work/phoenix/.parity/reviews/a04-socket-harness-20260908/affected-after.tap`.
It contains no `SOCKET_DIAGNOSTIC`, `ECONNRESET`, or `fetch failed` record.
The run took 47.8 seconds because the fixtures intentionally exercise source
failure and persistence boundaries; no external service was contacted.

## Hashes and limits

Candidate worktree:
`/home/shell/work/phoenix/.parity/worktrees/a04-socket-harness-repair-20260908`

| Artifact | SHA-256 |
| --- | --- |
| `packages/account/test/loopMemberUpdate.test.js` | `71dcf696137c754c6c81b73824c96e15bb6c7b0f2a142d444a07703587617d8d` |
| `packages/account/test/robotLookup.test.js` | `771903b5b117a67eeaca2421bd873a9cdd5e79e3409b1121f0816d3f2347eb30` |
| `packages/account/test/loopMembership.test.js` | pending after commit |
| `packages/account/test/loopHouseholdBootstrap.test.js` | pending after commit |
| `packages/account/test/robotFace.test.js` | pending after commit |
| `stale-pool-control.mjs` | `30bc4e591d8faf5aedf1389ead770e6018a8f83e9e159f54fb187acb078c17ea` |
| `stale-default.json` | `0afe140edb8d284ee599d5c24069cac4192d578e003b1af4ea265cacdc696f7e` |
| `stale-close.json` | `8c9abf4582a320554c50a93d6cb40e1f6079f9856105386fb90d9f12b1b3f07f` |
| `affected-after.tap` | `a1b5a25ff73ca41fac12421acc5954707d4bb1692bdba91fbdd616d0cae8d6c7` |

The synthetic stale control demonstrates why the repair removes this class of
test flake, while the existing service diagnostics establish the observed
Account-test failure. It does not prove every Node/Undici/server timing race is
impossible, and it makes no claim about production connection policy. Root
must review the narrow test-only change before integration.
