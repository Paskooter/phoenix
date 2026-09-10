# Configuration, registry and service discovery

Task: **C-03 — Restore configuration, registry and service-discovery compatibility**.
This note records the reference contract, the exact rejection behavior, and the
optional Phoenix aliases, so an operator can tell reference inputs from Phoenix
extensions without reading the source.

Pinned source: original Hashbrown **pegasus `5c0a7390539663ba749d360de348a428c088505c`**
(links below use that commit). Documentation authority:
[Pegasus Environment Variables](https://pvindex.org/confluence/display/SER/Pegasus+Environment+Variables)
(server space, last modified 2018-02-27) and, for the unrelated 2016 platform
registry, [Service Registry](https://pvindex.org/confluence/display/ENG/Service+Registry).

## 1. Service discovery is `NET_*` + the deployment's own DNS

The Pegasus wiki is explicit: *"The hub should get URLs to other services (except
skills) from environment variables like `NET_parser`, `NET_history`, etc."*, and
*"`NET_xxx` variables are just the hostname (or hostname:port) where the service
`xxx` can be reached in this environment"* — cloud names resolve under the
environment-relative domain `.jibo.aws`, local names (`hub`, `redis`) come from
Docker DNS on the `pegasus-nw` network. There is **no runtime registry lookup**:
the 2016 [Service Registry](https://pvindex.org/confluence/display/ENG/Service+Registry)
(`/registry` GET/PUT/POST/DELETE with a `RegistrationRecord`) predates Pegasus and
is not referenced by any Pegasus package. Skills are discovered *indirectly*,
through the skills index file selected by `ETCO_hub_skillsConfig`.

Phoenix reproduces this by reading the same names and concatenating `http://`
(`packages/gateway/src/config.js`, `packages/common/src/env.js`).

## 2. Reference names, defaults and precedence

`HubConfigProvider.getConfig()` reads exactly these eight names, in this order, and
prefixes the three `NET_*` values with `http://`:

| Name | Reference default | Used as |
|---|---|---|
| `ETCO_hub_disableAuth` | `false` | `=== 'true'` |
| `ETCO_hub_skillsConfig` | `skills-local.json` | file name inside `resources/skills/` |
| `ETCO_hub_speechConfig` | `google-speech.json` | **unused** — the source keeps the name for a `@TODO` |
| `NET_parser` | `docker.for.mac.localhost:9005` | `parser.baseURL = 'http://' + value` |
| `NET_history` | `docker.for.mac.localhost:9006` | `history.baseURL = 'http://' + value` |
| `ETCO_hub_recordSpeechHistory` | `false` | `=== 'true'` |
| `ETCO_hub_recordLaunchHistory` | `true` | `=== 'true'` |
| `NET_settings` | `settings.jibo.aws` | `settings.baseURL = 'http://' + value` |

Source: `packages/hub/src/config/HubConfigProvider.ts:24-33` (defaults object) and
`:38-53` (`http://` concatenation, boolean `=== 'true'` comparisons). The unused
`ETCO_hub_speechConfig` is deliberate: `HubConfigProvider.ts:37` is
`// @TODO: read google-speech.json passed through ETCO_hub_speechConfig`.
Phoenix keeps the name in `HUB_ENV_DEFAULTS` so an unmodified reference environment
resolves identically (`packages/gateway/src/config.js:15-24`).

Precedence comes from the shared helper, not from each provider:

```
present, non-empty process.env value  →  that value
absent OR empty (''/undefined)        →  the declared default
declared default === null AND absent  →  throw "Required env variable '<key>' does not exist"
```

Source: `packages/utils/src/config/EnvVars.ts:11-19`; the docstring at `:8` states
*"Setting a default as null requires value be provided in process.env"*. Note the
consequence: an empty string is **not** "set" — it falls back to the default.
Phoenix implements the same walk in `packages/common/src/env.js:25-33`, and every
reference-derived provider consumes it (`packages/gateway/src/config.js:46`,
`packages/skills/src/report/env.js`).

`HubConfigProvider` itself declares **no** `null` default, so an empty environment
always loads; the required-variable path is reachable through the helper (and is
used by the lasso/history providers outside C-03's scope).

## 3. Registry loading: paths, version segment and URL composition

* The index is read from `<package root>/resources/skills/<ETCO_hub_skillsConfig>`
  (`HubConfigProvider.ts:16-19`, `:35`).
* Each entry's manifest is read from `<package root>/<configPath>` — `configPath` is
  relative to the **package root**, not to the index directory
  (`SkillUtils.ts:38-46`). In the reference tree the manifests therefore live in
  `packages/hub/{be-skills,external-skills,pegasus-skills}` while the three index
  files live in `packages/hub/resources/skills/`.
* `URL` is rebuilt from the index entry and the manifest, never taken from the
  manifest: `[clean(baseURL), clean(basePath), 'v1', 'main'].filter(Boolean).join('/')`,
  and `''` when `baseURL` is falsy (`SkillUtils.ts:48-56`). `cleanPathElement`
  strips one leading and one trailing `/` (`SkillUtils.ts:14-22`). The `v1` segment
  is literal, which is why `basePath: '//custom//'` yields `…/custom/v1/main`.
* The whole array is deep-frozen before it is returned (`SkillUtils.ts:35`), and
  `SkillConfigManager` freezes each entry again before validating it
  (`SkillConfigManager.ts:38-41`).

Phoenix keeps index + manifests **beside each other** under
`packages/gateway/resources/skills/` instead of at the package root, and exposes an
optional shared-skill-host adapter (§5). Both are packaging decisions; the index
files and all 21 manifests referenced by `skills-local.json` are byte-identical to
the pinned originals (verified by sha256 in §6).

The three bundled reference indexes and their first entry:

| Index | Skills | First entry |
|---|---|---|
| `skills-local.json` | 21 | `answer → http://docker.for.mac.localhost:9002/answer_skill/v1/main` |
| `skills-pegasus1.json` | 20 | `answer → http://gqa.jibo.aws/answer_skill/v1/main` |
| `skills-pegasus2.json` | 21 | `answer → http://gqa.jibo.aws/answer_skill/v1/main` |

## 4. Rejection is total: no partial registry, no fallback

Three validators run in the reference, and any throw aborts the load. Phoenix
reproduces the checks, their order and their messages.

| Stage | Invalid input | Reference error |
|---|---|---|
| index | `{}`, `{"skills":{}}` | `Hub service config missing required list parameter 'skills'` |
| index | `null` | `TypeError: Cannot read property 'skills' of null` |
| index | `{"skills":[null]}` | `TypeError: Cannot read property 'baseURL' of null` |
| index | `{"skills":[{}]}` or `configPath: 1` | `Skill service config missing required parameter 'configPath'` |
| index | malformed JSON | `Error when parsing '<path>': Unexpected end of JSON input` |
| manifest | missing file | `Error: ENOENT: no such file or directory, open '<path>'` (`code: ENOENT`) |
| manifest | `null` / `5` | `TypeError: Cannot set property 'URL' of null` / `Cannot create property 'URL' on number '5'` |
| manifest | `baseURL: 4` | `TypeError: pathElement.startsWith is not a function` |
| skill | no `id` | `Skill entry missing or has invalid ID string` |
| skill | `URL` missing | `URL missing: <id>` |
| skill | `URL: ''` and not `onRobot` | `Need to either be 'onRobot: true' or have URL: <id>` |
| skill | `intents` not an array | `Invalid intent list: undefined` |
| skill | bad `settings.view` | `Error validating manifest settings, Error: "type" must be non-empty string…: <id>` |
| skill | any other `SkillConfigValidator` rule | the same message the reference throws (102 cases) |

Sources: `packages/hub/src/config/validation/ConfigFileValidator.ts:10-29`,
`packages/hub/src/config/validation/SkillConfigValidator.ts:9-…`,
`packages/hub/src/config/validation/ManifestSettingViewValidator.ts`. Two details
that are easy to "fix" by accident and must not be:

* `validateBaseServiceConfig` **discards** the `HTTP_REGEX` result
  (`ConfigFileValidator.ts:10-14`), so a non-http `baseURL` is *not* rejected.
* A missing manifest fails the entire load; the reference does not return the
  manifests that did resolve (`SkillUtils.ts:32-35` uses `Promise.all`).
* `URL` is always recomputed from the index entry, so a `URL` written in the
  manifest is overwritten, and a manifest with no index `baseURL` loads with
  `URL: ''` (and is then rejected by `SkillConfigValidator` unless `onRobot`).

At the executable boundary the rejection reaches the shared service runner: no
setup record is logged (the reference logs *after* `getConfig()` resolves,
`cli/start.ts:28-36`) and the process exits **1** after the source five-second
flush window (`packages/utils/common/run-service.js:16-30`).

## 5. Optional Phoenix aliases (deployment extensions)

An **unmodified reference environment never uses any of these**; each is consulted
only when the corresponding reference input is absent, and each is documented in
the code that reads it.

| Alias | Reference name | Rule |
|---|---|---|
| `ETCO_hub_parserUrl` | `NET_parser` | used only when `NET_parser` is unset; may carry a full `http(s)://` URL (`config.js:47-53`) |
| `ETCO_hub_historyUrl` | `NET_history` | same rule |
| `NET_skills` / `ETCO_hub_skillsUrl` | — | selects the Phoenix `skills-phoenix.json` single-host profile and composes `…/v1/<id>/main`; ignored when `ETCO_hub_skillsConfig` is set (`config.js:56-61`) |
| `PORT` | `ETCO_server_port` | last-resort port; argv and `ETCO_server_port` win (`packages/common/src/cli.js:47-48`) |
| `NET_data` | `NET_lasso` | report/lasso peer alias; source name wins (`packages/skills/src/report/env.js:38-43`) |
| `ETCO_report_prefsFromConfig` | `prefsFromConfig` | source name wins, including its empty-value fallback (`packages/skills/src/report/settingsClient.js:36`) |
| `ETCO_data_credentialsFile` | — | Phoenix-only data-service credential path |
| `PHOENIX_ENV_FILE` | — | `.env` file location; unset = no `.env` |
| `ETCO_hub_accountUrl`, `ETCO_hub_accountVerifyTimeoutMs`, `ETCO_server_asrProvider`, `ETCO_server_hubTokenSecret` | — | Phoenix/companion-cloud extensions with no reference counterpart |

Reference-name precedence is asserted directly in
`packages/gateway/test/referenceEnv.test.js` (reference name wins, alias loses) and
in `packages/common/test/cli.test.js`.

## 6. Reproducing the evidence

```
node --test packages/gateway/test/configRejection.runtime.test.js   # invalid config rejection, incl. a spawned process
node --test packages/gateway/test/referenceEnv.test.js              # gateway under a reference-only environment
node --test packages/gateway/test/registry.test.js                  # 161-row differential vs the retained original capture
npm test                                                            # unit + parity:check + parity:gate
```

The retained reference observation is
`packages/gateway/test/fixtures/registry-original.json.gz` (original Node
**v8.9.4**, sha256 of the gunzipped bytes `e36cfe66…b591b`), replayed by
`scripts/parity-reference/gateway-registry-candidate.mjs`.
`docs/parity/evidence/2026-09-10/c03-config-cli/registry-differential.json` records
the last full comparison: **161/161 rows equal, 0 differences**
(102 validations, 28 registries, 20 HTTP, 8 config, 1 original registry).
`docs/parity/evidence/2026-09-10/c03-config-cli/registry-negative-controls.json`
records 11/11 deliberate comparator mutations rejected.

## 7. Known intentional deviations

1. **Per-service default port.** The reference literal default is `'8080'` for every
   service (`cli/start.ts:13`, `utils/common/run-service.js`). Phoenix's executable
   fallback is `DefaultPort.gateway|nlu|data|history|skills`
   (`packages/contracts/src/constants.js:136-145`, gateway `7010`) so several
   services can run side by side; `ETCO_server_port`, `--port/-p` and `PORT` all
   take precedence, so any reference or compose deployment is unaffected. A bare
   local `node packages/gateway/src/index.js` binds 7010, not 8080.
2. **Manifest location.** Phoenix reads manifests relative to the index directory
   (`registry.js:31-33`) instead of the package root; the reference files themselves
   are unchanged.
3. **Shared skill host.** `NET_skills` collapses the per-skill URLs onto one host
   (`…/v1/<id>/main`); the reference index composition is used whenever
   `ETCO_hub_skillsConfig` is set.

These are deployment adapters, not missing reference behavior; they are listed here
rather than silently assumed.
