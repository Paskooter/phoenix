# Skill API reference

The public third-party runtime is `phoenix-declarative-v1`. `phoenix-skill-v1` is its inspectable source-container format. All values below describe the validator used by the Skill Store, not a proposed JavaScript SDK.

**Who this is for:** skill authors and administrators checking exact runtime and review contracts.

## Manifest fields

| Field | Type and exact constraint |
| --- | --- |
| `schema` | Number `1` |
| `runtime` | String `phoenix-declarative-v1` |
| `appId` | `app-` plus 36 lowercase hexadecimal/hyphen characters; must match your registered listing |
| `version`, `minFirmware` | Plain `X.Y.Z`, nonnegative safe integer components, no leading zeros or prerelease suffix |
| `name` | Nonblank string, at most 60 characters |
| `description` | Nonblank string, at most 1200 characters |
| `releaseNotes` | String, at most 1200 characters; may be empty |
| `permissions` | Unique array containing `display`, optionally `speech`; no other values |
| `launchNames` | Up to 3 unique lowercase aliases, 3–40 letters/spaces, starting with a letter, no repeated or edge spaces; reserved commands refused |
| `examples` | Optional array, up to 4 nonblank strings, at most 300 characters each |
| `supportUrl`, `reportUrl` | Optional HTTPS URLs, at most 500 characters; no credentials |
| `startPage` | Existing page ID |
| `pages` | 1–16 page objects |

Text rejects control characters except tab, newline and carriage return. IDs of pages start with a lowercase letter and contain only lowercase letters, digits or hyphens, up to 32 characters. Unknown object fields are rejected. Reserved aliases include stop, cancel, settings, restore, home assistant, agent mode, sleep, wake up, main menu, volume and jibo; the validator remains authoritative.

## Cards and buttons

Every page has exactly `id`, `title`, `text`, `buttons`. Title is nonblank and at most 60 characters; text is at most 600 and may be empty. Buttons is an array of at most 3 objects, each with a nonblank `label` of at most 28 characters and an `action`.

```json
{"id":"welcome","title":"Welcome","text":"Choose a button.","buttons":[{"label":"Next","action":{"type":"show","page":"about"}},{"label":"Hello","action":{"type":"speak","text":"Hello, friend."}},{"label":"Close","action":{"type":"close"}}]}
```

| Action | Parameters | Result on the declarative manager |
| --- | --- | --- |
| `show` | `type: "show"`, `page: string` identifying an existing page | Changes the visible card |
| `speak` | `type: "speak"`, `text: string` (nonblank, at most 300 characters) | Requests speech; card stays open; requires `speech` |
| `close` | `type: "close"` only | Closes the skill |

Actions are data, not JavaScript functions; they have no Promise or return value available to the author. The example's **computer-only** `createPreview(skill)` returns an object with `start() → page`, `tap(index) → {speech, page}`, and `stop() → null`. It reports events rather than playing audio. `tap` throws for a missing button or unsupported action and refuses speech without permission.

## JavaScript API availability

These often-requested spellings are **not exported** by this runtime. Do not copy them into a submitted skill expecting execution.

| Proposed API | Current supported equivalent or boundary |
| --- | --- |
| `jibo.tts.say(text)` | Declarative `speak` action; no JS return value |
| `jibo.screen` / UI cards and buttons | `pages` plus `show` / `close` actions |
| `jibo.listen.ask(...)` | Unavailable; no microphone/listen permission |
| `jibo.lookAt(...)` | Unavailable; no motion permission |
| `jibo.anim.play(...)` | Unavailable; no animation permission |
| `jibo.storage` | Unavailable; no persistent storage permission |
| `jibo.http` | Unavailable; no network permission or domain allowlist in this runtime |
| `onStart`, `onUtterance`, `onStop` | No author callbacks; manager-owned lifecycle |

Native apps have a different trust and execution model. Operator review does not turn a declarative bundle into a native app, and publisher approval never authorizes arbitrary execution.

## Source bundle contract

