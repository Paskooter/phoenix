# A-19 — original-client Jot conformance harness

Drives Phoenix's classic Jot face with the **genuine original robot client**
over **real SigV4-signed AWS-JSON**, on the client's own Node 8 runtime.

## Why this client

`@jibo/jibo-server-client@3.0.110` — the version the A-05 harness uses, and the
last one Jibo shipped — carries **28 API models and none of them is Jot**. The
Jot face was dropped from the client before the final release, so the obvious
"reuse the A-05 harness" approach cannot work.

Probing all 263 archived versions and bisecting gives an exact boundary:

| version | ships `apis/jot*` |
| --- | --- |
| 3.0.43 … 3.0.110 | no |
| **3.0.42** | **yes — `apis/jot-2016-05-12.min.json`** |
| 3.0.17 and older | yes (`jot-2016-01-26.normal.json`) |

**3.0.42** is the newest client that still carries Jot, and it carries exactly
the model Phoenix implements: `targetPrefix Jot_20160126`, `signatureVersion v4`,
operations `CreateMessage`, `ListMessages`, `MarkRead`, `MarkLoopRead`,
`NumberOfUnreadMessagesInLoops`.

No archived client version ever shipped the party-era `Jot_20160310` prefix,
which is independent corroboration that the party-era surface had no caller.

## What it runs

The model is registered through the SDK's own loader and the client built with
`AWS.Service.defineService`, so request construction, the `X-Amz-Target` header
and SigV4 signing are all the original client's — not a hand-rolled envelope.

Coverage:

- the five operations plus the direct bulk unread route
- membership and impersonation gates against an injected loop fixture
- cross-loop isolation
- the push fan-out triggered by a real `CreateMessage`
- durability across a service restart
- **TLS by default**, with the client verifying against the serving certificate

## Running it

```bash
node scripts/parity-a19-jot-sdk/run.mjs --out .parity/runs/a19-jot-sdk
```

Requires Docker (for the `node:8.9.4-slim` client runtime) and network access to
the pvindex archive on first run, which caches the client under the run
directory. It never contacts a robot.

## A note on the certificate

The harness generates its own certificate covering the container hostname the
client dials. That detail is load-bearing: **the node-8 aws-sdk fork hangs rather
than erroring when the certificate does not cover the host**, producing no output
at all. An earlier version of this harness used a certificate for `api.jibo.com`
and `127.0.0.1` while the client dialled the container hostname, and the
resulting silence was misread as "TLS does not work with this client". It does.
Run with `--no-tls` to fall back to plain HTTP.
