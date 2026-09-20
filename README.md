# Phoenix

**The Jibo robot's cloud, rebuilt.**

Jibo Inc. shut its servers down in 2019. Every robot in the world stopped pairing, stopped
talking, and stopped updating — the hardware was fine, the cloud was gone. Phoenix is a
from-scratch replacement for those services: the conversational backend (speech recognition →
language understanding → skills → response) and the robot's cloud REST API (accounts, pairing,
firmware updates, notifications, media, backups). A physical Jibo talks to it today.

No Jibo binaries ship here. Phoenix reimplements the protocols from the archived reference and
vendors only plain-text data — grammars, dialog scripts, word lists, manifests — so the whole
system runs on Node with nothing to download.

| | |
|---|---|
| **Runtime** | Node.js ≥ 20, ESM JavaScript, npm workspaces |
| **Dependencies** | one runtime dependency (`ws`) |
| **Tests** | Node's built-in test runner, plus a production parity gate |
| **Ports** | hub 9000 · report 9003 · chitchat 9004 · parser 9005 · history 9006 · data/lasso 9007 · color 9008 · answer 9009 · OTA 9010 · account+portal 9011 · Classic entrypoint 9012 |

## What works today

- **Conversation, end to end.** A robot opens a WebSocket to the hub, streams audio, and gets a
  spoken answer back: server-side voice-activity detection and ASR, a pure-JavaScript grammar
  engine for language understanding, intent routing, and graph-based skills (chitchat, personal
  report, question answering) with redirects and proactive turns.
- **Pairing, both kinds.** A factory-reset robot completes the real out-of-box QR handshake and
  receives its credentials; a robot that paired with the original cloud years ago is adopted with
  its existing identity. Both are driven from a bundled **web portal**.
- **Per-robot authentication.** The robot signs an AWS-style token request with its own stored
  keys; the hub verifies a JWT issued from it. Exercised against real hardware.
- **Firmware updates over the air.** The `Update` service serves OS and services packages built
  from a stock firmware buildroot, updating the inactive rootfs slot so per-robot calibration in
  `/var` survives.
- **The robot's cloud API.** One front door (`:9012`) answers the AWS-JSON RPC calls that
  `jibo-server-client` makes, dispatching by `X-Amz-Target` prefix. Working: account, loop, OOBE,
  settings, update, log, robot, notification (plus its push WebSocket), key, media and backup.
  `rom`, `person`, `ifttt`, `nlp` and `collision` are implemented to their wire contracts.
- **A web portal.** Sign up, add a robot by QR, watch it pair, manage household settings, and — as
  an administrator — adopt orphaned robots and edit server configuration.
- **A simulator path.** `scripts/run-sim-stack.sh` runs the same services on dev ports for a
  browser-based Jibo simulator (expected as a sibling `jibo-web-sim` checkout), which is the
  quickest way to talk to the system without hardware. Without a Parakeet server it falls back to
  a canned-transcript mock so the pipeline still runs.

## Quick start

```bash
npm install                      # links the workspaces; only `ws` is external
bash scripts/run-compose-stack.sh
```

The launcher prints its port map and writes one log per service to `/tmp/phx-compose-*.log`.
In another terminal:

```bash
curl -s http://localhost:9000/healthcheck            # ok
curl -s http://localhost:9000/v1/skills | head -c 200
curl -s http://localhost:9012/healthcheck            # robot Classic front door
open http://localhost:9011                           # the web portal
```

Then point a real robot at it — [docs/RUNBOOK.md](docs/RUNBOOK.md) is the step-by-step version.

**With Docker**, the same services (13 containers, reference port names):

```bash
docker compose up
node scripts/verify-compose-contract.mjs             # checks the running stack
```

## Requirements and configuration

Everything below is optional for a local run and documented in [`.env.example`](.env.example),
which is loaded automatically by every service and launcher.

