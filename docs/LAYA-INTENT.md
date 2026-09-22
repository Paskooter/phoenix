# Private Laya intent fallback

Phoenix can use a self-hosted Laya classifier as a fast fallback after the
robot's deterministic parser. It is not a replacement for grammar/entity
parsing yet: the initial `phoenix-core` profile accepts only entityless,
launchable/global intents and returns an explicit no-match for everything else.
That preserves a safe result for requests containing names, rooms, durations,
locations, dates, or other slots.

The service uses a fixed two-level decision tree:

```text
grammar (HIGH -> immediately return)
  -> Laya broad domain (information / home / play / system / unknown)
  -> Laya domain-local intent (at most a small fixed candidate set)
  -> validate intent + confidence + entityless catalog entry
  -> existing Phoenix NLU and skill routing
```

No request supplies prompts, candidate lists, model paths, or model URLs.
Laya is private infrastructure; never put its port behind `jibo.io`, nginx, a
public DNS record, or router NAT.

## Blackwell host deployment

Copy the repository's `services/laya-intent` directory to the GPU host, then:

```bash
cd services/laya-intent
cp .env.example /etc/phoenix/laya.env
chmod 600 /etc/phoenix/laya.env
# Edit only the protected file and set a unique token:
# LAYA_AUTH_TOKEN=<openssl rand -hex 32 output>

# Explicit one-time/upgrade preparation job. It first creates the root-owned
# Docker volume's `/models/laya` directory, then permanently drops to the
# unprivileged `phoenix` account before fetching the pinned model and writing
# file hashes. Normal serving has no model-download path.
docker compose --env-file /etc/phoenix/laya.env --profile bootstrap run --rm --build laya-model-fetch

# Start the single-worker, GPU-required, read-only serving container.
docker compose --env-file /etc/phoenix/laya.env up -d --build laya-intent
docker compose --env-file /etc/phoenix/laya.env ps
curl -fsS http://127.0.0.1:6973/readyz
```

The compose file binds `192.168.1.252:6973` by default, requires CUDA, runs as
an unprivileged user with no capabilities, and mounts the pinned model volume
read-only. Docker initially owns a named volume as root, so the explicit
one-shot bootstrap job has only `CHOWN`, `SETGID`, and `SETUID` long enough to
create that one directory; it then permanently becomes the same unprivileged
account before downloading anything. The serving container never receives
those capabilities. If the GPU, model manifest, or warm-up prediction fails,
`/readyz` does not report ready. Run exactly one Uvicorn worker; multiple
workers would load multiple copies of the model into VRAM.

Allow TCP/6973 only from the Phoenix VPS over an authenticated private route.
Keep the bearer token in `/etc/phoenix/laya.env` on the GPU host and the
Phoenix private environment on the VPS; do not commit it or enter it into a
browser configuration.

## Phoenix configuration and rollout

After `/readyz` succeeds and the VPS can reach the private address, set these
in `/etc/phoenix/jibo.io.env` (the token must equal `LAYA_AUTH_TOKEN`):

```dotenv
ETCO_parser_layaEnabled=false
ETCO_parser_layaUrl=http://192.168.1.252:6973
ETCO_parser_layaToken=<same private token>
ETCO_parser_layaProfile=phoenix-core
ETCO_parser_layaTimeoutMs=700
ETCO_parser_layaMinConfidence=0.85
ETCO_parser_layaSecondaryFallback=none
```

Leave it disabled initially. First replay the NLU corpus and record intent,
no-match, p50/p95 latency, and false-positive rates. Then enable a canary by
changing only `ETCO_parser_layaEnabled=true` and restarting `phoenix.service`.
HIGH-priority grammar matches never call Laya. A Laya timeout, bad token,
unavailable service, unexpected profile, non-leaf response, unknown response,
low confidence, or entity-bearing intent is a safe no-match; a valid
deterministic LOW parse remains available.

`ETCO_parser_layaSecondaryFallback=llm` is optional during evaluation. Keep it
as `none` when the goal is to remove LLMs from intent classification; it does
not affect LLM use by the answer skill.

## Verification

Run the API contract tests without a GPU:

```bash
cd services/laya-intent && pytest -q tests
cd ../.. && node --test packages/nlu/test/layaFallback.test.js
```

Do not promote the generic checkpoint as a full 622-intent replacement without
a held-out, source-derived evaluation and confidence calibration. Add
additional server-owned leaf profiles only after their candidate set, supported
entity behavior, and downstream skill routing have each been replayed.
