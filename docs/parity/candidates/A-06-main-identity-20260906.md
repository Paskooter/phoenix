# A-06 current-main Update/Delete and credential-identity candidate

Status: unverified candidate pending root review.

This candidate starts at current main `14acdecdf8df1bde1127e3e2f43a77d08b1122bf` in
`/home/shell/work/phoenix/.parity/worktrees/a06-main-identity`, branch
`codex/candidate-a06-main-identity-20260906`. It carries the reviewed internal
Settings Update/Delete implementation and the repaired local Person/Lasso persistence
identity into current main. The public Account parser isolation and Settings transport
code from current main remain in place.

The owned product changes are:

- `packages/account/src/settingsFace.js`: source-shaped internal UpdateSettings and
  DeleteSettings dispatch, validation, service routing, partial error results and
  source provider-call diagnostics, copied from the reviewed A-06 slice.
- `packages/account/src/settingsProviders.js`: loop properties keyed by loop, Lasso
  identity keyed by account + skill + service + account name + canonical scope set,
  requested-scope subset lookup, duplicate-match refusal, wildcard/omitted deletion,
  safe legacy marker handling, deleted-tombstone exclusion during later updates, and
  source-compatible report-calendar replacement across providers.
- `packages/account/test/settingsUpdateDelete.test.js`: Update/Delete, persistence,
  identity, replacement and peer-boundary controls.

The source pins are Pegasus `5c0a7390539663ba749d360de348a428c088505c` and
`jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`. The Lasso source
and compiled credential implementations are SHA-256
`00ba610574744651118cad772d1328cc525f4d62a1fca880509a91818f106479` and
`a61db831a032c60caf74dc54d2a62c25354ecfc4f26a3f14452b1c13202fdc62`; the source
credential tests are
`b246561eeefc3eb5c7885ebf2c15df45edf62c313d9d6ce187271142acf94e3f`.

Fresh candidate evidence is in
`/home/shell/work/phoenix/.parity/reviews/a06-main-identity-20260906`:

- `compare-52.stdout`: 52/52 source Update/Delete rows match status, raw body,
  non-Date headers, provider calls and state. The immutable source controls are
  `cases.json` SHA-256 `46eb2b2cbb02fde0a56cd680ba39fc2ae2bc534f6e2d2784c50a146e0e4317b1`
  and `original.json` SHA-256
  `c3a5f27bf200a77db69a57c3d7a22dad03ef13fa40d090629a4e55b596d88c69`.
- `compare-78.stdout`: 78/78 internal Settings getter rows match status, raw body,
  every header except generated Date, and provider calls. The source capture SHA-256
  is `d299cd583ea5d78cd6ef648480aec3435c9fca527d8e928f941e4992644dc369`.
- `settings-local-tcp.json`: nine observed controls through the actual internal TCP
  Settings listener. They cover same-loop members, different loops, different
  accounts, different skills, update, scope permutation, scope subset, delete and
  post-delete read; all assertions pass. The listener uses a bounded Hub manifest
  seam and the candidate's local Account/Person/Lasso providers, so it exercises the
  HTTP boundary without live providers.
- `source-lasso-delete-other.json`: direct compiled pinned-Lasso controls with a
  narrow `StoredCredential.remove` recorder. They show the source deletes a different
  service for report `personalCalendar`/`workCalendar` slots and, because the pinned
  implementation assigns `skillId = 'report-skill'`, also applies that query shape to
  an incoming other-skill credential. The local replacement test preserves this
  source-observable behavior without changing the saved new-skill tuple.
- `test-account.log`: 70/70 account tests. `test-common.log`: 21/21 common tests.
- `workspace-before.json` records the worktree-local dependency links before commit;
  all `@phoenix/*` links resolve inside this worktree. A matching after-commit proof
  is recorded alongside the final candidate metadata.

The old colon-joined report marker cannot encode delimiter-containing service names,
service-account names or scopes injectively. This candidate refuses to read or write
that legacy marker when any component contains `:` and uses the dedicated JSON tuple
record instead. That is an explicit unsupported migration difference, not a parity
pass or a zero-difference claim: an already-stored ambiguous marker cannot recover
which original tuple was intended. New dedicated records with source wire scopes,
including reordered and subset requests, are covered by the listener controls.

The candidate does not claim real Mongo unique-index behavior, OAuth exchange, public
authentication, live Lasso/Person/Hub peers, robot behavior or end-to-end hardware
acceptance. Those remain outside this bounded local/internal Settings slice.
