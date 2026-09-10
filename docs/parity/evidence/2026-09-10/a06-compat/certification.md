# A-06 — Settings data/view/ownership certification (runtime)

Date: 2026-09-10. Worktree: `.parity/worktrees/w6-a06` (branch `w6/a06`, base `8bca4a8`).

Scope: re-derive the Settings contract from pinned source, then drive the **running**
account Settings service (robot face) and the internal source-contract listener through
all four operations, per-account/loop ownership, and a real process restart.

## Pinned reference re-derivation

| Contract element | Pinned source | URL |
| --- | --- | --- |
| Four operations + shapes | `jiborobot/srv-jibo-server-client` `apis/settings-2017-12-19.normal.json` (`GetSettings`, `GetDataForSettings`, `UpdateSettings`, `DeleteSettings`) | https://pvindex.org/gitea/jiborobot/srv-jibo-server-client/src/branch/master/apis/settings-2017-12-19.normal.json |
| Handler mapping + Joi | `jiborobot/srv-settings-ws` `src/handlers/settings.handler.ts` (`loopId` required string; `GetDataForSettings.settings` required array min 1; mutation `data` required object) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/handlers/settings.handler.ts |
| Ownership + view/skill filtering | `src/controllers/settings.ctrl.ts` (`checkUserBelongsToLoop` before hub; `skills.indexOf` filter; `getView === false` strips view) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/controllers/settings.ctrl.ts |
| Get data graph, defaults, per-key errors | `src/controllers/get.ctrl.ts` | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/controllers/get.ctrl.ts |
| Partial update routing / delete + wildcard | `src/controllers/update.ctrl.ts`, `src/controllers/delete.ctrl.ts` | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/controllers/delete.ctrl.ts |
| Account ownership seam | `src/clients/account.ts` (`GET /isLoopMember` → `.result`, `GET /loopPopulated` → `.robotFriendlyId`) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/clients/account.ts |
| Hub manifest seam | `src/clients/hub.ts` (`GET /v1/skills/settings/{friendlyId}`, header `X-JIBO-transID`) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/clients/hub.ts |
| Person seam | `src/clients/person.ts` (`Person_20160801.*`, `x-amz-credentials`) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/clients/person.ts |
| Lasso seam | `src/clients/lasso.ts` (`/v1/credential`, asserts `credentialExists` present) | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/src/clients/lasso.ts |
| Endpoints + defaults (`getView` = TRUE) | `readme.md` | https://pvindex.org/gitea/jiborobot/srv-settings-ws/src/branch/master/readme.md |
| Report consumer variant (string skills, getView:false, `Settings_20160801`) | `jiboV2/pegasus` `packages/report-skill/src/SettingsClient.ts` | https://pvindex.org/gitea/jiboV2/pegasus/src/branch/master/packages/report-skill/src/SettingsClient.ts |
| Hub/proactive consumer variant (array skills, getView:false) | `jiboV2/pegasus` `packages/hub/src/utils/SettingsClient.ts` | https://pvindex.org/gitea/jiboV2/pegasus/src/branch/master/packages/hub/src/utils/SettingsClient.ts |

Phoenix anchors: `packages/account/src/settingsFace.js:391` (`settingsAwsDispatch`),
`:273` (`getWithProviders`), `:364-371` (result build + getView strip), `:562`
(`validateMutationRequest`), `:634` (`updateWithProviders`), `:749` (`deleteWithProviders`),
`:445`/`:483`/`:530` (internal listener + service); `packages/account/src/settingsProviders.js:946`
(`checkUserBelongsToLoop`), `:982` (`getSkillConfigs`), `:1005`/`:1009`/`:1013`/`:1017`
(person/loop get+set); `packages/account/src/robotFace.js:139` (Settings dispatch);
`packages/account/src/index.js:307` (peer seams), `:310` (portal).

All response fields Phoenix emits are declared in the pinned model's output shapes
(`SkillSettings{skillId,view,data,errors}`, `UpdateSettingsResponse.data`,
`DeleteSettingsResponse.data`); the generated aws-sdk client would strip only undeclared
fields, so the observed shapes are the whole contract.

## VERIFIED (observed) — live probes

Started `createAccountService` (robot face) + `createSettingsInternalService` on an
ephemeral store; 21 request/response observations:

- **GetSettings** (`Settings_20171219` and `Settings_20160801`): 200; report string
  selector and hub array selector both accepted; `skills` filter excludes unknown skills
  (`[]`); omitted `getView` returns `view` (default TRUE), `getView:false` strips it.
- **GetDataForSettings**: 200 with caller-supplied controller-derived view for the
  non-report skill `answer-skill`; a `valueDefinition.default` is materialised when the
  stored value is absent; missing `settings` → 422 Joi `child "settings" ... is required`.
- **UpdateSettings / DeleteSettings** (deployed robot face + internal source listener):
  200 with `{data:{key:{skillId,dataService,value}}}` / `{data:{key:{...,deleted}}}`
  shapes; internal `UpdateSettings` responded `{weatherEnabled:{...,"value":{"value":true}}}`,
  internal `DeleteSettings` responded `{"deleted":true}`.
- **Ownership**: two ACCEPTED members of one loop read their own persisted settings; an
  account that is not an ACCEPTED member gets 403
  `{statusCode:403,error:"Forbidden",message:"Only loop member can query loop properties",code:"LOOP_MEMBER_ONLY"}`.
- **Malformed/unknown**: unknown data service → 422 `code:"UNKNOWN_DATA_SERVICE"`;
  malformed view (`childViews:null`) → 500 generic envelope.
- **Durability across a real restart**: after closing the listener, constructing a new
  `Store` on the same file and a new service, `GetSettings` still returned the persisted
  `weatherEnabled {value:0}`, `newsEnabled {value:1}`, `homeLocation {lat:42.36,lng:-71.06}`.

## Falsification (concrete)

Broke one full code line in `packages/account/src/settingsProviders.js` (the membership
predicate `checkUserBelongsToLoop` uses):

```
        && loop.members.some((item) => item.accountId === context.userId && isAcceptedStatus(item.status));
```
→
```
        && loop.members.some(() => true);
```

Result: `node --test packages/account/test/settingsCompatibility.test.js` →
`not ok 2 - A-06 runtime: per-account/loop ownership and malformed/unknown settings`,
`AssertionError expected: 403 actual: 200`. Restored the exact line → all 3 tests green.

## Residual / not in this slice

- Live OAuth exchange, real Mongo, deployed DNS/TLS and physical-robot acceptance are not
  provisionable here (accounted in tasks.json A-06 as open).
- The proactive SettingsRulesChecker filter is H-05; A-06 supplies/validates the served
  Settings variants it consumes.
