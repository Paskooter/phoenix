# H-05 — Enforce proactive user settings

Status: candidate, VERIFIED at runtime.

## What was missing

`packages/gateway/src/proactive/proactiveTransaction.js` accepted every proactive
registration unconditionally — the settings filter was a comment
(`// settingsRules: the settings service is dead -> permissive (accept all).`) even though
the account service now hosts the Settings face (`packages/account/src/settingsFace.js`,
`settingsProviders.js`, `settingsTransport.js`).

## Pinned contract (source + docs)

- `pegasus@5c0a739` `packages/hub/src/proactive/tools/SettingsRulesChecker.ts:22-87` —
  `getDomainList` collects every `rule.skill`; `checkSettingsRules` returns `true` only when
  a PR has no rules, `false` on a null map, on a missing skill entry and on a missing key,
  otherwise `every(rules, evaluateMatchRule(rule.matchRule, rule.value, dataValue))`.
  Note the source's swapped value/data argument order; settings matchRules are EXACT/NOT
  only (`skillConfigValidation.js` `settingsMatches`), both symmetric, so it is unobservable.
- `packages/hub/src/utils/SettingsClient.ts:18-47` — one `POST` to `NET_settings` with
  `x-amz-credentials {id}` + `x-amz-target Settings_20160801.GetSettings`, body
  `{loopId, transId, skills, getView:false}`, response `[{skillId, data}]` mapped to a
  `Map<skillId, data>`.
- `packages/hub/src/utils/TransactionHelper.ts:20-26` — focused person → `runtime.loop.users`
  → `accountId`.
- `packages/hub/src/proactive/ProactiveTransactionHandler.ts:196-241` — one settings request
  before the per-skill filters; a fetch error is logged and the (empty) map makes every
  settings rule fail ("Continuing with selection, but settingsRules will fail").
- Captured reference request/response:
  `docs/parity/evidence/2026-09-05/reference/transactions.json:4228-4262`
  (`{"loopId":"fixture-loop","transId":"fixture-trans","skills":["report-skill"],"getView":false}`
  → `[{"skillId":"report-skill","data":{"weatherEnabled":{"value":true}}}]`).
- Report-skill's declared preference:
  `packages/gateway/resources/skills/pegasus-skills/report_skill_manifest.json` —
  `settingsRules: [{skill:"report-skill", key:"offerProactively", matchRule:"EXACT",
  value:{value:true}}]` and `settings.view` declares `offerProactively` with `default: true`.
- https://pvindex.org/confluence/display/SDK/Mobile-Settings-Lasso+support+for+Personal+Report+credentials
  — GetSettings response data example shows boolean switch values as `{value:true}`.

## Changes

| file | change |
| --- | --- |
| `packages/gateway/src/settingsClient.js` (new) | hub `SettingsClient` port |
| `packages/gateway/src/proactive/settingsRules.js` (new) | `SettingsRulesChecker` port |
| `packages/gateway/src/proactive/contextRules.js` | added `getAccountId` (TransactionHelper port) |
| `packages/gateway/src/proactive/proactiveTransaction.js` | one pre-fetch of the settings map; `checkSettingsRegistrations` replaces the permissive comment |
| `packages/gateway/src/index.js` | `settingsClient` component wired to `config.settingsURL` (NET_settings) |
| `packages/account/src/settingsProviders.js` | the synthesized local settings view carries the report manifest's declared `offerProactively` default |
| `docker-compose.yml` | hub `NET_settings=account:8080` (the settings peer, like `NET_parser`/`NET_history`/`NET_data`) |
| `packages/gateway/test/proactiveSettings.test.js` (new) | rule matrix + transport + live end-to-end |
| `packages/account/test/settingsHubTransport.test.js` | local view shape now includes the declared default node |

## Runtime proof

`restart-demo.mjs` spawns the real entrypoints (`packages/account/src/index.js`,
`packages/gateway/src/index.js`) as child processes against one persistent store file:

```
drive #1 (unset preference): frames=[PROACTIVE, ERROR] -> proactive_match=true skillID=report-skill
UpdateSettings offerProactively=false -> 200
drive #2 (opted out): frames=[PROACTIVE] -> proactive_match=false (no-action)
stopping account pid=638400 hub pid=638401
up: account pid=638418 hub pid=638419                     <-- ACTUAL RESTART
GetSettings after restart offerProactively={"value":false}
drive #3 (opted out, after restart): frames=[PROACTIVE] -> proactive_match=false (no-action)
UpdateSettings offerProactively=true -> 200
drive #4 (opted back in): frames=[PROACTIVE, ERROR] -> proactive_match=true skillID=report-skill
RESULT PASS
```

(The trailing `ERROR` frame is the report skill's own URL being unreachable in the demo —
the `PROACTIVE` match frame is written before the skill launch, so it is the observable gate.)

## Falsification

1. `prs = checkSettingsRegistrations(prs, skillSettingsMap);`
   → `prs = prs.filter(() => true);` — 4 tests failed, including
   `runtime: opting out stops real proactive routing (no match frame, no skill launch)`.
   Restored (sha256 `69dcff75618c30a26eee068cfc9285fd60073adcc2548a771885ca2013d3285f`), 17/17 green.
2. `valueDefinition.default = LOCAL_PERSON_DEFAULTS[key];`
   → `valueDefinition.default = false;` — 3 tests failed:
   `local Hub keeps the Account friendly-id prerequisite and local view shape`,
   `runtime: an enabled proactive preference routes the report-skill proactive over a real socket`,
   `runtime: opting out stops real proactive routing (no match frame, no skill launch)`.
   Restored, 23/23 green.

## UNKNOWN / INFERRED

- INFERRED: the gateway client's transport defaults. The pinned request headers
  (`content-type: application/json;charset=utf-8`, `x-amz-credentials`, `x-amz-target`) and
  body are verified against the captured reference request; the Node `fetch` implementation
  additionally sends its own `accept`/`accept-encoding`/`user-agent`/keep-alive defaults,
  which the Settings face does not read. The pinned axios defaults (`accept:
  application/json, text/plain, */*`, `user-agent: axios/0.17.1`) are not reproduced here.
- INFERRED: `transId` is taken from the socket's `x-jibo-transid` trace, the same value
  `ListenTransaction` materializes; the source reads `ws.jibo.transID`.
- UNKNOWN: no differential capture of the hub's own proactive transaction (the reference
  runner lists proactivity as an exclusion), so the end-to-end assertions rest on source +
  the captured client request and the live Phoenix services.
- UNKNOWN: whether an operator is expected to point `NET_settings` at the account service in
  a non-compose deployment; the demo sets it explicitly.
