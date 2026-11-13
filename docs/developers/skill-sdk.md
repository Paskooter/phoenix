# Skill SDK: build a first skill

Build a touchscreen skill with cards, buttons and speech. Start with a working example, check it locally, then submit the exact bundle to the Skill Store.

**Who this is for:** independent developers. You need Node.js 20 or later for the authoring tools; you do not need operator access or signing keys.

## Choose the right kind

| Build | Package | What runs on Jibo |
| --- | --- | --- |
| Touchscreen skill | `.phskill` | Validated pages and actions in `phoenix-declarative-v1` |
| Menu theme | `.phtheme` | Images, colours and bounded layout settings; no code |
| Native JavaScript app | Separate native format | Not admitted through third-party skill uploads |

`phoenix-skill-v1` identifies the **source bundle**, not a new JavaScript runtime. It contains `skill.json` and optional computer-only source files. The server retains them for inspection and signs only the normalized declarative data. It never evaluates submitted code. This guide does not promise a JavaScript sandbox.

[Touchscreen apps](/developers/touchscreen-apps) · [Theme walkthrough](/developers/themes)

## Five-minute start

Download and unzip the [Hello Jibo starter](/developers/downloads/hello-jibo.zip). In its folder run:

```sh
node --test test.mjs
node index.js
```

The first command tests navigation, greeting and close. The second prints screen and speech events on your computer; it does not control a robot. All source is shown on the [example page](/developers/skill-example).

For validation and packing, use a checkout of the Phoenix server source:

```sh
node tools/skill-kit/cli.mjs new ./my-skill --app-id app-00000000-0000-4000-8000-000000000000
node tools/skill-kit/cli.mjs check ./my-skill
node tools/skill-kit/cli.mjs test ./my-skill
node tools/skill-kit/cli.mjs pack ./my-skill
```

Replace that example app ID with the **exact ID** created in your publisher dashboard. The pack command writes `my-skill/my-skill.phskill`. It refuses to overwrite a pack; move or remove your old local output explicitly. You can also upload a ZIP of the starter folder in the browser; the browser builds the same source-container format.

## How the package works

1. The author writes `skill.json`: metadata, permissions and a graph of pages.
2. The kit or browser makes a `phoenix-skill-v1` container. Optional `index.js`, `test.mjs`, `README.md` and `LICENSE` are inert review attachments.
3. Publisher approval allows uploads, not publication. Each version becomes an unsigned, immutable pending submission.
4. An administrator inspects the manifest, permissions, source files and differences, then records a review note and test summary.
5. Only approved exact bytes can become a signed release. Owners find public listings under **From the community**, choose their own Jibo and approve installation.

The bundle and normalized package each fit within 64 KiB by default. Both retained forms count toward publisher storage if different. The dashboard shows this server's current limits.

## Manifest and lifecycle

`skill.json` is the actual declarative package, not an npm manifest. Required fields are `schema`, `runtime`, `appId`, `name`, `version`, `description`, `minFirmware`, `permissions`, `launchNames`, `releaseNotes`, `startPage` and `pages`. `examples`, `supportUrl` and `reportUrl` are optional.

Use `appId`, not `id`. `category`, `icon`, `entry` and JavaScript lifecycle hooks are **not accepted manifest fields** in this runtime. Category and artwork in other app formats do not make them valid here.

- Start: the manager presents `startPage`.
- Button: `show` changes page; `speak` requests speech without leaving the page; `close` ends the skill.
- Stop: the manager closes the skill. There is no author `onStop` callback.
- Voice launch names are declared aliases; there is no `onUtterance` callback or free-form microphone access.

[Full manifest and API reference](/developers/skill-api)

## Sandbox and permissions

Only `display` and optional `speech` are allowed. Display is mandatory. Speech actions require a declared speech permission and owner consent. Package validation rejects unknown fields, unsupported actions and undeclared speech.

There is no filesystem, package installation, storage, HTTP, arbitrary JavaScript, listening, camera, head movement or animation API for this format. Code in review attachments remains text. Do not put secrets in any submitted file.

## Test honestly

The starter's computer preview is runnable without a robot. It is **not** a jibo-web-sim integration or proof of physical speech. A generic simulator supporting another SDK is not evidence of support for this package.

On a compatible Jibo, a reviewed published declarative skill installs through the Skill Store with that owner's consent. The current local Test Build protocol admits native tests separately; do not use **Allow test builds** as a declarative upload bypass. Check the device's advertised supported kinds before attempting local installation. No native installer or private runtime is included in this kit.

[Publishing and review](/developers/publishing) · [Get help](/developers/support)
