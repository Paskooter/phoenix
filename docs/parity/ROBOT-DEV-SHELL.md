# Driving a robot: the skills-service-manager dev shell

Recovered from `jibo-cli@10.2.0-364768d` in the archive npm registry
(`https://pvindex.org/npm/jibo-cli`) on 2026-09-17, because the CLI itself will
not install — its dependency tree pins `animation-utilities@test-latest`, a
dist-tag that does not exist in the archive. The protocol is simple enough to
use directly, so this file records it rather than reviving the CLI.

## The protocol

Every call is `POST http://<robot>:8686<path>` with a JSON body (`{}` when the
endpoint takes no arguments). 8686 is `DEV_SHELL_PORT`; the robot's own service
registry lists it as `dev-shell`.

| path | body | what it does |
| --- | --- | --- |
| `/run` | `{"dirName": "<skill>"}` | launch a skill |
| `/stop` | `{}` | stop the running skill |
| `/index` | `{}` | re-index installed skills (**run after installing one**) |
| `/sync-skill` | `{"dirName": "<skill>"}` | open the upload server, then PUT the tree to port **8989** |
| `/delete-skill` | `{"dirName": "<skill>"}` | remove one skill |
| `/delete-all` | `{}` | remove every skill |
| `/version` | `{}` | build version (Aero answered `13.0.0`) |
| `/diskspace` | `{}` | free space |
| `/reboot`, `/poweroff` | `{}` | power control |
| `/setvolume` | `{"volume": 0.0-1.0}` | volume |
| `/getvolume` | `{}` | volume |
| `/wifi-list`, `/wifi-current`, `/wifi-verify` | `{}` | networking |
| `/wifi-select` | `{"ssid"}` | join a known network |
| `/wifi-add` | `{"ssid","pswd"}` or `{"ssid","ip","gw","mask","dns1","dns2","staticIP":true}` | add a network |
| `/wifi-remove` | `{"ssid"}` | forget a network |

## `/run` takes the PACKAGE name, not the directory name

This is the trap, and the parameter being called `dirName` is what makes it one.
`_startSkill` fetches `SystemManagerClient.instance.list()` and matches
`skill.name === skillName` — that list is keyed by the **package name** from the
skill's `package.json`, not by its directory under
`/opt/jibo/Jibo/Skills/`. Measured on Aero:

```
/run {"dirName":"phoenix-be-11-0-1-parity"}    -> 404 Skill phoenix-be-11-0-1-parity not found
/run {"dirName":"@be/phoenix-parity-11-0-1"}   -> Skill "@be/phoenix-parity-11-0-1" started successfully
```

The directory is `phoenix-be-11-0-1-parity`; the package name is
`@be/phoenix-parity-11-0-1`. Read `package.json` and use `.name`.

The CLI's own docstring says skills are "organized in a flat directory in
`/jibo/skills`". That path does not exist on either robot here — it is the SDK's
conceptual view, and the dev shell resolves the real location itself. Do not go
looking for it.

## Installing a skill by hand (what `jibo sync` automates)

Copying a slot between robots works, but three things bite:

1. **Filesystem size.** A freshly reflashed robot may have a filesystem far
   smaller than its partition, because the first-boot resize never ran. Aero:
   `/opt` reported 300.6 MB inside a 10.2 GB `mmcblk0p6`. `resize2fs
   /dev/mmcblk0p6` (online, ext4, growth-only) took it to 10.1 GB. Check
   `/proc/partitions` against `df` before concluding there is no room — BE 11.0.1
   alone is 567 MB.
2. **Directory permissions.** The skill host runs as `jibo-ski`. Aero's
   `/opt/jibo/Jibo/Skills` was `drwxr-x--- root:wheel`, which that user cannot
   traverse; Moth's is world-traversable. `chmod 755` the path down to the slot.
3. **Re-index.** `POST /index` after installing, or `/run` will not find the
   skill however correct the name is.

## Worked example

```bash
# from the host, with the slot already in /opt/jibo/Jibo/Skills/<dir>/
NAME=$(ssh root@<robot> 'node -e "console.log(require(\"/opt/jibo/Jibo/Skills/<dir>/package.json\").name)"')
curl -s -X POST http://<robot>:8686/index -H 'content-type: application/json' -d '{}'
curl -s -X POST http://<robot>:8686/run   -H 'content-type: application/json' -d "{\"dirName\":\"$NAME\"}"
```

## Where this came from

The archive MCP at `https://pvindex.org/mcp` (JSON-RPC; `initialize`, then
`tools/call` with `jibo_search` / `jibo_read` / `jibo_npm_view`) indexes the
Confluence wiki, the Gitea mirror and the npm registry. `SDK - CLI and Robot Use`
documents the CLI's user-facing commands (`jibo run`, `jibo sync`,
`jibo robot-list`, `jibo set-default-robot`, `jibo delete-all`, …); the wire
protocol above came from reading `lib/jibo-cli.js` inside the published tarball.