| Setting | What it does |
|---|---|
| `PARAKEET_URL` | Address of a Parakeet ASR server (`POST /transcribe`). Speech is only transcribed when this is reachable; the built-in default points at `192.168.1.252:6972`. |
| `LLM_URL`, `LLM_MODEL` | OpenAI-compatible endpoint (for example LM Studio) used by the answer skill and as the parser's fallback. |
| `HUB_TOKEN_SECRET` | Required signing secret for hub/account robot tokens. Generate a unique random value; the hardened launchers refuse an empty secret in production. |
| `DISABLE_AUTH` | `false` (the production default) requires robot tokens. `true` is for isolated local development only. |
| `ETCO_account_region` | The `region` written into adopted robots' credentials. The robot builds `<region>.jibo.com` from it, so it must match the certificate. Defaults to `api`, the region a stock robot reports. |
| `PHOENIX_TLS_REGIONS`, `PHOENIX_TLS_EXTRA_NAMES`, `PHOENIX_TLS_HOME` | Which names the server's generated certificate covers, and where it is stored (`~/.local/share/phoenix/tls`). |
| `PHOENIX_ROBOT_ENTRYPOINT_PORT` | Port for the robot-facing TLS listener when it should not be 443. |
| `PHOENIX_PORT_OFFSET`, `PHOENIX_LOG_DIR` | Shift every service port, and choose where launcher logs go. |
| `OTA=0`, `ACCOUNT=0`, `CLASSIC=0` | Turn off the extension services the launcher starts by default. |

Three things worth knowing before pointing hardware at it:

- **A real robot's hostnames are baked in.** The native client resolves `<region>.jibo.com` and
  `<region>-socket.jibo.com` and hardcodes port 443. Serving a robot means redirecting those
  names to your host and installing a CA it trusts. Phoenix generates its own CA and serving
  certificate on first start; the [runbook](docs/RUNBOOK.md) covers the redirect, the trust
  install, and how to verify it from the robot's own logs.
- **Robot Classic requests are not signature-verified.** The original per-account signing keys
  are unrecoverable, so the Classic front door must be kept behind the TLS edge plus a VPN/source
  firewall. Keep the loopback `:9012` backend private; the
  [deployment guide](docs/DEPLOYMENT.md) shows the public topology and hardening steps.
- **OTA packages are built locally, not shipped.** `scripts/build-ota-packages.sh` turns a stock
  firmware buildroot into OTA packages; they are large, machine-specific artifacts and are not in
  the repository.

## Architecture

```
        robot (Jetstream, native client)                 robot's jibo-server-client
                    │  wss :9000/listen                              │  https :443
                    ▼                                               ▼
              ┌───────────┐                                   ┌──────────────┐
              │    hub    │  audio → VAD+ASR → NLU → route    │   Classic    │  one AWS-JSON
              │ (gateway) │──────────────────────────────┐    │  entrypoint  │  endpoint,
              └───────────┘                              │    │    :9012     │  dispatched by
                    │                                    │    └──────────────┘  X-Amz-Target
                    ▼                                    ▼           │
              ┌───────────┐   ┌──────────────┐   ┌──────────────┐    ├─ OOBE/account/settings → :9011
              │  parser   │   │    skills    │   │ history/data │    ├─ update               → :9010
              │   :9005   │   │ 9003/9004/…  │   │ 9006 / 9007  │    └─ log/robot/notification/key/…
              └───────────┘   └──────────────┘   └──────────────┘       in-process
                                      │
                            ┌─────────┴──────────┐
                            │  web portal :9011  │  pair, adopt, settings, admin
                            └────────────────────┘
```

- **hub** (`packages/gateway`) — the robot's conversation socket: one WebSocket per listen
  transaction, ASR, routing, skill dispatch, proactive turns.
- **parser** (`packages/nlu`) — the grammar engine: launch rules, semantic actions, entity
  weights, priority arbitration, optional LLM fallback.
- **skills** (`packages/skills`) — the skill framework (graph state machines, dialog templates,
  prompt factories) plus the chitchat, report, answer, color, example and template skills.
- **history** (`packages/history`) and **data/lasso** (`packages/data`) — launch and speech
  history behind the proactive rules, and the weather/news/maps/calendar/credential relays the
  skills call.
- **ota** (`packages/ota`) and **account** (`packages/account`) — the two stateful companion
  services: firmware packages, and accounts/loops/tokens with the portal in front.
