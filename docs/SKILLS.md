# Build a skill for Jibo

Write a skill in JavaScript on your computer, then try it on **your own
Jibo** as a test build. One kit makes, checks, packs and installs it.

> **Jibo's current software, 13.8.0, supports test builds.** Check your own
> Jibo with `info` before installing: it must report Test Build protocol 1,
> `managerReady: true` and `native` in `localKinds`. A version number alone
> does not prove support, and this kit never updates Jibo.

## Get the kit

Download the skill kit from the Phoenix Developers site and unzip it. Run every
command in these guides from the unzipped `jibo-skill-kit` folder (in a Phoenix
checkout, from its root). The kit needs Node.js 20 or newer and no
`npm install`.

## Developer reference

| Guide | What it covers |
| --- | --- |
| [Workflow and starters](skills/WORKFLOW.md) | Starters, runtime, every kit command, your tap on Jibo, iteration and debugging |
| [Every manifest and package field](skills/MANIFESTS.md) | skill.json, app.json, permissions, launch names, file manifests, icons and the test container |
| [Complete app context and lifecycle](skills/CONTEXT.md) | Every context/service member, all seven methods, handles, menus, focus, timers, settings and teardown |
| [Jibo APIs](skills/SDK.md) | Screens, speech/ESML, listen/MIMs, sounds, animation, motion, LEDs, touch, volume, camera, perception, network and Node 6 limits |
| [Cookbook](skills/COOKBOOK.md) | Fifteen short recipes using the runnable starters |
| [Troubleshooting](skills/TROUBLESHOOTING.md) | Exact kit/robot messages, diagnostic workflow and support details |

Four starters are available: **hello** (the default), **touch-ui**, **voice**
and **network-service**. They are all the same kind of project. Each has a
README and scaffold/check/pack tests.

```sh
node tools/skill-kit/cli.mjs new my-touch --template touch-ui
node tools/skill-kit/cli.mjs check my-touch --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs pack my-touch --out out/my-touch --syntax-node "$NODE_6_5"
```

`NODE_6_5` is an optional trusted local Node 6.5.0 executable. Use Node 20+ to
run the kit; omit `--syntax-node` if you do not have the exact parser. See the
workflow for support checks before installation.

## How your skill runs

Your skill is ordinary JavaScript that runs inside Jibo's own software,
alongside his built-in skills and with the same access to files, accounts, the
network and system features. The permissions you list tell the owner what it
does; **they do not limit the code**, and passing the kit's checks does not
make code safe, so install only code you trust. Jibo asks for a tap on his
screen before he installs or removes a test build. That tap prevents
accidents; it does not review the code. Anyone with SSH access to a Jibo
already has full access to it.

## Before you start

- Node.js **20 or newer** on your computer. No `npm install` is needed.
- The skill kit: the unzipped `jibo-skill-kit` download.
- For installation: OpenSSH on your computer, and Jibo in `int-developer`
  mode so that he accepts SSH. Linux, macOS and Windows through WSL are the
  documented host path.
