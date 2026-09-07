# H-04 continued-session lifecycle candidate

This candidate is based on `7361c2a3033b6afd421eaae03d07a007cbfd5505` and is
pending root review. It keeps the previously accepted launch, update, redirect,
mediation, and history implementation intact.

The source boundary exposed one remaining trace gap. Pegasus constructs a
`JiboHeaders` object before `ListenTransactionHandler`; absent or empty headers
become `x-jibo-transid: unknown`, `x-jibo-robotid: unknown`, and
`x-jibo-logging-config: {}`. Phoenix was reading the raw upgrade headers and
omitting those values. `ListenTransaction` now materializes those three source
defaults once at the transaction boundary. The same trace object is then used
for parser, skill, and history calls. Explicit and partial headers remain
verbatim apart from the source defaults for missing fields.

The focused test is
`packages/gateway/test/listenTransaction.lifecycle.test.js`. It drives the
actual transaction message sequence (`LISTEN`, `CONTEXT`, `CLIENT_NLU`) into a
controlled HTTP skill peer and covers:

- default and partial trace propagation;
- initial `LISTEN_LAUNCH` action data, including `fireAndForget` and analytics;
- a continued `LISTEN_UPDATE` carrying the opaque prior session;
- redirect notification ASR/memo preservation;
- redirected `LISTEN_LAUNCH` omission of ASR and preservation of the final
  action fields.

## Differential evidence

Fresh evidence is retained under
`/home/shell/work/phoenix/.parity/reviews/h04-session-lifecycle-20260907`.
The pinned source is Pegasus `5c0a7390539663ba749d360de348a428c088505c`, run
with Node `8.9.4` image
`node@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`.
The source runner invokes the compiled `ListenHandler`,
`ListenTransactionHandler`, `SkillRequestMaker`, and `SkillConfigManager` with
an executable socket message emitter and a real loopback HTTP skill peer. The
candidate real-WS runner starts Phoenix `createGateway`, connects with the
`ws` client, sends the same two-turn sequence, and uses the same controlled
HTTP peer.

The direct source/candidate matrix has 6 cases and 8 skill requests. It covers
rich launch data, launch followed by an action continuation, update redirect,
empty and partial trace headers, and a continued provider failure. All 6 cases
match on request bodies, update session, redirect/final fields, error frame
shape, history-side-effect absence on failure, and all three trace headers.
Generated IDs, timestamps, elapsed timings, and loopback port/authority are
normalized only after raw-body JSON and trace-header guards pass. Error message
text is retained in raw captures and is the sole diagnostic normalization.
Receipt: `comparison-ws.json` (`matches: 6`, `requests: 8`).

The independent full transport check has 2 actual WebSocket turns (launch then
continued update), 2 skill requests, and 4 response frames per turn. Source
and candidate match after generated ID/time normalization, including exact
request bodies, source trace defaults, opaque session propagation, and all
action fields. Receipts are `source-real-ws-v2.json`, `candidate-real-ws-v2.json`, and
`comparison-real-ws.json`; the source and candidate commands and outputs are
kept beside them.

Executed checks:

```text
node --test packages/gateway/test/*.test.js
90 passed
```

The prior accepted 12-case history receipt remains immutable at
`.parity/reviews/h04-history-final-root-20260907`; it was not retagged as new
evidence. Its 12/12 result is not included in the fresh 6-case count.

## Remaining boundary

The candidate does not claim the whole H-04 task. Early client disconnect and
transaction close/reset behavior before a final response still needs a source
and client-level acceptance decision: the source `SocketMessageReader` lets
the listen handler's transaction timeout govern that path, while Phoenix's
outer gateway close listener currently resolves the transaction immediately.
The fresh transport control closes only after a final response and therefore
does not qualify that open branch. Skill timeout scheduling, native ASR, robot
execution, and deployed client acceptance remain outside this slice.