- **classic** (`packages/classic`) — the robot's single cloud front door, dispatching to the
  services above.

Each package has its own README with the details. The wire contracts (message envelopes, schemas,
error codes) live in `packages/contracts`.

## Testing

```bash
npm test                     # unit tests + parity checklist check + strict production gate
npm run test:unit            # unit tests only
npm run parity:status        # tracked work and the next ready item
node scripts/verify-compose-contract.mjs   # health + wire checks against a running stack
```

`npm run harness` runs the original-versus-Phoenix wire comparison for anyone working on
compatibility; see [packages/harness/README.md](packages/harness/README.md).

## Deployment

- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — stand up a server and point a real robot at it, start
  to finish.
- **[docs/OPERATIONS.md](docs/OPERATIONS.md)** — day-to-day operation: the launchers, the
  extension services, public hosting, and the verification commands.
- **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** — the full VPS/home-server deployment: Docker
  Compose behind nginx, DNS and certificates, firewall, backups, upgrades and troubleshooting.
- **[docs/SECURITY.md](docs/SECURITY.md)** — the production launch gate, private-port topology,
  container/native hardening, reverse-proxy controls and common deployment pitfalls.
- **[docs/portal-nginx-hosting.md](docs/portal-nginx-hosting.md)** — hosting just the web portal
  behind nginx.

## Project status

Phoenix is developed against a verified task ledger, and every claim above is tracked there with
its evidence. The percentage counts reviewed checklist tasks — planning and test tooling
included — not a share of server functionality.

<!-- parity-progress:start -->

![92.8% checklist completion — 77 of 83 tasks verified](docs/parity/progress.svg)

**92.8% checklist completion · 77/83 tasks verified.**

Counts only tasks whose full acceptance criteria and evidence have been reviewed. Candidate implementations do not count. This includes planning and verification tooling; it is not a percentage of server functionality.

| Track | Verified | Total |
|---|---:|---:|
| Planning | 3 | 3 |
| Verification tooling | 4 | 4 |
| Pegasus | 46 | 46 |
| Companion cloud | 20 | 20 |
| Restoration | 1 | 1 |
| Release | 3 | 9 |

[Verified checklist](docs/parity/TASKS.md) · [Execution plan](docs/parity/PLAN.md) · [Behavioral comparisons](docs/parity/PRODUCTION.md)

<!-- parity-progress:end -->

Open work, stated plainly: the over-the-air upgrade path is implemented and its packages build,
but a complete unattended upgrade on a robot has not been signed off; the app-dependent services
(media upload, Commander, push delivery) are implemented to their wire contracts and exercised
against the clients that exist, not against the dead mobile app; and microphone/wake-word and
physical-ring behaviour are unverified on hardware. `docs/parity/` holds the engineering
evidence trail — per-task evidence, acceptance records and comparison reviews — for anyone who
wants to check the work rather than take the summary's word for it.

## Documentation index

| Document | What it covers |
|---|---|
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | First-time setup ending with a talking robot |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Running, configuring and exposing the stack |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Full public deployment (Compose + nginx) |
| [docs/SECURITY.md](docs/SECURITY.md) | Production security baseline and launch checklist |
| [docs/portal-nginx-hosting.md](docs/portal-nginx-hosting.md) | Portal-only hosting behind nginx |
| [docs/CLASSIC-SERVICES.md](docs/CLASSIC-SERVICES.md) | The robot's cloud API surface and what is implemented |
| [docs/DIVERGENCES.md](docs/DIVERGENCES.md) | Where Phoenix deliberately behaves differently from the original cloud |
| [docs/README.md](docs/README.md) | Index of everything in `docs/` |
| [docs/parity/](docs/parity/) | Engineering evidence: task ledger, per-task evidence, comparisons |

## Credits

Phoenix reimplements the behavior of **Pegasus**, Jibo's conversational backend, from the
archived reference source and the robot's own wire protocol. Reference material for the
compatibility work lives at [`jiboV2/pegasus@phoenix`](https://pvindex.org/gitea/jiboV2/pegasus)
and its `docs/atlas/`.

There is no LICENSE file in this repository; `package.json` marks it private and `UNLICENSED`.