`.phskill` is UTF-8 JSON, either a plain validated declarative package or this container:

```json
{"format":"phoenix-skill-v1","files":[{"path":"skill.json","text":"{...the complete declarative manifest...}"},{"path":"index.js","text":"// Optional computer-only preview source"}]}
```

`files` contains 1–5 unique entries with exactly `path` and `text`. Paths are fixed: `skill.json` (required), `index.js`, `test.mjs`, `README.md`, `LICENSE`. No nested paths, symlinks, external references or binary files. The full source container and canonical package each fit in the server's artifact limit (64 KiB by default). Strict JSON rejects duplicate keys and invalid UTF-8. JSON escaping expands source size; measure the serialized container's byte length rather than adding file lengths.

Declarative `.phskill` submission is API-only through the authenticated endpoint described below. The browser dashboard has no skill picker or skill ZIP packer; its upload form accepts theme packs only. A starter ZIP is a source download, not an installable skill or a supported browser submission. The skill kit (`tools/skill-kit/cli.mjs`) builds `.phnative` JavaScript apps for local test builds only; see the [native skill workflow](/developers/skills/workflow). JavaScript apps cannot be submitted to the Skill Store yet.

## Publisher HTTP API

All paths below start with `/api/skill-store`. Use your signed-in browser session, not operator credentials. Mutations must be same-origin. Responses are JSON; errors have `{error: "code"}` and an appropriate HTTP status. The SDK never contains private signing keys.

| Method and path | Input | Response |
| --- | --- | --- |
| `POST /publisher/apply` | `{displayName, reason}` | Publisher dashboard with pending identity |
| `GET /publisher` | None | Own publisher, apps, releases, submissions, feedback, limits and usage |
| `POST /publisher/apps` | `{name, description}` | New listing and server-assigned `appId` in `id` |
| `POST /publisher/skill-releases` | Raw `.phskill` bytes, `Content-Type: application/vnd.phoenix.skill` | Unsigned submission: `id`, `status`, descriptor, source/artifact/material SHA-256 |
| `POST /publisher/releases` | `{appId, package}` for legacy data-only JSON | Same exact-bundle review gate |
| `POST /publisher/theme-releases` | Raw `.phtheme`, `Content-Type: application/vnd.phoenix.menu-theme` | Validated theme submission |
| `PUT /publisher/listing` | `{appId, visibility: "public"}` after publication | Updated listing |

Check `GET /publisher` after every mutation. Pending bytes are not available in the public catalog or install APIs. Corrections use a higher version, including after rejection. Uploads are bounded and never retried automatically by this kit.

## Administrator review HTTP API

These routes require an active administrator account. The browser [Admin Review Queue](/apps#operator) uses the same service path as operator tooling.

| Method and path | Purpose |
| --- | --- |
| `GET /operator` | Publisher applications and limits |
| `POST /operator/publisher` | `{publisherId, status: "approved" or "rejected", reason}` |
| `GET /operator/submissions` | All submission summaries |
| `GET /operator/submissions/:id` | Manifest, permissions, scope, prior approval, changed fields and file hashes |
| `GET /operator/submissions/:id/file?path=skill.json` | Inert JSON response with file `text`, byte length and SHA-256; themes may return normalized PNG base64 |
| `GET /operator/submissions/:id/material?part=source` | Exact retained source download; `part=normalized` returns installable data |
| `POST /operator/submissions/:id/decision` | Exact material/state-pinned review decision |

A decision body contains `materialHash`, `expectedState` (`pending` or `approved`), `decision`, `reason` (1–1200 characters), `testSummary` (1–2400), `method` (`human` or `agent`) and a unique `requestId` (8–100 letters/digits/underscore/hyphen). Decisions are `approve`, `approve_publish`, `request_changes`, `reject`, and `publish` for already-approved bytes. Every decision records actor, method, time and hashes. State, roles, scope, version and artifact integrity are rechecked before signing. A stale review cannot publish changed bytes.

[Runnable complete example](/developers/skill-example) · [Publishing guide](/developers/publishing)
