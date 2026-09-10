# A-19 — versioned Jot messaging contract: implementation candidate

Worktree: `.parity/worktrees/w5-a19` (branch `w5/a19`), based on `194b81a`.
Track: classic · priority P1 · status: **candidate implementation, unverified by the lead.**
Acceptance criteria 1–4 are addressed; every operation is SERVED at runtime and state is durable
across a SIGNALLED process restart. Nothing here closes the task.

## Pins actually read (Jibo archive MCP)

| id | repository | revision | files |
|---|---|---|---|
| later handler | `server/jot-ws` | `9a725d3ed8d991aa840131f5ef98c630df2fdf4e` | `src/handlers/message.handler.js`, `src/controllers/message.ctrl.js`, `src/errors/message.js`, `src/schemes/message.js`, `src/index.js`, `src/bus.js`, `src/clients/{account,media}.client.js` |
| archived runtime test | `jiborobot/srv-jot-ws-archived` | `4432ac5d017ae1971a447f42e7a4b29da7eb2e58` | `archive/message.spec.js`, `archive/server.js`, `src/handlers/message.handler.js`, `src/controllers/message.ctrl.js`, `src/routes/route.js`, `src/errors/message.js`, `src/schemes/message.js`, `src/clients/{account,media}.client.js`, `src/event.handlers/loop.created.handler.js` |
| last wire model | `jiborobot/srv-jibo-server-client` | `b2da11bc626ab9c39aeb36449470ce10fba256ee` | `apis/jot-2016-05-12.normal.json` (metadata + every shape) |
| event contract | `server/message-bus` | default (HEAD) | `package.json`, `src/events/jotEvents.js`, `src/events/base.js`, `src/events/index.js` |
| media hop | `jiborobot/srv-media-ws` | `62fab24e3927f6d7eb340d43d8b3367959da254e` | `src/routes/media.route.js`, `src/controllers/media.ctrl.js` (`get`, `expand`) |
| historical models | `jiborobot/srv-jibo-server-client` | `4c68f963…`, `1b26ad78…`, `39f53698…`, `bfab9a6d…`, `b2da11bc…` | `apis/jot-2016-0{1-26,3-10,5-10,5-12}.normal.json` — re-derived counts below match `docs/parity/evidence/2026-09-06/classic-contract-discovery/historical-models.json` |

## 1. The versioned pairs and the prefix conflict (acceptance 1)

**24 versioned pairs, re-derived from the five recovered models** (`(targetPrefix, operation)`):
`Jot_20160126` = CreateMessage, RemoveMessage, ListIncomingMessages, ListSentMessages,
MarkDelivered, MarkSeen, ListMessages, MarkRead, MarkLoopRead, NumberOfUnreadMessagesInLoops (10).
`Jot_20160310` = CreatePart, CreateMessage, UpdateMessage, RemoveMessage, GetMessages,
ListIncomingMessages, ListSentMessages, MarkDelivered, MarkAllDelivered, MarkSeen, MarkAllSeen,
ListMessages, ListInbox, ListSent (14). This matches the A-01 map exactly.

**Which are required.** Only the LAST model era has a recovered handler:
`server/jot-ws@9a725d3 src/handlers/message.handler.js:11-16` maps exactly five operations
(`createMessage`, `listMessages`, `markRead`, `markLoopRead`, `numberOfUnreadMessagesInLoops`).
The archived pin is the same five (`srv-jot-ws-archived src/handlers/message.handler.js:11-16`).
The other 19 party-era pairs have no recovered matching-era handler, so they are **not invented**:
an unmapped Jot operation answers `ValidationException` 400, the same answer every other graduated
classic service gives for an operation it does not implement.

**Prefix conflict resolved.** The 2016-05-12 model's metadata declares `targetPrefix: "Jot_20160126"`
(`apis/jot-2016-05-12.normal.json`), while the only recovered runtime exercise sends the literal
`X-Amz-Target: Jot_20160512.<Op>` (`archive/message.spec.js:65, 91, 109, 125, 144, 160, 180, 198,
221`). The source's `@jibo/server` App dispatched handler methods by the operation name after the
dot, not by the prefix (`src/index.js` registers one `Handler` with its own `mapping`), so both
prefixes are the same deployed service. Phoenix registers `/^jot/i` and dispatches the five
loop-era operations by name, and records both observed prefixes in `JOT_TARGET_PREFIXES`.
Explicit consequence: `Jot_20160126.CreateMessage` is served the loop-era shape, because the model
that declares that prefix **is** the 2016-05-12 shape; `Jot_20160310.CreatePart` is not served.

**The direct bulk route** (`srv-jot-ws-archived src/routes/route.js`) is `POST
/numberOfUnreadMessagesBulk`, an HTTP path with no X-Amz-Target and no credentials decorator. It is
ported verbatim: an array body of `{accountId, loopIds}`, answering one
`{count, accountId, loopIds}` per entry (the archived controller's shape,
`srv-jot-ws-archived src/controllers/message.ctrl.js:169-177`), 400 on a non-array body
(Hapi `Joi.array().items(Joi.object()).required()`), 400 on a controller failure (`Boom.wrap(err,400)`).

