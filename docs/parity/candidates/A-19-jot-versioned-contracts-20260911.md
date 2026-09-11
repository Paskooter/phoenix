# A-19 — Versioned Jot messaging contracts (worker report, w12/a19)

Branch `w12/a19` off `e12ab0d`. Scope: resolve divergence **A19a** from pinned source and close
acceptance criterion 4 (messaging journeys) as far as it can go without the dead original client.

## 1. A19a is RESOLVED — the Jot target prefix is not significant

**Pinned cause.** Jot is an `@jibo/server` service (`server/jot-ws@9a725d3…`
`src/index.js`: `new App({ name: 'jot-ws', handlerFactory: … })`). The framework's dispatcher
inspects only the *operation* segment of `X-Amz-Target`:

```
server/server src/server.js  `lowerMethodName(request)`
  const target = request.headers['x-amz-target'];
  const methodName = target.split('.')[1];
  return methodName[0].toLowerCase() + methodName.substring(1);
```

Byte-identical in both recovered dependency lines:

| pin | file:line | note |
|---|---|---|
| `@jibo/server@3.1.1` (pins `~3.1.1` in `jiborobot/srv-jot-ws-archived@4432ac5d package.json:25`) | `dst/server.js:70-73` | the archived runtime test's framework |
| `@jibo/server@2.1.3` (pins `^2.1.3` in `server/jot-ws@9a725d3 package.json:26`) | `dst/server.js:64-68` | the current-source framework |

Because the prefix is never compared, **`Jot_20160126`, `Jot_20160512`, `Jot_20160310` and any
other prefix all select the same five loop-era handlers**. Both observed prefixes are real:

* `jiborobot/srv-jibo-server-client@b2da11bc apis/jot-2016-05-12.normal.json` —
  `metadata.targetPrefix = "Jot_20160126"` (the last model was re-cut for 2016-05-12 but its prefix
  metadata still names 2016-01-26; operations = exactly the five loop-era names).
* `jiborobot/srv-jot-ws-archived@4432ac5d archive/message.spec.js:63` —
  `'X-Amz-Target': 'Jot_20160512.CreateMessage'` (also `ListMessages`/`MarkRead`/`MarkLoopRead`),
  the only recovered runtime exercise.

So A19a's "which was deployed at end-of-life is unresolved" is answered: **the question is
moot for behaviour** — the deployed service never consulted the prefix. Phoenix keeps both observed
prefixes (`JOT_TARGET_PREFIXES`) for auditing and adds `JOT_DISPATCH_RULE = 'operation-name-only'`.

## 2. Versioned pair map (acceptance 1)

Every model read directly through the archive MCP:

| model | revision | declared prefix | operations |
|---|---|---|---|
| `apis/jot-2016-01-26.normal.json` | `4c68f963` | `Jot_20160126` | CreateMessage, RemoveMessage, ListIncomingMessages, ListSentMessages, MarkDelivered, MarkSeen (6) |
| `apis/jot-2016-05-12.normal.json` | `b2da11bc` | `Jot_20160126` | CreateMessage, ListMessages, MarkRead, MarkLoopRead, NumberOfUnreadMessagesInLoops (5) |
| `apis/jot-2016-03-10.normal.json` | `1b26ad78` | `Jot_20160310` | CreatePart, CreateMessage, UpdateMessage, RemoveMessage, GetMessages, ListIncomingMessages, ListSentMessages, MarkDelivered, MarkAllDelivered, MarkSeen, MarkAllSeen (11) |
| `apis/jot-2016-03-10.normal.json` | `39f53698` | `Jot_20160310` | CreatePart, CreateMessage, UpdateMessage, RemoveMessage, GetMessages, ListMessages, MarkSeen, MarkAllSeen (8) |

Union = 10 names under `Jot_20160126`, 14 under `Jot_20160310` — 24 (prefix, operation) pairs, 17
distinct operation names. 7 pairs are served (the five 2016-05-12 names under `Jot_20160126`, plus
`CreateMessage`/`ListMessages` under `Jot_20160310`) and the other 17 answer the framework 404. The
new `every model-declared Jot operation …` test proves each of the 17 distinct declared names lands
in exactly the served set (5) or the framework 404 (12). The direct
bulk route `POST /numberOfUnreadMessagesBulk` (`srv-jot-ws-archived src/routes/route.js:5-18`) is
unchanged and covered.

## 3. Error envelopes — one fixed, two reported

**Fixed (was divergent).** An operation with no registered handler is answered by the framework, in
the `POST /` `onRequest` extension, *before* `@parseCredentials`/`@validatePayload` run:

```
@jibo/server@3.1.1 dst/server.js:110-114
  const handler = this.mapping[methodName];
  if (!handler) return reply(Boom.notFound('Method ' + methodName + ' not found.'));
```

⇒ HTTP **404**, raw Boom body `{statusCode:404, error:"Not Found", message:"Method <lowerFirst op>
not found."}`, **no** `x-amzn-errortype` — and a 404 even when unsigned. Phoenix previously answered
`400 ValidationException "unknown jot operation"`. Now reproduced verbatim
(`jotMethodNotFound()`/`sendBoom()` in `packages/classic/src/jot.js`), matching the already-verified
sibling `src/voiceTraining.js`.

