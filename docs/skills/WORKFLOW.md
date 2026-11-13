# Develop and test a skill

[Developer guide](../SKILLS.md) · [Manifests](MANIFESTS.md) · [Host API](CONTEXT.md) · [Troubleshooting](TROUBLESHOOTING.md)

## How a skill runs

A skill runs inside Jibo's own software (BE) on Node 6.5, with a Chrome 53
renderer for its screens. It can use touch screens, speech and listening,
motion, SDK features, files and network services. Like his built-in skills it
has full access: permission labels, hashing and syntax checks are not
isolation or proof of safety, so test code you trust on your own set-up Jibo.
Your tap on Jibo approves a local test; it is not Skill Store review.

The lifecycle is create → prepare → initialized services → start → health →
menu registration. An opened interaction then owns focus, views, speech and
input until it closes. A background service can run without a menu entry.
The host stops the instance before removal/replacement and keeps data through
an update. [Host API](CONTEXT.md) specifies all lifecycle methods and cleanup.

## Prerequisites

- Node 20+ on your computer and the skill kit: the unzipped `jibo-skill-kit`
  download. No `npm install` is needed for the kit.
- For exact legacy syntax checks, a trusted **local Node 6.5.0 executable**.
  The kit never downloads an interpreter or executes submitted skill code.
- For installation, OpenSSH and an existing authorized SSH connection to your
  own Jibo. Linux, macOS and Windows through WSL are the documented host path.
- Jibo must be set up with an owner and have software advertising protocol 1,
  `managerReady: true`, the matching Developer testing UI and `native` in
  `localKinds`.
  Jibo's current software, 13.8.0, provides them; a version number alone is not
  proof, so check with `info`. The kit does not install robot software.
- SSH requires the supported developer-access mode. See [operations](../OPERATIONS.md)
  and [runbook](../RUNBOOK.md) for the existing access setup. Keep host-key checks
  enabled and verify a new host key; no credentials are stored by the kit.

## Scaffold a starter

Run these commands from the kit folder. Choose one project name:

```sh
node tools/skill-kit/cli.mjs new my-hello
node tools/skill-kit/cli.mjs new my-touch --template touch-ui
node tools/skill-kit/cli.mjs new my-voice --template voice
node tools/skill-kit/cli.mjs new my-network --template network-service
```

| Template | Files and behavior |
| --- | --- |
| `hello` (the default; `--template hello`) | Home tile, screen, spoken greeting, tap response and verified view/focus cleanup |
| `touch-ui` | Welcome and counter screens with Next/Count/Back; swipe/head-touch exit |
| `voice` | Home tile, declared launch-name claim, fixed ESML, prompt then one owned local listening turn |
| `network-service` | Background HTTPS polling, bounded in-memory summary, loopback-only status listener, timer/request/server shutdown |