## 2. Auth, membership, impersonation, validation, precedence (acceptance 2)

**Two auth layers.** Gateway: `srv-security-gw@43a692fe` lists no Jot target in
`unauthorizedMethods`, and `unsignedMethods` is empty, so every Jot call required verified AWS4
SigV4 at the gateway — recorded, not re-implemented (Phoenix runs no gateway). Handler:
`@parseCredentials({})` is the OUTERMOST decorator on every mapped method
(`message.handler.js:20, 51, 67, 81, 94`), so the credential gate precedes payload validation;
Phoenix mirrors that order and answers `MISSING_AUTH_HEADER` 401 when no identity is present.

**Error precedence (source, reproduced).** `create` calls `getImpersonatedAccount` as its first
statement (`message.ctrl.js:34`) and only then checks content/parts (`message.ctrl.js:35-37`): a
non-member posting no content still gets `JOT_MUST_BE_LOOP_MEMBER` 403, not
`JOT_CONTENT_OR_PARTS_REQUIRED` 422. `getImpersonatedAccount` (`message.ctrl.js:18-31`) filters
members to `status === 'accepted'`, lets only `loop.robot` impersonate
(`JOT_ROBOT_CAN_IMPERSONATE` 403, line 23), and re-checks membership on the impersonated account
(`JOT_MUST_BE_LOOP_MEMBER`, line 29).

**Member id conflict.** The later controller reads `member.memberId`; the archived test's own
fixture and the Account service's populated loop carry `accountId` (and `memberId`). Both are
checked, so neither pin is contradicted.

**Two documented source holes are reproduced, not closed.** `markRead` has an explicit
`//TODO: check accountId can impersonate` (`srv-jot-ws-archived src/controllers/message.ctrl.js:134`)
and does no membership check at all; and `numberOfUnreadMessagesInLoops`
(`server/jot-ws src/controllers/message.ctrl.js:162-167`) is a raw
`Message.count({read:{$ne}, loopId:{$in}})` with no membership check either, so a caller can count
unread in a loop it cannot list. Both are asserted in `packages/classic/test/jot.test.js`.

**Error catalogue** verbatim (`src/errors/message.js`): 403 `JOT_MUST_BE_LOOP_MEMBER`,
403 `JOT_ROBOT_CAN_IMPERSONATE`, 422 `JOT_CONTENT_OR_PARTS_REQUIRED`, 503
`ACCOUNT_SERVICE_UNAVAILABLE`, 503 `MEDIA_SERVICE_UNAVAILABLE`.

## 3. create/list/read semantics, pagination, media, events (acceptance 3)

* `create` → `Message.create({sender, loopId, tags, content, read:[<sender>], parts})`, toJSON
  (`_id -> id`, `created -> epoch ms`), then `populateParts`. The `read:[sender]` seed is why the
  sender always observes `isRead:true` and the receiver `false`.
* `list` → `find({loopId, created>$gt/$lt}).sort({created: sortOrder}).limit(50)`, then reverse when
  the pass was descending, so the answered page is always ascending. `after`/`before` are
  exclusive. `skip` is read by the handler but ignored by the controller (source behaviour).
* `markRead` adds the caller to each id's `read` set (`$addToSet`, idempotent); `markLoopRead` does
  the same for the whole loop and re-runs `getImpersonatedAccount` twice, as written.
