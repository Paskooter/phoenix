# Authenticated development robot stack

`authenticated-stack.mjs` runs the reviewed Phoenix services with the actual
signed Account token issuer, shared Hub JWT verification, and the default AST
parser. A compiled parser profile is optional. It keeps running until stopped.
It does not install
robot configuration, trust certificates, tunnels, or a boot supervisor.

Supply an existing private Account store containing the robot's credentials,
a stable private Hub signing-secret file, and a TLS key/certificate trusted by
the robot. The store, secret and key must be regular files with mode 0600;
the run directory must have mode 0700. Keep these files outside Git. Do not
copy real credentials into a command line or this document.

```sh
PHOENIX_ENV_FILE=/dev/null \
PHOENIX_ROBOT_RUN=/private/phoenix/run \
PHOENIX_ROBOT_STORE_FILE=/private/phoenix/account.json \
PHOENIX_ROBOT_SECRET_FILE=/private/phoenix/hub-secret \
PHOENIX_ROBOT_TLS_KEY=/private/phoenix/server.key \
PHOENIX_ROBOT_TLS_CERT=/private/phoenix/server.crt \
node scripts/parity-robot/authenticated-stack.mjs
```

To opt into the compiled parser, install the bundle using the existing
[portable parser deployment procedure](../../docs/parity/candidates/N-08-snapshot-deployment-20260907.md).
Then set `PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST` to its private `profile.json`.
The launcher verifies the snapshot before it opens services. Without that
setting it uses AST, including the accepted N1 divergence. It does not enable
a pending GQA profile or LLM fallback.

The default Hub port is 19000; skills, parser, history and data use offsets
3, 5, 6 and 7. Account binds to loopback at offset 11. The Classic TLS entrypoint listens on port 443 (all interfaces by default, so real robots on the LAN can reach it) and hosts both its
HTTP routes and notification WebSocket upgrades on the same TLS server. Override the base port with
`PHOENIX_ROBOT_PORT`, or the TLS port/bind host with
`PHOENIX_ROBOT_ENTRYPOINT_PORT` and `PHOENIX_ROBOT_ENTRYPOINT_HOST`.
A base/TLS port of zero allocates ephemeral ports for isolated tests.

`PHOENIX_ROBOT_PUBLIC_URL` controls Classic-generated public URLs (default
`https://localhost`). The ASR backend is configured through
`ETCO_server_parakeetUrl`. For the existing Moth profile, robot localhost
forwarding and a trusted development CA are separate, guarded deployment steps.
Changing the entrypoint does not authorize wiping a robot or replacing its keys.

The private `authenticated-stack.json` receipt records the loaded revision,
ports, parser fingerprint and PID. The launcher does not capture message or
audio bodies and has no diagnostic trace-size shutdown threshold. Normal
service logs still go to stdout/stderr; use the deployment supervisor's bounded
log retention. SIGINT/SIGTERM closes its sockets and listening servers.

This is a development process launcher, not a claim of complete cloud parity.
Only CreateHubToken has the reviewed Classic signature verifier; other Classic
operations retain their documented boundaries. Account credentials/signing
secret survive process restarts through the supplied files. Complete history
and notification durability, and host/robot reboot
supervision remain separate tracked work. Inspect the current parity ledger
before deploying a later integration.

The launcher keeps notification tokens and pending source-shaped documents in
`notifications.json` inside its private run directory. This supports process
restart recovery. The launcher shares its Account Store with the signed
Notification resolver and attaches the durable Loop-save publisher after
Classic is listening. Startup retries retained outbox rows.
The profile operations have a bounded
[real robot delivery check](../../docs/parity/evidence/2026-09-08/hardware/loop-profile/review.json):
native frame, original dispatcher, household save and KB readback all agree.
`LoopUpdated` is a background sync message; it does not display a popup.
Other producers, distributed transport and complete failure/durability behavior
remain open.

For robot KB verification, use the exact slice name reported by the installed
SDK. Its LoopManager uses `jibo/loop`, so the read endpoint is
`/v1/kb/jibo%2Floop/node/loadRoot`. Adding a leading slash can select a second
cached database instance and return stale state. Preserve captures privately.

For a supervised Linux user service, install
[`phoenix-robot@.service`](phoenix-robot@.service). Each instance reads only its
own environment file and runs a reviewed checkout selected by a `current`
symlink. For example, `phoenix-robot@moth.service` uses:

- `~/.config/phoenix/moth.env`: the file-path settings shown above, mode0600;
  include `PHOENIX_ENV_FILE=/dev/null` and use absolute paths.
- `~/.local/share/phoenix/moth/current`: a symlink to the reviewed, frozen
  checkout with its installed dependencies. Switch it only while stopped.
- `PHOENIX_ROBOT_RUN`: a private persistent directory for the launcher receipt,
  notification state and backups.

Install the template under `~/.config/systemd/user/`, then run
`systemctl --user daemon-reload` and
`systemctl --user enable --now phoenix-robot@moth.service`.
`systemctl --user restart phoenix-robot@moth.service` applies a reviewed
configuration change. An explicit stop stays stopped; an unexpected process
failure restarts after two seconds, with a five-start limit per minute.
The service controls its whole process group during shutdown. This template
uses `/usr/bin/node`; adjust that path when Node is installed elsewhere.

The user manager must be available for unattended operation. Check
`loginctl show-user "$USER" -p Linger`; enabling lingering is a separate host
configuration action. Robot trust/configuration and reverse SSH forwarding
remain separate deployment dependencies. A passing process-recovery test does
not establish successful host or robot reboot recovery.
