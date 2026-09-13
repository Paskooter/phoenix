# A-05 installed original SDK and process restart review

Date: 2026-09-13

Worktree: `/home/shell/work/phoenix/.parity/worktrees/w18-a05-sdk-restart`

Candidate: `6e817e31985dfc578dc4dc8bbf745955eee657d7`

Decision: **A-05 bounded progress verified; task remains open.**

The tracked [`review.json`](./review.json) is the receipt for the run. It
records the installed original SDK hashes, exact Node 8 runtime hash, each
success/error response body after secret and token values are hashed, both
service child exit codes, and the durable Store snapshots.

## Method

The runner starts `scripts/parity-a05/sdkFixtureServer.mjs` in a child process.
That process creates separate owner/admin fixtures for two local faces:

* Account `POST /` directly;
* Classic `POST /`, forwarding OOBE and proxying Account and Loop requests to
  the same Account child.

The original installed `@jibo/jibo-server-client` **3.0.110** package drives
both faces under the extracted original Node **8.9.4** executable. The normal
client invokes all four archived normal operations and the admin client invokes
`GetServiceToken`, then exercises ordinary setup, used-token replay, expiry,
live-loop replacement refusal, suspended-loop replacement, reconnect and
reconnect replay, non-admin rejection, service-mode setup, and status checks.

The runner requests `/shutdown`, waits for the first child to exit with code
0, starts a new Account/Classic child over the same Store and fixture metadata,
then uses the issued ordinary, replacement and service credentials with the
original `Account.Get` and `Loop.List` clients. It also checks consumed setup,
replacement, reconnect and service tokens, expired-token behavior, and a token
left pending across the process boundary before consuming it and rejecting its
replay. The second child is shut down through the same orderly control path.

The two explicit replacement falsifications are named in the receipt:
`FALSIFY live loop replacement refusal` requires `LOOP_MUST_BE_SUSPENDED`, and
`SetupRobot suspended-loop replacement` must then succeed. The one-time
falsifications cover setup and reconnect replay both before and after restart;
the admin falsification requires `AUTHORIZED_UNDER_ADMIN` for ordinary
credentials. A reverted implementation fails the corresponding assertion.

## Commands and results

Run from this worktree:

```text
node scripts/parity-a05/runInstalledSdkMatrix.mjs
```

The recorded run completed with:

```text
candidate: 6e817e31985dfc578dc4dc8bbf745955eee657d7
installed client: 3.0.110 under Node v8.9.4
initial: 38 checks, 0 failures (19 per face)
restart: 46 checks, 0 failures (23 per face)
Account face: pass
Classic face: pass
initial service child orderly exit: 0
restart service child orderly exit: 0
before/after Store maps match disk: true
```

The repository-wide `npm test` completed on the same worktree with **1,970
passed, 0 failed, 8 skipped**. Its parity check reported **62/79** verified;
the strict production gate compared **43 cases with 0 differences, 0
invariants, and 0 coverage gaps**.

The process snapshot has 16 accounts, 10 robot accounts, 8 loops and 2
service-mode owner accounts. Six expected pending/expired tokens remain after
the first matrix; four remain after the restart matrix consumes the two newly
replayed pending tokens. All nine Store collections compare equal to the
on-disk atomic snapshot at both checkpoints. The server's pre-matrix receipt
shows two suspended loops (one per face); the replacement assertions consume
those suspended-loop tokens and leave zero suspended loops at the checkpoint,
as the source setup flow specifies.

## Source and dependency reconciliation

The operation and wire inventory is the cached original SDK API pair:

* Jibo MCP `jiborobot/srv-jibo-server-client:apis/oobe-2016-10-26.normal.json@master`:
  target prefix `OOBE_20161026`,
  `PrepareRobot`, `GetStatus`, `SetupRobot`, `ReconnectRobot`;
* Jibo MCP `jiborobot/srv-jibo-server-client:apis/oobeadmin-2016-10-26.normal.json@master`:
  the same target prefix and
  `GetServiceToken`;
* Jibo MCP `jiborobot/srv-jibo-server-client:apis/account-2015-11-11.normal.json@master`
  and `apis/loop-2016-03-24.normal.json@master` for restart credential checks;
  the installed package is the generated/minified SDK form of these models.

Jibo MCP search was run first for the OOBE operation question. The broad
operation query returned no indexed hit, so the repository was located with
`gitea_list_repos` and the API files were read directly. The authoritative
controller read is
`jiborobot/srv-account-ws:src/controllers/oobe.ctrl.ts@6cea43470825657d6a5722162f28c8f233153ee2`
and the handler/source behavior remains source-simple
`reconnectRobot({ token })`, one-time token deletion, and no membership or
suspension checks on reconnect. The implementation review also retains the
source-pinned `@jibo/server` 4.0.17
`jiborobot/srv-server` parser boundary in the preceding
[`a05-oobe-parser`](../a05-oobe-parser/review.md) evidence.

`tasks.json` was read but not edited. A-03 is marked `verified` with
`implementation: partial`; its complete Account operation, public/internal
boundary, SNS/Mongo/bootstrap lifecycle and root acceptance remain open. A-04
is also marked `verified` with `implementation: partial`; duplicate/reinvite,
conditional adoption/revival, uncovered state/failure/persistence cases,
deployment and live effects remain open. This SDK run composes the OOBE,
Account and Loop routes needed by the A-05 flow and supplies dependency
evidence, but it does not close either partial task.

## Remaining root-only acceptance

Fresh evidence is still required for a real robot identity, firmware and date,
native pairing, TLS ingress, camera/microphone/screen/notification behavior,
household preservation or migration, and deployment on the accepted hardware.
This isolated review used only local synthetic fixtures and did not access Moth,
hardware, deployment, or the root checkout.