- A Jibo set up the usual way is in normal mode, which refuses SSH. Switching
  modes takes a DFU/RCM session with the free Jibo DFU Mod Toolkit: you need
  physical access to Jibo and a USB cable to your computer, and you hold the
  RCM button under the hatch on the back of his head while you turn him on.
  In the toolkit, choose **Set mode and configure Wi-Fi**, then select
  **int-developer**. Follow **Set int-developer mode and Wi-Fi** in the
  [setup guide](https://jibo.io/guide#mode), which links the toolkit download
  and its RCM steps.
- A set-up Jibo with an owner, running Jibo software 13.8.0, which includes the
  local test manager and the Developer testing screens. Local testing is for
  any set-up Jibo on that software; a Jibo with no owner cannot use it.
  Use `info --robot "$ROBOT"` as described under **Connect over SSH** below to
  check advertised support. If it refuses with `unsupported_firmware`, that
  Jibo is not running the current software yet; this kit does not supply or
  install robot software.

All examples below run from the kit folder. `new`, `check` and `pack` work
offline. Only `info`, `install`, `status` and `remove` use SSH. Nothing in
this kit uploads your code to jibo.io or publishes it to the Skill Store.

## Make your first skill

```sh
node tools/skill-kit/cli.mjs new my-skill
node tools/skill-kit/cli.mjs check my-skill
node tools/skill-kit/cli.mjs pack my-skill --out out/my-skill
```

Project names use 1–40 lowercase letters, digits or hyphens, starting with a
letter. `new` never overwrites an existing directory. `pack` never replaces an
existing output file; choose a fresh output directory for each build.

The hello starter adds a **Hello world** home-menu entry, opens a simple
screen, says a greeting and changes its title when tapped. Swipe down or touch
Jibo's head to leave. It writes no saved data and opens no network listener.

### Project layout

```text
my-skill/
  skill.json        Kind, project name, explicit list of shipped files
  app.json          Package settings and unique skill name
  entry.js          Host lifecycle and home-menu registration
  hello.js          Screen, speech, tap and close behavior
  README.md         Notes for the author (not packed)
  .gitignore        Excludes local identity state and output
```

`skill.json` is a kit file, not robot metadata. It has exactly `schema: 1`,
`kind: "native"` (always this value), `name` (the project slug) and `files` (an array of unique
relative paths). List **every** file your code needs, including `app.json` and
the entry file. Unlisted files, README, source-control files and output are not
packed. There is no automatic recursive dependency discovery or npm install.

Paths are at most 200 UTF-8 bytes and use letters, digits, `_ @ . + -` and `/`.
No empty, `.` or `..` components, absolute paths, spaces, links, hardlinks,
devices or FIFOs. Each USTAR name must also fit its name/prefix fields.
Executable source files retain executable mode; other files use mode `0644`.
Binary `.node` / `.so` modules and nonempty `package.json` scripts are rejected.

### `app.json` reference

The kit accepts only the following `app.json` fields. These are author
settings used to construct the robot's native metadata; the inner `app.json` is
also shipped as an ordinary hashed file. It is **not** a signed Store release.

| Field | Required | Meaning |
| --- | --- | --- |
| `appId` | Yes | `app-` followed by a lowercase UUID in 8-4-4-4-12 groups. `new` creates a fresh placeholder; `install` substitutes the robot-allocated local identity in the pack without editing your source |
| `name` | Yes | A unique `@scope/name` namespace. The starter uses `@local/` plus your project and a fresh UUID; it registers its skill under this exact name |
| `version` | Yes | Plain `X.Y.Z`, nonnegative safe integers, no leading zeros or prerelease suffix |
| `minFirmware` | Yes | Plain `X.Y.Z` minimum robot-software version; the starter uses `13.7.1`, but capability checks still decide support |
| `hostAbi` | Yes | Exactly `1` for this host lifecycle |
| `entry` | Yes | Listed relative `.js` path exporting `create(context)` |
| `permissions` | Yes | Unique strings, up to 32; lowercase letter followed by up to 63 lowercase letters, digits or hyphens. Hello uses `display` and `speech` |
| `optionalPermissions` | Yes | Same syntax and limit, with no overlap with required permissions; hello uses `[]` |
| `launchNames` | Yes | Up to 16 unique lowercase letters/digits/spaces/hyphens, 1–64 characters starting with a letter/digit. Local voice aliases are not registered; hello uses `[]` |
| `skills`, `plugins`, `menuEntries` | No | Declare every fixed skill name, plugin name and menu label your code registers. Use arrays of strings (or objects with a string `name`). The starter declares its unique skill name, no plugins and `Hello world`. These are collision claims, not registration calls |
| `incomingPorts` | No | Declare incoming listener claims in the inner app manifest when applicable. They are compared for collisions, not copied into schema-1 outer metadata, and do not grant a listener. Hello declares `[]` |

Do not add Store `releaseId`, `reviewId`, signatures, signing keys, approval
flags or a publisher account to a local project. Those are not author consent.
The robot creates its own local release/request identities. A new local app ID
does not isolate global skill names, plugins, menu labels or listening ports.
Checks compare the declared `appId`, `name`, `skills`, `plugins`, `menuEntries`,
`launchNames` and `incomingPorts`, plus bundled package names from `package.json`
and `node_modules` paths. Remove a conflicting installed app first when Jibo
names a collision. Missing declarations and runtime-computed names cannot be
inferred from arbitrary JavaScript; skill code is not isolated. Keep your
namespaces unique and do not run
a second copy of an app with shared global resources.

## Lifecycle: the parts you own

The robot calls `require(entry).create(context)` once and expects these methods:

| Method | What to do |
| --- | --- |
| `prepareBeforeInit()` | Construct the skill and register its name/hooks without starting background work |
| `startAfterInit()` | Start work that needs initialized services; hello just becomes ready |
| `registerLaunchers()` | Register home-menu entries, optionally Settings entries |
| `getSetupState()` | Return `{ configured: true/false }` |
| `health()` | Return `{ ok: true/false }`; do not report ready before your app is ready |
| `stop()` | Stop work, close your views and release your own resources. Resolve `{ resourcesReleased: true }` only after verified cleanup; reject on failure |
| `removeData()` | Implement for Skill Store erase-data removal. Local tests do not call it: local erase deletes dataRoot directly. Hello has no saved data |

The context supplies `appId`, `releaseId`, `appRoot`, `dataRoot`, granted
permissions and `services.{Be,be,jibo}`. These services have full access.
Use `dataRoot` for your own saved files, not another app's data directory.

### Home menu and focus

On Jibo 13.8.0, a running local test's Home entries appear after the Skill
Store entries, named **LOCAL / Test —** followed by your entry name; Settings
entries get the same prefix. See
[opening a local test](skills/WORKFLOW.md#opening-a-local-test). The Test builds
detail screen is not an app launcher.

```js
// Save the returned handle and call handle.remove() during cleanup.
var handle = context.launchers.register({ name: 'My skill', open: open });
// Optional Settings entry uses the same shape:
// context.settings.register({ name: 'My skill', open: open });
```

The starter acquires `context.attention.acquire()` and
`context.speech.acquire()` before redirecting with
`context.services.be.redirect(new context.services.Be.SkillSwitchData(skill,
{ source: 'native_app' }))`. A failed lease returns `null`: do not open anyway.
Release both handles when the skill closes. `context.hooks.on(emitter, event,
handler)` gives a removable event hook; `context.hooks.add(dispose)` owns your
cleanup callback. `context.timers` owns ordinary timers while admission is open.

### Screens, speech and taps

The starter extends `context.services.Be.BeSkill`. It creates a native `View`
through `jibo.face.views.createView('View', { viewConfig, componentConfigs })`.
A `Label` has `text`, `style`, `position`, `targetAnchor` and `bounds`. A `Button`
uses `assets: []`, a rectangular `hitArea`, and this callback shape:

```js
{
  type: 'Button', id: 'hello', assets: [],
  position: { x: 440, y: 320 },
  hitArea: { x: 0, y: 0, width: 400, height: 100 },
  action: { type: views.ActionData.CALLBACK,
    data: { callback: function () { /* respond to this tap */ } } }
}
```

Open with `views.changeView({ addView: view, transitionOpen:
views.TRANSITION.IN, transitionClose: views.TRANSITION.OUT }, complete, failure,
loaded)`. Paint only after the view is loaded. Hello uses a `PIXI.Graphics`
rectangle behind the button, not external art. Keep controls in the central
safe area of the 1280×720 canvas and touch targets at least 64 pixels high.
Do not draw Jibo's body, head, face or eye in your artwork.

Hello speaks a fixed line with `jibo.embodied.speech.speak(line,
{ disableAutoRules: true, dispatchComplete: 'TTS' })`. It avoids interrupting
another speaker and tracks its own utterance before stopping it. Do not feed
untrusted text into speech markup or call a global stop on someone else's work.

The starter handles swipe-down, `jibo.jetstream.events.hjHeard` and
`jibo.system.events.touchOn`. `close(done)` waits for a pending transition,
removes its own current view, verifies destruction, removes event listeners and
then releases focus. It also overrides `destroy(done)`; the base implementation
does not close your custom view for you. If cleanup cannot be verified, report
an error instead of claiming resources were released. A bounded Node `timers`
watchdog handles teardown; do not allocate new context timers inside `stop()`
when host resource admission is already closed.

**Write for Node 6.5 on the robot**, not the Node 20 host. Use CommonJS, not ESM;
no async/await, optional chaining, object spread or modern browser APIs. The kit
parses JavaScript with its host Node without executing it; that default is
**not an exact Node 6 syntax check**. If you already have a trusted local
**Node 6.5.0** executable, supply its absolute path to use the matching parser:

```sh
node tools/skill-kit/cli.mjs check my-skill --syntax-node "$NODE_6_5"
# The same optional flag works with pack and install.
```

This compiles each source file with `vm.Script` in a bounded local child; it
does not evaluate the submitted code. The kit checks the interpreter version,
does not download a runtime, and never accepts a modern interpreter as this
exact compatibility check. Keep using Node 20+ to run the kit itself. The robot
independently parses every packed `.js` file on its own runtime before approval.
The shipped starter has also been checked offline with Node 6.5. A host pass
is never permission to bypass a robot rejection.

## Connect over SSH

Use the robot's address or an SSH alias configured on your computer. Jibo must
be in `int-developer` mode: normal and oobe modes reject inbound SSH (see
Phoenix's [operations guide](OPERATIONS.md)). If yours was set up the usual
way, switch him first with **Set int-developer mode and Wi-Fi** in the
[setup guide](https://jibo.io/guide#mode), as described under **Before you
start**; that guide also shows how to read his IP address from his boot
screen. The [runbook](RUNBOOK.md) documents the `root` login and SSH-key setup. The kit uses that login, asks OpenSSH to handle your
normal credentials, and does not store passwords or disable host-key checks.
Verify a new host key before accepting it. Configure a nonstandard port or key
in your SSH config; do not pass shell fragments as the robot name.

```sh
# Set this to your own SSH hostname or configured alias, not an HTTP URL.
ROBOT=my-jibo
node tools/skill-kit/cli.mjs info --robot "$ROBOT"
```

The fixed default paths are:

| Option | Default on the robot |
| --- | --- |
| `--be-root` | `/opt/jibo/Jibo/Skills/@be/be` |
| `--node` | `/usr/bin/node` |
| `--state-root` | `/opt/home/jibo-skill/.local/share/phoenix/test-builds` |

Each remote operation reads `info` first and requires protocol 1, a ready
manager and exact matches for `beRoot`, `runtimeNode` (the executable path),
and `stateRoot`. `info.localKinds` must include `native`; 13.8.0 reports
`['native']`. The CLI checks it before local state allocation, project
allocation or queueing, including retries with a saved project, and refuses
with a plain message when it is missing. It refuses a path mismatch.
For a nonstandard installation supply
all differing options explicitly. Never guess a new data directory or copy a
replacement CLI onto an older robot. Keep the configured paths aligned with the values advertised by info.

## Test on your own Jibo

1. On Jibo, open **Settings → Developer testing → Allow test builds**. Read
   **Allow test builds?** and physically tap **Allow test builds** to confirm.
   This is not Skill Store review: **Only test code you trust.**
2. Run the install command on your computer:

```sh
node tools/skill-kit/cli.mjs install my-skill --robot "$ROBOT"
```

3. When a request is waiting and Jibo is idle, he opens **Install test build?**
   himself. Otherwise open **Settings → Developer testing → Test builds**;
   **Test builds · Needs a tap** and the **Needs a tap** row keep the request
   visible. Open it to review. An update starts with **Update test build?**
   and says **Replaces the previous test build; keeps its data.**
4. Read the name, version and `Build <sequence> · Native app` summary, then
   tap **What it can do**. Read every permissions page, using **Continue**
   when present. Jibo then shows **Full access to Jibo’s software**, the same
   page for every test build:

```text
This test app can access files, accounts,
network and system features, and may break
Jibo or expose private information.
Automatic checks do not mean it is safe.
Only test code you trust.
```

5. If the request is still awaiting review, physically tap **Install full-access test** on that final warning to
   authorize installation or update, or **Decline** to refuse. The terminal
   says **Tap Install full-access test on Jibo** when a tap is needed; there is no button named
   “Approve”. Voice, Agent, SSH, scripts and the submitted code cannot enable
   Allow or approve a request.
6. **The request was approved. Check Test builds for its status.** is approval,
   not proof of startup. **Finishing your request** may appear while Jibo works.
   Check `runtimeState: "running"` with `status --list` and **Running** in
   **Test builds**, not just `installed` or a finished upload. A request
   whose `runtimeState` is still `pending_restart` is not finished; the installer
   follows the same request through that restart trial within its wait
   budget. Use the [release-specific opening path](skills/WORKFLOW.md#opening-a-local-test);
   **LOCAL / Test** identifies the test in the test-build list and details.

`install` checks locally, reads `info.localKinds`, allocates a new local
project on that robot once, builds with its returned identity, asks the robot
to check, queues the request,
and polls the exact request through your approval and the pending restart
until it is installed, fails or times out. Physical
approval is required for **every new install or changed build**. A successful or
unresolved identical retry reuses its request ID rather than adding another copy;
after a confirmed `failed`, `canceled`, `declined`, or `expired` request, another
explicit install creates a fresh request ID and needs a fresh physical tap even
when the bytes are unchanged. Edit the code and
run `install` again for an update; increase `version` when it helps you track
builds. Installation uses the robot's idle restart path: you should not
need to restart Jibo yourself. A restart or busy robot can take time.

The default wait is 600 seconds; `--timeout 1200` allows up to 20 minutes
(maximum 3,600 seconds). A timeout is **not cancellation**. Check the request
before retrying; an upload may have completed even if SSH disconnected.

```sh
node tools/skill-kit/cli.mjs status my-skill --robot "$ROBOT"
node tools/skill-kit/cli.mjs status --robot "$ROBOT" --list
# Copy the exact ID returned for the request you want to inspect:
node tools/skill-kit/cli.mjs status --robot "$ROBOT" --request "$REQUEST_ID"
```

The kit saves allocation/retry/request IDs in the project's ignored
`.skill-kit/` directory, separately for each SSH alias and path configuration.
It stores no SSH secrets. Keep that directory to reuse the project identity;
changing aliases or deleting it can allocate another project. Do not commit or
share that state. `status --list` can recover requests after a lost reply.

### Test builds, pause and resume

On Jibo, **Settings → Developer testing → Test builds** lists tests with the
**LOCAL / Test** badge, their version and state. Pending requests show **Needs
a tap**. Installed details say **Not reviewed for the Skill Store.** States
include **Running**, **Finishing when Jibo is idle**, **Failed** and
**Paused — Allow test builds is off**. Open a pending row to review its request;
open an installed row for details and **Remove**.

Local tests stay installed **and keep running across restarts and reboots**
while **Allow test builds** is on. There is no 24-hour local session and no
automatic expiry. The install summary says **For this Jibo · no automatic
expiry.** To pause tests, turn Allow off and confirm **Turn off** on the
**Turn off test builds?** screen. Its exact explanation is:

> Your test builds will stop and stay paused.
> Their code and saved data will stay on Jibo.
> Turn Allow back on to resume approved tests.

A physical confirmation to turn Allow back on resumes previously approved
tests without approving each one again. Resuming can wait for Jibo to
be idle and restart its software. The robot still checks ownership, integrity
and collisions; a failed check stops the affected test instead of running it.

### Remove a test

```sh
# Choose exactly one, then confirm Remove test build on Jibo:
node tools/skill-kit/cli.mjs remove my-skill --robot "$ROBOT" --keep-data
node tools/skill-kit/cli.mjs remove my-skill --robot "$ROBOT" --erase-data
```

Removal is a tapped request, not remote permission to delete. It is available
even with Allow off. In **Settings → Developer testing → Test builds**, open
the test, tap **Remove**, then choose **Keep test data** or **Erase test data**.
The **Remove test build?** screen shows one of these exact messages:

- **Keeps this test’s saved data.**
- **Erases this test’s saved data.**

It also says:

> The Skill Store version and its saved data
> will not be removed.

Finally, physically tap **Remove test build**; choosing the data option alone
does not authorize removal. An SSH removal already supplies that data choice,
but still needs the same final tap. **Decline** refuses the request. Check for
**Test build removed.** on Jibo and `removed` in terminal status. Keeping data
retains this project's saved data for a future test; erasing removes only this
test's saved data.

### Collisions with an installed app

A local test cannot run alongside an installed app it collides with. Jibo
refuses it with `test_native_collision` and names the installed app to remove
first: `Remove “<installed app name>” first, then try again.` Remove that app
through its supported removal flow before sending the test again. A fresh
local app ID is not a workaround. Checks cover the declared app/skill/plugin/
menu names, bundled package namespaces and declared incoming ports described
in the manifest reference; arbitrary runtime-computed names and
undeclared sockets cannot be inferred. Test builds are not sandboxed.

### Existing unsigned artifacts

The advanced wrapper is kept for authors who already have an unsigned artifact
and its descriptor/file manifest. It is not the normal hello-project path:

```sh
node tools/skill-kit/native-pack.mjs \
  --unsigned release/unsigned.json --artifact release/artifact.tar.gz \
  --app-id "$LOCAL_APP_ID" --out out/test.phnative
node tools/skill-kit/cli.mjs check out/test.phnative
```

Allocate the local identity with the lower-level `ssh.mjs project` command
first. See `node tools/skill-kit/cli.mjs --help` for the normal workflow and
[the kit readme](../tools/skill-kit/README.md) for low-level command examples.
The wrapper verifies artifact and manifest hashes, changes only outer identity
metadata, and never re-signs or edits executable bytes. Inner `app.json` names,
plugins and listeners stay unchanged; do not run both copies concurrently.

### Pack contract

A `.phnative` is `PHXNAT1` followed by a newline, a four-byte big-endian metadata
length, canonical JSON metadata, and one gzip-compressed USTAR archive. Metadata
is at most 49,152 bytes. Legacy schema 1 has exactly `schema: 1`, `kind: "native"`, `appId`,
`version`, `minFirmware`, `hostAbi`, `entry`, `permissions`, `optionalPermissions`,
`launchNames`, `fileManifest`. Each sorted manifest entry has exactly `path`,
`length`, lowercase SHA-256 `sha256`, and `mode` (`420` or `493`). Up to 4,096
regular files are allowed, at most 32 MiB each, 128 MiB of file contents and
32 MiB compressed. The archive includes no directory or link entries. Headers,
checksums, modes, padding, hashes and end blocks are checked, not just filenames.
No signing key, release ID or approval bit belongs in this container.

For declared artwork, add all three `iconApi`, `icon`, `iconImage` fields to
`app.json` following [the v2 icon rules](skills/MANIFESTS.md#v2-icon-rules)
and include `assets/app-icon.png` in `skill.json`'s files for an image icon.
The kit emits schema 2, preserving those fields through the robot descriptor
and Home while retaining **LOCAL / Test** identification. Apps without icon
fields keep schema 1 and the generic fallback. An explicit null or builtin
icon is also schema 2. `install` checks `info.nativeContainerSchemas` contains
`2` before writing state, allocating a project or uploading, including saved
projects. Jibo 13.8.0 advertises `nativeContainerSchemas: [1, 2]`; software
that does not advertise `2` gets a clear update instruction, not a silent
downgrade. This local check is separate from the Skill Store's own release
format.

## Troubleshooting

A host check validates structure and integrity without running your code. It
does not prove safety, successful startup or physical rendering. The robot
checks its own software version, available space, identity, names, Node 6
syntax and physical approval. Never repair a refusal by editing robot inventory
or approval files, disabling host-key checks, or replacing its CLI.

| Symptom / code | What to do |
| --- | --- |
| `unsupported_firmware` | Install Jibo's current software (13.8.0); do not copy an installer onto an older release |
| `unsupported_native_icons` | Update Jibo to firmware advertising `nativeContainerSchemas: [1, 2]`; no artwork is stripped. Legacy schema-1 projects still work on older native-capable firmware |
| `unsupported_kind` | Your Jibo's `info` has no `native` in `localKinds`, so it can't install test builds. The kit prints: This Jibo can't install skill test builds: its info has no native in localKinds. Check that Jibo runs its current software. |
| `robot_path_mismatch`, `test_manager_unavailable` | Compare installed diagnostics with your three path options. Wait for startup after an install restart; do not create a second manager |
| `ssh_unavailable`, `ssh_or_robot_failed`, `ssh_timeout`, `ssh_stream_failed` | Check OpenSSH, int-developer mode, address, credentials and host key. Reconnect and read status before retrying |
| `approval_timeout` | The terminal stopped waiting, not the robot. Use the printed request ID with status; check the physical screen |
| `test_builds_disabled` | Turn on Settings > Developer testing > Allow test builds on Jibo; physically confirm **Allow test builds** |
| `test_execution_paused` | Turn Allow back on with a physical confirmation to resume approved tests |
| `test_owner_unknown` | Set Jibo up with an owner first. If already set up, keep the code for support; do not edit identity files |
| `test_native_collision`, `test_identity_collision` | `Remove <app> first`. Jibo says `Remove “<installed app name>” first, then try again.` Remove the named installed app; a new app ID is not global-resource isolation |
| `test_queue_full`, `test_validation_busy`, `test_rate_limited`, `robot_install_busy` | Let current work finish; inspect the queue rather than repeatedly submitting |
| `test_disk_limit`, `test_count_limit`, `test_project_limit` | Remove unused tests on Jibo or free storage through supported tools |
| `pack_changed`, `input_changed`, transport digest/size errors | Finish editing/copying, rebuild, and send an unchanged regular file |
| `test_native_syntax_invalid` | Use robot-compatible CommonJS/Node 6 syntax; a modern host parser is not the robot parser |
| `client_request_conflict` | The same retry ID was used for different content; keep the original state for retries, or make a new build |
| `EEXIST` | Choose a new project/output path; existing files are never overwritten |

No per-skill log API is advertised by this protocol, so v1 has no `logs`
command. To inspect your own diagnostics over SSH, add a bounded log file under
`context.dataRoot` in your skill, record its chosen relative filename, and read
that exact file in your existing SSH shell. The protocol does not disclose a
stable installed data-directory path, so this guide does not invent one. Do
not dump all system logs, account files, tokens or other apps' data into support
messages. The hello starter writes no log file.

If a code below remains after the suggested fix, keep the exact code, command
name and request ID for support. Do not share passwords, private code or full
inventories. Robot releases may add codes; an unknown code is a refusal, never
permission to skip validation.

## Error-code reference

These are the named codes in the v1 host helper and local robot validation,
transport and lifecycle paths. Your code can also throw its own error codes.
Standard filesystem errors such as `ENOENT`, `EACCES`, `ENOSPC` and `EEXIST` mean
missing files, insufficient access, full storage and an existing output; correct
the local file/space issue rather than running the kit with extra privileges.
The JSON parser shares the public theme kit, so its codes start `theme_json_`
even for a skill. Theme-only errors from the advanced helper use the
[theme guide](THEMES.md).

| Code | Next step |
| --- | --- |
| `approval_timeout` | Read the printed request ID with status; timeout does not cancel installation. |
| `artifact_integrity` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `artifact_transport_digest_mismatch` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `artifact_transport_size_mismatch` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `choose_file_or_stdin` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `choose_keep_or_erase_data` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `choose_request_or_list` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `client_request_conflict` | Keep the original request/input for retries; a changed build needs a new retry ID. |
| `client_request_invalid` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `control_frame_timeout` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `control_idle_timeout` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `control_incomplete_frame` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `control_request_timeout` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `control_response_too_large` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `control_socket_exists` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `control_socket_path_too_long` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `control_trailing_bytes` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `explicit_data_choice_required` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `explicit_state_root_required` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `hello_close_timeout` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_name_in_use` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_not_prepared` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_speech_busy` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_view_close_failed` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_view_covered` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `hello_view_retained` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `host_io_error` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `identity_must_change` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `image_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `input_changed` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `invalid_app_manifest` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `invalid_arguments` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_artifact_bounds` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `invalid_client_request_id` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `invalid_control_header` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `invalid_control_json` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `invalid_file_list` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_header_length` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `invalid_input_file` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `invalid_local_identity` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `invalid_local_state` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_manager_response` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `invalid_name` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_option` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_option_value` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_output_name` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_pack_file` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `invalid_project` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_project_id` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_project_path` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_remote_path` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `invalid_request_id` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_robot` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_robot_limits` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_robot_response` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `invalid_source_path` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `invalid_state_root` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `invalid_syntax_runtime` | Choose an absolute path to a trusted local Node 6.5.0 executable for --syntax-node, or omit that optional flag and rely on the robot parser. |
| `invalid_timeout` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `invalid_unsigned` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `local_project_not_found` | Copy the exact returned identity or use status --list; do not repair or guess an ID. |
| `local_project_not_installed` | Copy the exact returned identity or use status --list; do not repair or guess an ID. |
| `local_request_interrupted` | Read status after Jibo starts. This older-manager compatibility state must not be bypassed; use the matching persistent-test release. |
| `local_request_not_found` | Copy the exact returned identity or use status --list; do not repair or guess an ID. |
| `local_session_not_approved` | Read status after Jibo starts. This older-manager compatibility state must not be bypassed; use the matching persistent-test release. |
| `local_validation_busy` | Read pending status and let the current work finish before retrying. |
| `manifest_integrity` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `metadata_limit` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `missing_file` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `missing_option` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `missing_out` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `missing_robot` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `native_ack_unconfirmed` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `native_admission_closed` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_artifact_digest_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_busy` | Read pending status and let the current work finish before retrying. |
| `native_cleanup_adoption_unhealthy` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `native_cleanup_receipt_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `native_cleanup_unconfirmed` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_descriptor_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_enospc` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_entry_invalid` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_envelope_too_large` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_file_integrity_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_firmware_too_old` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `native_focus_unavailable` | Close the current activity and let its speech finish. If hello still cannot open or close, check its lifecycle and unique declared name; never claim cleanup while its view or speech remains owned. |
| `native_grants_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_gzip_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_health_failed` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_hook_invalid` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_icon_package_mismatch` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_identity_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_inventory_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_key_untrusted` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `native_legacy_owner_mismatch` | Check that Jibo is linked to its owner and the installed software has an authenticated owner identity; ask support if it remains unavailable. |
| `native_legacy_path_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_manifest_digest_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_manifest_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_migration_adoption_unhealthy` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `native_migration_authorization_mismatch` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `native_migration_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_not_installed` | Copy the exact returned identity or use status --list; do not repair or guess an ID. |
| `native_owner_binding_required` | Check that Jibo is linked to its owner and the installed software has an authenticated owner identity; ask support if it remains unavailable. |
| `native_path_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `native_registration_invalid` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_signature_invalid` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `native_tar_entries_exceeded` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_tar_expansion_exceeded` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_tar_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_tar_path_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_tar_type_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `native_timer_invalid` | Fix the native lifecycle: initialize only when ready, retain handles, close owned work and report cleanup failures; read your own bounded diagnostics. |
| `native_trial_interrupted` | Read status after Jibo starts. This older-manager compatibility state must not be bypassed; use the matching persistent-test release. |
| `no_saved_project` | Use the same project, SSH alias and path options as installation, or recover its request with status --list. |
| `no_saved_request` | Use the same project, SSH alias and path options as installation, or recover its request with status --list. |
| `noncanonical_control_header` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `not_installed` | Copy the exact returned identity or use status --list; do not repair or guess an ID. |
| `pack_changed` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `pack_read_failed` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `pack_too_large` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `package_too_large` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `permission_consent_required` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `physical_approval_missing` | Use the physical screen on Jibo. Voice, Agent and SSH cannot approve. |
| `physical_tap_required` | Use the physical screen on Jibo. Voice, Agent and SSH cannot approve. |
| `project_kind_changed` | Correct the project configuration, listed paths and manifest; use a fresh project to change kind, not an old local allocation. |
| `robot_install_busy` | Read pending status and let the current work finish before retrying. |
| `robot_path_mismatch` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `robot_response_too_large` | Check that host kit and robot advertise the same protocol. Keep the exact code for support; do not treat a malformed reply as success. |
| `ssh_or_robot_failed` | Check OpenSSH, int-developer mode, host key, address and your credentials; read status after reconnecting. |
| `ssh_stream_failed` | Check OpenSSH, int-developer mode, host key, address and your credentials; read status after reconnecting. |
| `ssh_timeout` | Check OpenSSH, int-developer mode, host key, address and your credentials; read status after reconnecting. |
| `ssh_unavailable` | Check OpenSSH, int-developer mode, host key, address and your credentials; read status after reconnecting. |
| `test_ack_failed` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_approval_expired` | Submit a fresh request and review it physically before its approval deadline. |
| `test_approval_proof_mismatch` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_authorization_expired` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_authorization_invalid` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_binding_mismatch` | Check that Jibo is linked to its owner and the installed software has an authenticated owner identity; ask support if it remains unavailable. |
| `test_builds_disabled` | Turn on Settings > Developer testing > Allow test builds on Jibo, then physically confirm Allow test builds. |
| `test_compressed_trailing` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_content_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_content_mismatch` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_count_limit` | Remove unused local tests through Jibo, or free storage through supported tools. |
| `test_decode_limit` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_decoder_unavailable` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `test_disk_limit` | Remove unused local tests through Jibo, or free storage through supported tools. |
| `test_execution_paused` | Check Allow test builds on Jibo and turn it on with a physical tap. |
| `test_firmware_too_old` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `test_grants_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_identity_collision` | Remove the named conflicting installed app before trying this local copy. |
| `test_input_changed` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `test_input_file_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_input_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_inspection_required` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_journal_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_lease_expired` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_lease_replay` | This is not author-supplied consent. Use the matching local workflow and robot release; never forge keys, signatures or approval files. |
| `test_legacy_path_forbidden` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_manager_unavailable` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `test_native_binary_forbidden` | Remove native binary modules; this test format accepts JavaScript and data only. |
| `test_native_collision` | `Remove <app> first`. Jibo names the installed app: `Remove “<installed app name>” first, then try again.` |
| `test_native_container_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_native_envelope_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_native_metadata_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_native_not_staged` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_native_scripts_forbidden` | Remove package scripts and prebuild dependencies on your computer. |
| `test_native_syntax_invalid` | Rewrite the offending JavaScript for Node 6.5; check every packed source file. |
| `test_owner_unknown` | Set Jibo up with an owner first. If already set up, keep the code for support; do not edit identity files. |
| `test_package_not_canonical` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_policy_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_project_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_project_limit` | Remove unused local tests through Jibo, or free storage through supported tools. |
| `test_queue_full` | Read pending status and let the current work finish before retrying. |
| `test_rate_limited` | Read pending status and let the current work finish before retrying. |
| `test_rebooted` | Read status after Jibo starts. This older-manager compatibility state must not be bypassed; use the matching persistent-test release. |
| `test_receipt_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_record_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_record_missing` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_remove_data_required` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_request_canceled` | Run `install` again for a fresh request and physical tap; keep the exact code and request ID for support if the refusal repeats. See [Iterate and recover a request](skills/WORKFLOW.md#iterate-and-recover-a-request). Do not bypass the robot refusal. |
| `test_request_declined` | Run `install` again for a fresh request and physical tap; keep the exact code and request ID for support if the refusal repeats. See [Iterate and recover a request](skills/WORKFLOW.md#iterate-and-recover-a-request). Do not bypass the robot refusal. |
| `test_request_expired` | Run `install` again for a fresh request and physical tap; keep the exact code and request ID for support if the refusal repeats. See [Iterate and recover a request](skills/WORKFLOW.md#iterate-and-recover-a-request). Do not bypass the robot refusal. |
| `test_request_failed` | Run `install` again for a fresh request and physical tap; keep the exact code and request ID for support if the refusal repeats. See [Iterate and recover a request](skills/WORKFLOW.md#iterate-and-recover-a-request). Do not bypass the robot refusal. |
| `test_request_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_request_mismatch` | Read the current exact request; do not reuse a completed, replaced or stale approval. |
| `test_request_stale` | Read the current exact request; do not reuse a completed, replaced or stale approval. |
| `test_request_terminal` | Read the current exact request; do not reuse a completed, replaced or stale approval. |
| `test_root_invalid` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `test_runtime_unavailable` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `test_settings_mirror_invalid` | Stop this test and keep the code/request ID for support. Do not edit robot policy, receipts or inventory files. |
| `test_spool_write_failed` | Finish or rebuild the pack, check the exact request, then retry an unchanged regular file. The transfer may have lost its reply. |
| `test_tar_digest_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_tar_invalid` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_tar_manifest_mismatch` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_tar_trailing` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `test_theme_png_required` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_time_unverified` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `test_validation_busy` | Read pending status and let the current work finish before retrying. |
| `theme_container_invalid` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `theme_json_duplicate_key` | Correct the JSON: UTF-8, unique ordinary keys, bounded nesting and member counts. |
| `theme_json_forbidden_key` | Correct the JSON: UTF-8, unique ordinary keys, bounded nesting and member counts. |
| `theme_json_invalid` | Correct the JSON: UTF-8, unique ordinary keys, bounded nesting and member counts. |
| `theme_json_too_deep` | Correct the JSON: UTF-8, unique ordinary keys, bounded nesting and member counts. |
| `theme_json_too_large` | Correct the JSON: UTF-8, unique ordinary keys, bounded nesting and member counts. |
| `theme_manifest_not_canonical` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |
| `unexpected_state_root` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `unknown_command` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `unknown_robot_state` | Keep the exact code and request ID, stop the affected test, and ask support. Do not bypass the robot refusal. |
| `unknown_template` | Check --help and supply exact values once. Choose exactly one requested flag; no approve or enable command exists. |
| `unsafe_control_socket` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `unsafe_state_root` | Compare the exact configured paths with installed diagnostics. Do not loosen permissions, follow links or create a second manager. |
| `unsupported_firmware` | Use a compatible complete robot-software release and wait for its normal startup. Do not copy a replacement CLI. |
| `unsupported_kind` | This Jibo does not report `native` in info.localKinds, so it can't install test builds. Check that it runs Jibo's current software. |
| `ustar_path_limit` | Rebuild with this kit; check listed files, hashes, sizes, gzip/USTAR and regular-file types. Do not hand-edit a packed artifact. |

## What this kit does not do

- Publishing skills to the Skill Store is not part of this kit yet. A test
  build is for your own Jibo; your tap on Jibo is not Store review or a
  publishing identity.
- Themes reach Jibo through the Skill Store, not through this kit.
- A browser simulator, remote approval, automatic credential setup, dependency
  downloads, binary modules and a stable per-skill log endpoint are not
  included.
- Offline tests do not certify a physical robot, screen, microphone, speaker or
  release. Test your own skill on your own Jibo.