**Verified unchanged.** Unsigned Jot request → `401 MISSING_AUTH_HEADER` is source-backed at the
gateway: `jiborobot/srv-security-gw@43a692fe src/controllers/auth.ctrl.ts:44-52` —
`unauthorizedMethods` (lines 9-30) carries **no** Jot target, so `if (!request.headers.authorization)
throw Boom.createWithCode(Errors.MISSING_AUTH_HEADER)`; `src/errors/account.ts` gives
`{code:'MISSING_AUTH_HEADER', message:'Request is not signed properly, missing authorization header',
statusCode:401}`, exactly Phoenix's constant.

**Remaining divergence candidates (NOT changed here — DIVERGENCES.md is root-owned):**

* **A19e (new): Joi payload failures carry the wrong status/shape.** The pinned `@validatePayload`
  rejects with `Boom.badData(err)` (`server/server src/validate.js:22-25`) ⇒ HTTP **422**
  `{statusCode, error:"Unprocessable Entity", message:"<joi>"}` with no `x-amzn-errortype`. Phoenix
  answers `400 ValidationException`. Client-observable difference: the pinned client's
  `extractError` resolves `body.__type || body.code || body.error`, so the source code is
  `"Unprocessable Entity"`, Phoenix's is `"ValidationException"`.
* **A19f (new): JOT_* business errors are Boom, not the AWS envelope.** `Boom.createWithCode`
  (`@jibo/server dst/boom.js`) sets `error.output.payload.code`, so the source wire body is
  `{statusCode, error, message, code:"JOT_MUST_BE_LOOP_MEMBER"}` with **no** `x-amzn-errortype`.
  Phoenix uses the shared `sendAmzError` (`{__type,message}` + `x-amzn-errortype`). The *code* the
  client sees is identical either way; only the raw bytes differ. Same class as the deliberate
  scoping note in `src/log.js:68-71`.
* **A19g (new, edge): a dotless Jot target.** Pinned `lowerMethodName` dereferences
  `target.split('.')[1]` unconditionally and throws (`500`); Phoenix's prefix router answers
  `400 UnknownOperationException`. Not modelled.

## 4. Criterion 4 — journeys without the dead original client

**What substitutes for the original client, and why it is faithful.** The original client (Jibo
mobile app / robot SDK build) is dead. The only recovered *exercise* of this service is
`jiborobot/srv-jot-ws-archived@4432ac5d archive/message.spec.js`, an in-process Hapi
`server.inject` suite. The new test replays that suite's requests **verbatim at the wire level**
against a **real Phoenix entrypoint on a real TCP socket** — `POST /`, `Content-Type:
application/x-amz-json-1.1`, `X-Amz-Target: Jot_20160512.<Op>`, `X-Amz-Credentials {"id":…}` — using
the spec's own Account/Media fixtures, and asserts every postcondition the archived spec asserted
(20 creates with populated part urls; inbox unread-first; MarkRead; MarkLoopRead; the 14/14
after/before windows; robot impersonation attributing the message to the member).

It is faithful because the wire contract and the fixture data are the archived artifacts themselves,
not reconstructions. **What it cannot prove (UNKNOWN):** the real SDK's SigV4 signing and the TLS hop
to `srv-security-gw`; the substitute sends the internal `x-amz-credentials` identity the gateway
injects after verification. Sockets: Jot is HTTP-only (no `wss` surface), so "real sockets" = the
real listening entrypoint's TCP connection, not `server.inject`.

Also covered: durable state (in-process restart and SIGKILL process restart, pre-existing), cross-loop
isolation (pre-existing), external dependency failures retained (account/media 503, pre-existing), and
**retry semantics** (new): a re-sent `CreateMessage` is not deduplicated (no idempotency key exists
anywhere in model/handler/controller) while a re-sent `MarkRead` is an invisible `$addToSet` no-op;
and a retry after a failed media hop leaves *two* committed rows, because the source order is
create → send event → populateParts.

## 5. Falsification

Broke `packages/classic/src/jot.js` on the dispatch line
(`if (!handler) return void sendBoom(res, 404, jotMethodNotFound(op).message);`) by restoring the
previous `sendAmzError(res, ValidationException, …)`. Result: `not ok 14 - an unsigned request is
MISSING_AUTH_HEADER 401; an unmapped operation is the framework 404` and
`not ok 23 - every model-declared Jot operation maps to the served set or the framework 404, per
version` (24 pass / 2 fail). Restored → 26/26 pass.

## 6. Evidence standard

* **VERIFIED (observed through the archive MCP):** every file:line quoted above; both dependency
  versions of `lowerMethodName`; the framework 404 branch; the four SDK model files and their
  operation lists; the gateway's `MISSING_AUTH_HEADER`.
* **INFERRED:** that the end-of-life deployment ran the `@jibo/server` dispatcher exactly as pinned
  (no end-of-life binary was executed); that the merged robot/app builds emitted
  `Jot_20160512.<Op>` at runtime (only the archived test proves that literal).
* **UNKNOWN:** real-SDK SigV4 + TLS hop; the gateway→service hop bytes in production; whether an
  end-of-life gateway would route a `Jot_20160310.*` target to this service at all.