Every starter has its own README. The voice template's launch-name field is a
release claim; **local v1 does not register aliases**. Use the
[local-test opening path](#opening-a-local-test) for your installed release.

A project slug is 1–40
lowercase letters/digits/hyphens starting with a letter. Existing directories
are never overwritten. `new` generates unique app/skill namespaces, but does
not hide collisions in a fixed menu label or a listener port. Edit declarations
and runtime names together when making multiple copies.

## Check and pack offline

```sh
node tools/skill-kit/cli.mjs check my-touch
node tools/skill-kit/cli.mjs check my-touch --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs pack my-touch --out out/touch-build-1 --syntax-node "$NODE_6_5"
node tools/skill-kit/cli.mjs check out/touch-build-1/my-touch-1.0.0.phnative --syntax-node "$NODE_6_5"
```

`NODE_6_5` is the absolute path to your trusted local executable, not a remote
path. `check` verifies structure, bounded file contents, hashes and syntax
without running your program. `pack` produces deterministic bytes from unchanged
inputs and never replaces an existing output. Use a fresh output directory for
each version/build. The robot separately checks syntax and runtime compatibility.

Projects explicitly list every file in `skill.json`; unlisted files are
not discovered by `require()` analysis. Vendor JavaScript dependencies on your
computer; check their legacy syntax and licenses. Binary `.node` / `.so` modules
and nonempty package scripts are refused. A modern dependency can be valid
JavaScript for the computer and still fail on Jibo.

The generated README and `.gitignore` are not shipped by default. Keep
`.skill-kit/` private and ignored; it contains allocation/request state, not SSH
secrets. Never put credentials in `app.json`, packed config, screenshots or git.

## All high-level kit commands

| Command | Required arguments | Options / behavior |
| --- | --- | --- |
| `new <name>` | None | Optional `--template <name>`; starts from hello; offline |
| `check <project-or-pack>` | One path | Optional `--syntax-node <local-path>`; offline |
| `pack <project>` | `--out <directory>` | Optional `--syntax-node`; offline, no signing |
| `info` | `--robot <SSH-host-or-alias>` | Reads advertised protocol/kinds/paths/Allow state |
| `install <project>` | `--robot` | Optional `--timeout <seconds>`, `--syntax-node`; validates, allocates once, checks on Jibo, queues and polls past your approval/pending restart, not merely upload or accepted bytes |
| `status [project]` | `--robot`; use project, `--request <id>`, or `--list` | `--request` and `--list` are mutually exclusive |
| `remove <project>` | `--robot` and exactly one of `--keep-data`, `--erase-data` | Optional `--timeout`; queues removal and still requires the physical final tap |

All remote commands support `--be-root`, `--node`, `--state-root`. Defaults:

| Option | Default robot path |
| --- | --- |
| `--be-root` | `/opt/jibo/Jibo/Skills/@be/be` |
| `--node` | `/usr/bin/node` |
| `--state-root` | `/opt/home/jibo-skill/.local/share/phoenix/test-builds` |

These are installation/manager paths, not your app's saved-data path. Use
`context.dataRoot` inside your app. Each low-level remote operation reads info
and checks protocol/readiness and exact configured paths. Do not guess a new
state directory or copy a newer CLI into older robot software.

The timeout defaults to 600 seconds and accepts 1–3,600. The same wait budget
covers approval and the pending restart/trial. A timeout stops the
computer's wait, **not the queued change**, and preserves recovery identity.
Duplicate flags, shell fragments in robot names and unrecognized options are
refused. There are no `approve`, `enable`, `logs`, remote tap or Store publish
commands.

## Inspect support, then install with physical approval

```sh
ROBOT=my-jibo
node tools/skill-kit/cli.mjs info --robot "$ROBOT"
node tools/skill-kit/cli.mjs install my-touch --robot "$ROBOT" --syntax-node "$NODE_6_5"
```

1. First open **Settings → Developer testing → Allow test builds** on Jibo.
   Read **Allow test builds?** and physically tap **Allow test builds**.
2. Run install. The kit checks support/Allow before writing allocation state,
   asks Jibo for a local project identity, packs/checks that exact build, then
   queues a request. A cached project still gets the support checks.
3. When idle, Jibo opens **Install test build?** automatically. Otherwise open
   **Settings → Developer testing → Test builds**, then the **Needs a tap** row.
   Updates say **Update test build?** and keep the previous test's saved data.
4. Check name/version/build summary, tap **What it can do**, read every permission
   page, and use **Continue** until the full-access warning appears.
5. On **Full access to Jibo’s software**, read the warning and physically tap
   **Install full-access test**, or **Decline**. There is no local button named
   Approve. Voice, Agent, SSH and submitted code cannot authorize this tap.
6. Approval text is not startup proof. Read `status --list` and require
   `runtimeState: "running"`, as well as **Running** in Test
   builds. `installed` alone can precede a pending restart; the
   installer follows the same request through that restart trial
   within its wait budget. Then use the
   [opening path below](#opening-a-local-test) or inspect the service's own
   health. Changes may wait for idle and restart Jibo's software through
   the host's normal path.

Jibo shows the same warning for every test build:

> This test app can access files, accounts, network and system features, and may
> break Jibo or expose private information. Automatic checks do not mean it is
> safe. Only test code you trust.

Every new/changed build needs physical approval. A successful or unresolved
identical retry reuses its request ID. After a confirmed `failed`, `canceled`,
`declined`, or `expired` request, another explicit install creates a fresh
request ID and needs a fresh physical tap without changing the bytes. A new
local app ID does not isolate global names, menu entries, plugins, package
namespaces or listening ports. Remove a named conflicting installed app through
its normal removal flow before trying again.

## Opening a local test

On Jibo **13.8.0**, Home lists a running local test's entries after the Skill
Store entries, prefixed **LOCAL / Test —**. Open Home by touch and choose your
entry; Settings entries registered by a local test get the same prefix. Local
voice aliases are not registered. Paused, disabled, recovery-required and
Allow-off tests do not get launchable entries, and a background service has
no entry at all.

Software that does not advertise the local test protocol cannot install local
tests, so check `info` rather than a version number. The Test builds detail
screen has **Remove**, not an Open button, and there is no kit `open` command.
Reinstalling or adding a voice alias does not create a menu entry; register a
launcher in `registerLaunchers()` as the starters do.

### Local capacity and request limits

Only **one skill test build** can be installed at a time. Updating that same
project replaces its build; a second project must wait until the first is removed.
Other local-manager ceilings are 4 outstanding local requests and 256 MiB for
the local test tree. Staging checks additional space for the artifact, unpacked
contents and 8 MiB reserve.

A physical approval request expires after 15 minutes. The local transfer has an
8-second inactivity limit and a 90-second total frame limit. The manager allows
six content validations per hour and retains at most 10 local project records.
Removing a build is not a project-record deletion: reuse your existing project
rather than allocating a new one for each edit. These are manager limits, not
changes to the CLI's 600-second default wait.

## Iterate and recover a request

Edit source, update declarations/files, run check, then run install again from
the same project with the same SSH alias/path options. Keep `.skill-kit/` so
the kit can reuse allocation and retry IDs. Bump `version` to make iterations
clear. Changed packed bytes are a new build even when version is unchanged.

```sh
node tools/skill-kit/cli.mjs status my-touch --robot "$ROBOT"
node tools/skill-kit/cli.mjs status --robot "$ROBOT" --list
node tools/skill-kit/cli.mjs status --robot "$ROBOT" --request "$REQUEST_ID"
```

After SSH disconnect or timeout, read status before submitting again. An
unresolved disconnect or timeout leaves the original request possibly live, so
check it first. A confirmed `failed`, `canceled`, `declined`, or `expired`
request retires that attempt: run `install` again from the same project with the
same connection options to create a fresh request ID and physical tap, even with
unchanged bytes. If Allow is turned off after queueing, the CLI prints that the
request remains queued until Allow is back on (a restart cancels that queued
request) and an exact low-level cancel command. Copy **that** command, including
your connection options, if you want to cancel; do not invent or normalize an
ID.

## Pause, resume and remove

Approved tests persist and run across restarts/reboots while **Allow test
builds** is on; there is no automatic expiry or 24-hour session. Turning Allow
off and confirming **Turn off** stops tests but retains code/data. Physically
turning Allow back on resumes previously approved tests, subject to ownership,
integrity and collision checks. Resuming may wait for idle and restart.

```sh
node tools/skill-kit/cli.mjs remove my-touch --robot "$ROBOT" --keep-data
# Or choose erase instead; never pass both:
node tools/skill-kit/cli.mjs remove my-touch --robot "$ROBOT" --erase-data
```

Removal works with Allow off. Review **Remove test build?**, check **Keeps this
test’s saved data.** or **Erases this test’s saved data.**, then physically tap
**Remove test build**. Choosing Keep/Erase alone is not approval. Check
**Test build removed.** and terminal `removed`. The Skill Store version and its
saved data are not removed by this local-test operation.

## Debugging without a new protocol endpoint

The kit has **no per-skill logs command** and does not disclose a stable installed
app-data directory. Add bounded app diagnostics under `context.dataRoot`, record
the chosen relative filename, and read that exact file through your existing
authorized SSH shell. Use a prefix containing your app/release identity and a
short stage/error code. Do not dump whole inventories, account files or all
system logs into support tickets.

For renderer problems, use the installed release's authorized Electron/Chrome
debugging session if enabled. In its console, inspect your view ID, current-view
ownership, component bounds/input lock, transition state and your own errors.
Do not assume a fixed remote-debugging port or expose DevTools to the LAN. This
kit does not enable a renderer inspector or include a browser simulator.
Chrome 53 layout/asset behavior is the target, not your desktop browser.

Debug in layers: kit syntax/pack → robot refusal/status → lifecycle health →
view transition → physical screen/touch/audio/microphone. A unit-test double,
synthetic ASR result or preview does not validate those physical devices.

## Share your skill

Publishing skills to the Skill Store isn't available yet, and this kit does not
submit anything to it. A local pack is not a Store release.

To let someone else try your skill, share the project folder without its
`.skill-kit/` folder. They install it on their own Jibo with this kit and
confirm it on their Jibo's screen, exactly as you did. Ask them to install only
skills from people they trust: a skill runs with full access.
