# Phoenix documentation

Start with the [main README](../README.md) for what Phoenix is and how to run it. This page is
the index of everything under `docs/`.

## Using Phoenix

| Document | What it covers |
|---|---|
| [RUNBOOK.md](RUNBOOK.md) | Stand up a server and point a real robot at it, start to finish |
| [OPERATIONS.md](OPERATIONS.md) | Running the stack (native and Docker), the extension services, public hosting, verification commands |
| [DEPLOYMENT.md](DEPLOYMENT.md) | The full public deployment: Compose behind nginx, DNS and certificates, firewall, backups, upgrades, troubleshooting |
| [SECURITY.md](SECURITY.md) | Production launch gate, private-port topology, container/native hardening, proxy controls and pitfalls |
| [VOICE-TURN-OBSERVABILITY.md](VOICE-TURN-OBSERVABILITY.md) | Privacy-safe per-turn ASR → parser → skill latency spans and operator guidance |
| [portal-nginx-hosting.md](portal-nginx-hosting.md) | Hosting just the web portal behind nginx |

## Reference

| Document | What it covers |
|---|---|
| [CLASSIC-SERVICES.md](CLASSIC-SERVICES.md) | The robot's cloud API surface — every service, what it does, and what Phoenix implements |
| [DIVERGENCES.md](DIVERGENCES.md) | Where Phoenix deliberately behaves differently from the original cloud, with the reason for each |

## Engineering evidence

| Location | What it holds |
|---|---|
| [parity/](parity/) | The task ledger, per-task evidence and acceptance records, comparison reviews, hardware captures. This is the record behind every verified claim in the README. |
| [internal/](internal/) | Historical process records — work logs, plans, handoff notes and test runbooks from the build. Not user documentation; kept because it explains how the project got here. |

Package-level documentation lives next to the code: `packages/gateway`, `packages/nlu`,
`packages/skills`, `packages/history`, `packages/data`, `packages/ota`, `packages/account`,
`packages/classic`, `packages/harness`, and `services/parakeet-asr`.
