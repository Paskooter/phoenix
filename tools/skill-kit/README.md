# Jibo skill kit

Make a skill for Jibo in JavaScript on your computer, then try it on your own
Jibo. Start with the skill guide: **Skills → Build a skill** on the Phoenix
Developers site, or `docs/SKILLS.md` in a Phoenix checkout.

The kit needs Node.js 20 or newer and no `npm install`. Run it from the
unzipped `jibo-skill-kit` folder (in a Phoenix checkout, from its root).

```sh
node tools/skill-kit/cli.mjs --help
node tools/skill-kit/cli.mjs new my-skill
node tools/skill-kit/cli.mjs check my-skill
node tools/skill-kit/cli.mjs pack my-skill --out out/my-skill
```

`new` starts from the **hello** starter. Add `--template touch-ui`,
`--template voice` or `--template network-service` for one of the other
starters. Every starter is the same kind of project.

In a Phoenix checkout you can run the kit's own tests (the download omits them):

```sh
node --test tools/skill-kit
# Optional exact legacy parsing in every starter smoke test:
# SKILL_KIT_NODE_6_5=/absolute/path/to/node-6.5.0 node --test tools/skill-kit
```

## Commands

| Command | Result |
| --- | --- |
| `new NAME [--template hello\|touch-ui\|voice\|network-service]` | New project from a starter; never overwrites |
| `check PROJECT_OR_PACK` | Validate without running your code |
| `pack PROJECT --out DIR` | Build the test container (`.phnative`) |
| `info --robot HOST` | Read what your Jibo supports and verify its fixed paths |
| `install PROJECT --robot HOST [--timeout SECONDS]` | Allocate once, check, pack, check on Jibo, queue, wait for your tap on Jibo, then follow the request through Jibo's restart to its final state |
| `status PROJECT --robot HOST` | The last request saved for this project and connection |
| `status --robot HOST --request ID` | One named request |
| `status --robot HOST --list` | All local request summaries |
| `remove PROJECT --robot HOST --keep-data\|--erase-data` | Queue removal, wait for your tap on Jibo and read back `removed` |

Remote commands accept `--be-root`, `--node` and `--state-root`. The defaults
and SSH setup are in the guide. The kit has no `approve`, `enable`, `logs`,
cloud, update or reboot command, and SSH host-key checks stay on.

## What happens on Jibo

Your skill runs inside Jibo's own software with the same access as his
built-in skills. The permissions in `app.json` describe what it does; they do
not limit it. Jibo checks every build himself, and you confirm each install on
his screen.

Turn on **Settings → Developer testing → Allow test builds** on Jibo first.
Jibo opens **Install test build?** himself when he is idle and a request is
waiting; otherwise open **Settings → Developer testing → Test builds** and the
**Needs a tap** row. Read **What it can do**, continue through the permissions
and the full-access page, then tap **Install full-access test** (there is no
button named Approve). Removal needs **Remove test build** after you choose
whether to keep or erase the test's data.

Approved tests keep running across restarts and reboots while Allow is on.
Turning Allow off pauses them and keeps their code and data; turning it back on
resumes them. Jibo refuses a test that collides with an installed app and names
the app to remove first. Test builds need a set-up Jibo with an owner and
compatible robot software; `info` shows what your Jibo supports.

An identical retry reuses its request. Keep the project's ignored `.skill-kit/`
folder so the kit can reuse its allocation and retry IDs; it contains no
passwords. Different SSH aliases or path settings keep separate state. After a
request ends `failed`, `canceled`, `declined` or `expired`, running `install`
again creates a fresh request that needs a fresh tap, even for unchanged bytes.
To make another build, change the source.

Publishing skills to the Skill Store is not part of this kit yet.

## Lower-level helpers

`ssh.mjs` speaks the test-build protocol directly, without the project
workflow. It still checks paths and capabilities first and cannot approve or
enable anything. Every command needs `--robot HOST`; path overrides use the
same defaults.

```sh
node tools/skill-kit/ssh.mjs info --robot "$ROBOT"
node tools/skill-kit/ssh.mjs project --robot "$ROBOT" \
  --kind native --name my-skill --client-request-id project-attempt-1
# Copy the exact returned IDs; do not use a Store app's identity.
node tools/skill-kit/ssh.mjs check --robot "$ROBOT" \
  --project "$LOCAL_PROJECT_ID" --file out/test.phnative
node tools/skill-kit/ssh.mjs queue --robot "$ROBOT" \
  --project "$LOCAL_PROJECT_ID" --file out/test.phnative \
  --client-request-id build-attempt-1
node tools/skill-kit/ssh.mjs status --robot "$ROBOT" --request "$REQUEST_ID"
node tools/skill-kit/ssh.mjs cancel --robot "$ROBOT" \
  --request "$REQUEST_ID" --client-request-id cancel-attempt-1
node tools/skill-kit/ssh.mjs remove --robot "$ROBOT" \
  --project "$LOCAL_PROJECT_ID" --keep-data --client-request-id remove-attempt-1
```

A manual `queue` or `remove` only returns the request; it does not wait. Check
that exact request until it is finished. A request whose `runtimeState` is
still `pending_restart` is not finished even if its state reads `installed` or
`resumed`. Cancelling discards a waiting request, not an installed skill.
`resume --project ID` is kept for older test managers; current test builds stay
installed while Allow is on.

`native-pack.mjs` wraps an existing unsigned artifact and file manifest in the
same test container. It checks hashes and, for declared icons, the archive and
image rules; a schema-1 wrap still needs `check` and Jibo's own inspection
afterwards. Its local app ID changes only the wrapper, not names or listeners
inside the artifact.

Declared icons produce container schema 2. `install` checks that Jibo's
`nativeContainerSchemas` includes `2` before any state, allocation or upload;
Jibo 13.8.0 advertises `[1, 2]`. Software without `2` gets an update
instruction, and the kit never silently drops your artwork. Projects without
icon fields keep schema 1. Custom artwork keeps the **LOCAL / Test** label. The
format contract is in the guide's manifest reference (`docs/skills/MANIFESTS.md`).

## Format and test boundaries

The kit's checks are implemented independently from the format contracts; no
robot software is included. Strict JSON and canonical helpers come from the
public theme kit. Tests use temporary projects, fake SSH children and synthetic
SDK interfaces; they never contact a robot or server. Checks parse your
JavaScript without running it. The host's Node accepts more syntax than Jibo's
Node 6.5: add `--syntax-node "$NODE_6_5"` (an absolute path to a trusted local
Node 6.5.0 executable) to check, pack or install for the exact parser. The kit
verifies that version, only compiles source in a bounded child and never
downloads a runtime. Jibo's own parser stays authoritative.
