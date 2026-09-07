# A-10 notification token and socket delivery candidate

Status: candidate, pending root review. This slice starts from main `df8b9bd3e84c16a02fd5f26e3f31f9ad7c10e7a5` in `/home/shell/work/phoenix/.parity/worktrees/a10-notification`, branch `codex/candidate-a10-notification-20260907`. It changes only the Classic notification store/socket implementation and its focused tests. No account producer, main worktree, robot, service, source, golden, comparator, or dependency changes were made.

## Implemented boundary

`packages/classic/src/notificationStore.js` is an atomic JSON-file store for source-shaped Token and Notification documents. `ETCO_classic_notificationFile` or the constructor `notificationFile` option selects the persistence file; the default is a host temporary file. Token issuance follows the pinned source controller: one token document is found by account ID, a new 64-byte random hex `tokenKey` is generated on each `NewRobotToken`, and `created`, `updated`, and `lastConnected` are retained. Notification records contain `_id`, `created`, `payload`, `skillId`, and `tokenId`; pending rows are ordered by `created`, capped at the source global limit of 100, and expired at 300 seconds.

`NotificationHub` keeps the live socket map in process memory but delegates all token and pending-row state to the durable store. It resolves the socket URL by `tokenKey`, marks connection state, retrieves pending rows on connect and on a 15-second source-style poll, sends complete notification documents, and removes a row only after the WebSocket `send` callback succeeds without an error. Throws, callback errors, and socket close leave the row pending for retry or reconnect. `enqueueNotification({ accountId, skillId, notification })` is the explicit account-ID API for the later Account LoopUpdated outbox consumer. Its default skill is `-1`, and the notification payload is preserved as a nested source payload.

The Classic AWS-JSON handler now returns the source-length token key. The existing `/notify` route remains a test/system seam and accepts an explicit `accountId`; it does not claim to be the source event bus or to verify that ID. The current LAN-trust header/device fallback remains documented as an open authentication/producer integration boundary.

## Source evidence and controls

The source files were read at these immutable revisions:

| Source | Revision | Relevant files and SHA-256 |
| --- | --- | --- |
| `jiborobot/srv-notification-ws` | `e42bfe01506a8febf3005ac536fda735bba49d0d` | `src/controllers/ctrl.ts` `d4780195b1be8e19eddb80e51e7dc09fb327542c50477a6954b99beeb8d010f1`; `src/event.handlers/loop.updated.handler.ts` `088d20c67db3bf4ecdec7861d1429c785915593895f4b482320fcedcedcfbf62`; `src/schemes/notification.ts` `61757c80be03e9f57915198da0f7ab38c41944d5892f73910583ece1563dbb66`; `src/schemes/token.ts` `84fd11225cc73b87037b9ceedb28c2fa131eff4d988832058a3b95783a91f3f4`. |
| `jiborobot/srv-entrypoint-socket-ws` | `5247ab9c02f6c984e4a7ab31b09577af63308436` | `src/socket-server.ts` `ae0d0de803358a98b688ca1204426012788ff4cc6e0c8b6614388f484ae6e771`; `src/clients/notification.client.ts` `18aa822d912960ae46cae521cc092326076819efefab04c4bf8e4a27ffb86aba`; `config/config.json` `4f312ed950bcba06c27c3f6ae48c23bdcf245e1e4afe1c73f36ce93a461679b1`. |
| `jiborobot/srv-jibo-server-client` | `155d20a8102960b2aeb89c197bdf04dc1f1fc344` | `apis/notification-2015-05-05.normal.json` `b935151cec00c31a56ad0e4e34ce878fccdde416afe557f62847a11931406155`. |

The exact retrieved source files and full source flow are retained in `.parity/reviews/a10-notification-20260907/source/`. The pinned TypeScript source controller and socket server were transpiled with the archived TypeScript 2.5.3 and executed under the pinned Node `v8.9.4` image `node:8.9.4-slim@sha256:8233daae003ba0ecba4e6d70cab8525c30a3f085935afc624a275892ebe23f7c`, using controlled in-memory Token/Notification models and a controlled socket client. These controls execute the original source classes while keeping Mongo/SNS/SQS outside the seam:

- `source-control/source-controller-node8.json`: source `Controller` token rotation, automatic token creation on delivery, account/token routing, nested payload and `skillId`, explicit removal, and connected/disconnected status. SHA-256 `e68a7a6f0ef5f7dcda5fe48fa9b1b338e205105c929ebe3367797ee7d2db8725`.
- `source-control/source-socket-server-node8.json`: source `SocketServer` pending ordering and send callback behavior. Successful callbacks remove rows; a callback error attempts delivery but does not call deletion. SHA-256 `9f8a4b08e9a3cef0af09e130679a368a03c1d8ea12d57c6e5f32f97ad2d57374`.
- Compiled source and exact runner hashes are in the same directory; the runner commands and stubs are retained for reproduction.

The source findings match the implementation boundary: `Controller.deliverNotification` creates a token/document and sends `SocketAcceptedForDelivery`; `SocketServer.deliver` calls `markAsDelivered` only in a no-error `send` callback; `startDelivery` polls active token IDs; the Notification schema uses a 300-second TTL and the controller caps pending rows at 100.

## Candidate tests

The candidate has local root workspace links resolving `@phoenix/account`, `@phoenix/classic`, `@phoenix/common`, and `@phoenix/contracts` to this worktree. No npm dependency or lockfile change was needed.

Focused command:

```text
node --test packages/classic/test/notification.test.js packages/classic/test/notificationDurability.test.js
```

Result: exit `0`, 10 tests passed. It covers source-shaped framing and `skillId: "-1"`, 128-character token keys, token rotation, account isolation, ordered/global-capped retrieval, 300-second expiry, send callback errors and synchronous send throws, status transitions, durable reopen, and an actual Classic HTTP/WebSocket restart delivery.

Classic regression command:

```text
node --test packages/classic/test/*.test.js
```

Result: exit `0`, 30 tests passed. The existing Classic service tests remain green with the source notification envelope.

## Remaining boundary

The Account service still does not publish a LoopUpdated event or maintain an outbox, and the Classic process still does not consume SNS/SQS or a notification-ws network service. This candidate therefore does not claim complete LoopUpdated parity. A later integration must pass the verified source account document ID to `enqueueNotification`; it must not derive that ID from the public access-key string or silently trust `x-amz-credentials`. The source `SocketConnected`/`SocketDisconnected` event bus and Mongo delivery service are also outside this local slice. Public notification authentication, TLS/DNS deployment, multiple-process shared-store locking, and robot hardware behavior remain open.
