# Authenticated development robot stack

`authenticated-stack.mjs` runs the reviewed Phoenix services with the actual
signed Account token issuer, shared Hub JWT verification, and the installed
portable parser profile. It keeps running until stopped. It does not install
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
PHOENIX_NLU_COMPILED_SNAPSHOT_MANIFEST=/private/phoenix/parser/profile.json \
node scripts/parity-robot/authenticated-stack.mjs
```

Install the parser bundle using the existing
[portable parser deployment procedure](../../docs/parity/candidates/N-08-snapshot-deployment-20260907.md).
The launcher verifies the snapshot before it opens services. It selects the
compiled profile explicitly; it does not change the repository's default parser
or enable a pending GQA profile or LLM fallback.

The default Hub port is 19000; skills, parser, history and data use offsets
3, 5, 6 and 7. Account binds to loopback at offset 11. The Classic TLS entrypoint listens on loopback port 19443 and hosts both its
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
secret survive process restarts through the supplied files. History durability,
automatic LoopUpdated delivery, and host/robot reboot
supervision remain separate tracked work. Inspect the current parity ledger
before deploying a later integration.

The launcher keeps notification tokens and pending source-shaped documents in
`notifications.json` inside its private run directory. This supports process
restart recovery. Account-to-notification publishing and verified notification
account resolution remain explicit integration work; the local outbox seam is
not selected by this launcher. Notification identity and robot acceptance stay open.