* **Media population** reproduces `MediaClient.getMedia` + `srv-media-ws media.ctrl.js get`
  (`isDeleted !== true`, `path` or `thumbs.path`, thumb expansion, `ignoreOwnership: true` → rows
  outside the account's loops are dropped, never thrown). The entrypoint wires it to the in-process
  Media store (`mediaStoreClient`); the parts then carry the declared `url/type/reference/accountId/
  loopId/created` (+ `isDeleted`, which the archived revision also copied). A path with no media row
  keeps `path` only — never a fabricated url.
* **Event side effect.** `create` emits `JotMessageCreated` with the exact `server/message-bus`
  payload: `{messageId, senderId, loopId, tags, content, eventKey:'JotMessageCreated'}`
  (`src/events/base.js` stamps `payload.eventKey = constructor.name`; `jotEvents.js` declares the
  other members). Kafka is gone, so the sink is an injectable seam whose default records the payload
  durably and logs; a downstream push-notification consumer is NOT reconstructed.

## 4. Durability, retry, isolation, journeys (acceptance 4)

State is one atomically replaced JSON file per store (`JotStore`), written synchronously on every
mutation, holding the `Message` collection plus the event ledger. Proven at the **process** level:
`restart-process.mjs` writes over the AWS-JSON wire with the archived test's `Jot_20160512` prefix,
SIGKILLs the child (`kill -9`, no graceful shutdown), starts a brand-new process over the same file
and re-reads — **12/12 values survived**, including the ids, the per-account read set, the unread
count, cross-loop isolation and both prefixes. Retry behaviour = the source's non-transactional
order: `Message.create` + event commit BEFORE `populateParts`, so a failing media hop answers 503
with the message already persisted (asserted).

## Evidence and commands

```
node docs/parity/evidence/2026-09-10/a19-jot/probe.mjs            # 20/20 runtime observations
node docs/parity/evidence/2026-09-10/a19-jot/restart-process.mjs  # 12/12 survived SIGKILL restart
node --test packages/classic/test/jot.test.js                     # 21/21
npm test                                                          # exit 0
```

Full `npm test`: `# tests 1449`, `# pass 1442`, `# fail 0`, `# skipped 7`, `# suites 7`,
`# duration_ms 43932.9`; `parity:check` clean; `parity:gate`
`{"result": "match", "cases": 43, "differences": 0, "invariants": 0, "coverageGaps": 0}`.
Jot subtests 359–379 in the aggregate run.

## Falsification (required)

Broke one full code line in `packages/classic/src/jot.js`:

```
    if (!isMember) throw fail('JOT_MUST_BE_LOOP_MEMBER');   ->   if (false) throw fail('JOT_MUST_BE_LOOP_MEMBER');
```

The anchor test **`create refuses a non-member and a not-yet-accepted invitee (JOT_MUST_BE_LOOP_MEMBER 403)`**
failed (`200 !== 403`), along with `messages never leak across loops`,
`membership precedes the content-or-parts check (403 before 422)` and
`only the loop robot may impersonate; a member may not (JOT_ROBOT_CAN_IMPERSONATE 403)`
(17/21). The line was restored byte-identically and the file went 21/21 green again.

## VERIFIED (observed)

* All five operations are SERVED at runtime under `Jot_20160126` and `Jot_20160512`
  (`live-probe.json`, observations 1–5 and 6–10).
* `POST /numberOfUnreadMessagesBulk` is SERVED and answers the archived controller's triples.
* Status codes and error codes: 403 membership, 403 impersonation, 422 content-or-parts, 400
  `ValidationException` (validation + unknown op), 401 `MISSING_AUTH_HEADER`, 503 account, 503 media.
* Membership precedes content validation (403 before 422).
* The created message's wire members are exactly the declared set; `isRead` is per caller.
* Pagination: exclusive `after`/`before`, 50-row cap taking the NEWEST 50 and answering ascending.
* Cross-loop isolation on list; the two documented count/read membership holes.
* Media population from `getMedia`; no media row → path only.
* `JotMessageCreated` payload byte-for-byte as `server/message-bus` declares it.
* Durability across an in-process reopen and a real SIGKILL/new-process restart.
* `stubRegistrations()` is still empty and the `Jot*` prefix now reaches the real handler.

## INFERRED

* `GET <account>/loop?loopId=` is the Account hop shape Jot reads (the archived test stubs
  `AccountClient.get` to return `{robot, members:[{accountId,status}]}`; the Account store's
  `populateLoop` returns exactly `{robot, members:[{memberId, accountId, status}], …}`). The
  `account` seam is injectable and, with none wired, the gates are skipped (LAN trust).
* A Jot loop that the account service cannot resolve is answered `ACCOUNT_SERVICE_UNAVAILABLE` 503
  (the source turned an untyped account-hop failure into a rejection; the typed 404 path was not
  recovered with a message).
* Equal-millisecond rows keep insertion order via a monotonic `seq` tiebreaker (MongoDB's sort has
  no documented stability guarantee; the source test used distinct timestamps).

## UNKNOWN

* The deployed prefix is unresolvable from the archive: the model says `Jot_20160126`, the archived
  test says `Jot_20160512`. Both are accepted; which one a real robot/app sent at end-of-life is not
  recoverable here (`denominator.prefixAmbiguity` remains open).
* Whether the party-era contracts (the other 19 pairs, including `CreatePart`, `GetMessages`,
  `UpdateMessage`, `MarkAllDelivered`, `MarkAllSeen`, `ListInbox`, `ListSent`) were ever served
  alongside the loop-era five: no matching-era handler was recovered, so they are not served.
* The Kafka fan-out of `JotMessageCreated` (a downstream consumer that push-notifies a new jot, per
  `/confluence/display/MOB/Push+notifications+detailed+description`) is not reconstructed.
* Whether `Jot_20160310.CreateMessage` (party era, `parts`+`recipients`) ever coexisted with the
  later `CreateMessage` (`loopId`+`content`); a party-era call now answers 400 ValidationException.

## DIVERGENCE candidates (for DIVERGENCES.md — not written here)

1. Unknown payload keys are ignored; the pinned handlers used Joi, whose object schemas reject
   unknown keys by default. The declared members are validated; extra members are not.
2. The Media hop is served in-process (`mediaStoreClient`) rather than over
   `POST http://<media>/getMedia`; the loop filter is omitted when no loops source is wired.
3. Kafka delivery is a durable local ledger, not a broker round-trip.
4. Impersonation/membership gates are skipped when no `account` seam is wired (LAN trust), matching
   the posture of Media/Person/Backup — the impersonation substitution is still applied.
