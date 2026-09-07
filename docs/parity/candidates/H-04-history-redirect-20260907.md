# H-04 history and redirect candidate

Status: unverified; isolated candidate for root review.

Base: `150d6fc9a31137166ff8dfe09f137e3170e93e5c`. This slice owns the
`ListenTransaction` launch-history and redirect boundaries in
`packages/gateway/src/listenTransaction.js`; the H-04 decision mediator and
`_performRouting` release mediation remain outside this candidate and are
owned by the root review worktree.

The pinned Pegasus implementation is
`5c0a7390539663ba749d360de348a428c088505c`. Its
`ListenTransactionHandler.getSkillResponse` records a launch only when the
skill request returned without an error, before redirect processing. Its
`handleSkillRedirect` records a successful destination launch separately,
using the original NLU intent and the destination response session, before
checking for a second redirect. The redirect request is built with context,
redirect NLU, and redirect memo; ASR is omitted. `TransactionHelper.getPersonIDs`
returns `[perception.speaker]` or `['UNKNOWN']` and never unions
`peoplePresent`.

Phoenix now follows those boundaries. `_onSkillMatch` records the successful
initial response before `_handleRedirect`, skips history for a returned skill
error, and defaults `memo` to `null` like the source. `_handleRedirect` omits
ASR, records a successful destination response with its own session, and
records a successful second redirect before returning the source
"Too many redirects" error. `_record` uses only the speaker or the
`UNKNOWN` sentinel and still remains fire-and-forget when history is enabled.

The focused tests in
`packages/gateway/test/listenTransaction.history.test.js` use the real
Phoenix `SkillClient` and `SkillConfigManager` against controlled loopback
HTTP skills. They cover successful launch/session, speaker/`UNKNOWN`, initial
failure, successful redirect, destination failure, repeated redirect,
on-robot, and history-disabled cases. The source differential runner uses the
compiled pinned Node 8 Pegasus `SkillRequestMaker`, `SkillConfigManager`, and
`ListenTransactionHandler` against equivalent loopback HTTP skills; it
records request JSON and history writes.

Fresh evidence is under
`.parity/reviews/h04-history-redirect-20260907/`:

* `source.json` contains 8 original Node `v8.9.4` controls.
* `candidate.json` contains the same 8 controls under Node `v22.22.0`.
* `comparison.json` compares case order, request bodies, history rows, and
  transaction fates; all 8 cases pass after excluding only generated UUIDs.
* `provenance.json` records the exact Node 8 image, Docker argv, source file
  hashes, source exit status, and control scripts.

The source and candidate controls produced identical normalized request shapes,
history rows, and outcomes: 8/8 cases and 8 total history rows. The redirect
request has `result.nlu` and `result.memo` but no serialized `result.asr`; the
initial and destination rows retain the original intent. The two source
redirect failure controls retain the initial successful row only, while the
repeated redirect retains both successful rows before rejection.

Validation from this worktree:

```text
node --test packages/gateway/test/listenTransaction.history.test.js  6/6
node --test packages/gateway/test/*.test.js                            83/83
```

Remaining scope includes the root-owned decision mediator/release routing,
speech-history records, proactive transactions, and full robot/WebSocket
acceptance. No main, robot, source reference, golden, comparator, or live
service files were changed. Root acceptance remains required.
