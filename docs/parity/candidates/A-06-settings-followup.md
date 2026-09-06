# A-06 Settings provider follow-up

Status: candidate, awaiting root review. Full A-06 provider and application parity remains open.

Frozen candidate: `8a310f563c05146d7a93b5e24cdf4b47ad4a7fd2`, in the isolated `.parity/worktrees/a06-settings-followup` repository. Its implementation is not integrated into main. The following results are agent-reported pending root acceptance.

This follow-up starts from the prior A-06 candidate history through `4185e2170cc108083b706b375a6ba819b58c4575`. It wires the recovered Settings controller path into the normal Account service construction and adds source-shaped peer clients. An explicit `settingsProviders` object remains available only as a test seam; production construction calls `createSettingsProviders({ store })` and uses the same `getWithProviders` traversal.

The default graph selects configured Phoenix or original-compatible HTTP peers from these environment aliases:

| source client | aliases | wire exercised |
| --- | --- | --- |
| Account | `NET_settings_account`, `NET_account` | `GET /isLoopMember?accountId&loopId`, `GET /loopPopulated?loopId` |
| Hub | `NET_settings_hub`, `NET_hub` | `GET /v1/skills/settings/:robotFriendlyId`, `X-JIBO-transID` |
| Person | `NET_settings_person`, `NET_person` | AWS JSON `POST /`, `Person_20160801.GetAccountProperties/GetLoopProperties`, `x-amz-credentials` |
| Lasso | `NET_settings_lasso`, `NET_lasso`, `NET_data` | `GET /v1/credential` with source query keys and `X-JIBO-transID` |

When a peer is unset, the graph uses an explicit Account store adapter. The local Hub adapter builds a report-skill view from persisted settings, the local Person adapter reads account settings and has no loop-property collection, and the local Lasso adapter reads persisted credential-shaped values. `configuration.missingPeers` records every unset peer. This keeps the source provider algorithm in one path while making the storage substitutions visible; it is not evidence that Phoenix has the original Hub, Person, Loop, or Lasso providers. `NET_classic` is deliberately not treated as a Person alias because the Classic front door has not been proven equivalent to the original Person boundary.

The Account service now exposes the two internal response fields needed by the source Account client (`{result}` for membership and `{id,robotFriendlyId}` for populated loops). Settings success and error responses remove Express's `x-powered-by` and `keep-alive` headers and use the Hapi-compatible JSON framing used by the source route wrapper. Provider service groups run concurrently as in the source `Promise.all`; connectable OAuth parents are updated from Lasso results, null replies are retained, malformed nested views remain generic source errors, and Node 8 null-map diagnostics are preserved for peer replies.

## Evidence

The pinned original differential uses `jiborobot/srv-settings-ws@0d37e1fd2f4fca40538fb470194a3c5daf2c9830`, `@jibo/server@4.0.12`, Hapi 16.4.1/Joi 10.5.2/Boom 5.1.0, TypeScript 2.5.3, and the digest-pinned `node:8.9.4-slim` image recorded in the private evidence. It instantiates the actual `Server.newHttpServer` wrapper and Hapi `server.inject`; a separate private TCP probe also starts that wrapper and uses `node:http`. The probes do not exercise `App.start` registry/bootstrap. Account, Hub, Person, and Lasso are controlled named seams so the matrix isolates route/controller behavior.

The expanded matrix is in the private artifacts under `/home/shell/work/phoenix/.parity/reviews/a06-settings-followup`:

- `original-server-node8.expanded.clean.json` and `candidate-node22.expanded.clean.json` contain 51 cases, including connectable OAuth, null Lasso/Person replies, malformed nested views, schema coercion, provider ordering, and precedence cases.
- `comparison.expanded.json` reports status, textual JSON, recursive structural JSON, provider-call, and normalized-header equality.
- `probes/original-settings-server.cjs`, `probes/original-settings-tcp.cjs`, `probes/candidate-settings.mjs`, and `probes/compare.cjs` reproduce the run. The TCP probe returned 200 with `vary`, `content-type`, `cache-control`, `content-length`, `date`, and `connection` only; it emitted no `x-powered-by` or `keep-alive` header. The earlier 47-case artifacts remain beside them as historical evidence.

The expanded comparison is 51/51 for status, JSON text, decoded structure, provider-call trace, and normalized headers. Both sides are 24×200, 3×403, 17×422, and 7×500. Header equality omits transport-generated date/content-length/connection fields; source Hapi and candidate Settings responses otherwise match, including absence of `x-powered-by`.

Focused checks in this sparse worktree are:

```text
node --test packages/account/test/settingsProviders.test.js
node --test --test-skip-pattern='END-TO-END' packages/account/test/settings.test.js
```

The provider test is 2/2. The focused Settings selection is 10/10. Running the entire Settings file reaches 11/12: the only failure is the intentionally absent sparse-checkout dependency `packages/skills/src/reportSkill.js` in the end-to-end test; it is not counted as product acceptance. `node --check` on changed JavaScript and `git diff --check` pass.

## Limits for root integration

No live Hub, Person, Loop-property store, Lasso, robot, credentials, service registry, App bootstrap, source TCP/TLS listener, or production peer graph was used. The local adapters are bounded storage seams and do not establish provider persistence, OAuth flows, Update/Delete parity, network retry/timeout behavior, or full Hub manifest coverage. `NET_data` is supported as a Lasso-compatible deployment alias only when that endpoint actually implements the source Lasso contract. Root should verify the configured peer graph and real membership/manifest/property/credential responses in the lead integration environment. This candidate does not close A-06.
