# W3 — server-side socket / cert / region configuration (region `api`)

Branch `w3/sockcert`. Scope: the server-side configuration that decides (a) what region an
adopted robot is told to use, and (b) whether the serving certificate covers the names the
robot builds from that region.

Evidence labels: **VERIFIED** (observed in source or by running a command), **INFERRED**
(reasoned from source, not directly exercised), **UNKNOWN**.

## 1. Every region-default / `phx` literal site (excluding `docs/parity/**`)

| # | Site | What it is | Label |
|---|------|-----------|-------|
| 1 | `packages/account/src/portalApi.js:190` (now `:220`) | `ETCO_account_region \|\| 'phx'` — the region written into an adopted robot's `credentials.json`. **The only real `phx` region default in code.** | VERIFIED |
| 2 | `.env.example:10` | `ETCO_account_region=phx` — a live config default copied by operators. | VERIFIED |
| 3 | `scripts/ensure-tls-certs.mjs:27` | `PHOENIX_TLS_REGIONS \|\| 'api'` — the region whose `<r>.jibo.com` / `<r>-socket.jibo.com` names go on the serving cert. Default is **api**, and it is **independent of `ETCO_account_region`**. | VERIFIED |
| 4 | `scripts/parity-robot/repoint-robot.sh:69,199,535` | `EXTRA_REGIONS="api"`, `LIVE_REGION` read from the robot's system-manager, and the Jetstream override defaults `region="api"`. | VERIFIED |
| 5 | `scripts/point-robot-at-phoenix.sh:132` | Region rewrite fallback `var region="api"`. | VERIFIED |
| 6 | `scripts/run-compose-stack.sh:58` | `ETCO_account_region="${ETCO_account_region:-}"` — empty pass-through; the dotenv loader then keeps the `.env` value (phx). | VERIFIED |
| 7 | `docs/OPERATIONS.md:274` | `ETCO_account_region=your-region  # must match the robot's region` (correct guidance, doc only). | VERIFIED |

Cosmetic `phx` (temp-dir prefixes `phx-*`, backup suffixes `.phx-bak*`, log filenames
`/tmp/phx-*.log`, python `phx` variable names) are **not** regions and were left alone.

**Correction to the tasking:** `scripts/ensure-tls-certs.mjs` does **not** derive its names
from `ETCO_account_region`; it reads `PHOENIX_TLS_REGIONS` (`:26-29`, `:41-51`) and already
defaults to `api`. So the cert side was never the bug — the outlier was the account side
(`portalApi.js`) plus `.env.example`, both of which said `phx`. VERIFIED.

## 2. What the robot's socket URL must be, and cert coverage

- The robot's region is `api`. It builds REST = `https://api.jibo.com` and, natively,
  socket = `wss://api-socket.jibo.com:443/{token}` (`packages/classic/test/notificationLifecycle.test.js:173-178`). VERIFIED (source).
- Regenerating the cert with defaults produced SANs
  `DNS:localhost, DNS:api.jibo.com, DNS:api-socket.jibo.com, IP:127.0.0.1, …` — both robot
  names present. Command: `PHOENIX_TLS_HOME=$(mktemp -d) node scripts/ensure-tls-certs.mjs`. VERIFIED (ran it).
- Real TLS handshake against that cert (see probe below): `api.jibo.com` PASS,
  `api-socket.jibo.com` PASS, `phx.jibo.com`/`phx-socket.jibo.com` **FAIL**
  (`ERR_TLS_CERT_ALTNAME_INVALID`). VERIFIED.

**Conclusion: `cert_covers_robot_name = true` for region `api`. No cert regeneration is
needed**, and the live cert (root reported SANs `api.jibo.com`, `api-socket.jibo.com`)
already covers it. The failure mode only appears if something writes `region: "phx"` into the
robot — which the old default did.

Reissue command (only needed for a non-default region, e.g. before first start):

```
PHOENIX_TLS_REGIONS=api node scripts/ensure-tls-certs.mjs
# or against a custom home dir:
PHOENIX_TLS_HOME=/path/to/tls PHOENIX_TLS_REGIONS=api node scripts/ensure-tls-certs.mjs
```

## 3. Socket mount & SNI

- The notification socket is attached to the **same** classic HTTP(S) server as the REST
  face: `packages/classic/src/index.js:129` → `attachNotificationSocket(service.server, hub)`.
  VERIFIED.
- Upgrade handler keys on the token at the **last path segment**, no fixed prefix
  (`packages/classic/src/notification.js:491-532`; `/{token}` and `/socket/{token}` both work
  — comment at `index.js:75` mentions `/socket/<token>` but the code is prefix-agnostic).
  Unknown token → `401`. VERIFIED.
- TLS server is a plain `https.createServer(tls, app)` with **no `SNICallback`**
  (`packages/common/src/service.js:132`). The server presents one cert regardless of SNI and
  does **not** itself require a particular SNI — the hostname requirement is entirely
  client-side (the robot validates the SNI name against the cert). VERIFIED (source).
- Port: `scripts/parity-robot/authenticated-stack.mjs` binds the classic server (REST +
  socket) to `entrypointPort` = 443 on `0.0.0.0` (`:55`, `:159-168`). The robot connects to
  `api-socket.jibo.com:443/<token>`. VERIFIED.

What the robot must send: SNI `api-socket.jibo.com` and path `/<token>` (or `/socket/<token>`).

## 4. Fix applied

- `packages/account/src/portalApi.js`: `'phx'` fallback replaced by an exported, documented
  `DEFAULT_ACCOUNT_REGION = 'api'` + `accountRegion(env)` helper; comment explains the cert
  coupling and that `phx` is not a real region.
- `.env.example`: `ETCO_account_region=api` with a corrected comment (the old one wrongly
  implied the region did not affect DNS/TLS).
- New test `packages/account/test/portalApiRegion.test.js` pins default `api`, rejects
  `phx`, and checks the adopt route end-to-end.

**Behaviour change (documented, not hidden):** `POST /api/admin/adopt` now writes
`region: "api"` instead of `"phx"` when `ETCO_account_region` is unset. This aligns it with
the cert default (`ensure-tls-certs.mjs`) and both robot scripts. No existing test asserted
the old value; `portalAuth.test.js`'s adopt test asserts only key shape. An explicit
`ETCO_account_region` still wins unchanged. Falsification: reverting the constant to `'phx'`
made both new tests fail (`not ok 1`, `not ok 2`).

## 5. Divergence candidates (not edited here)

1. `docs/parity/candidates/A-10-native-notification-source-20260907.md:122` quotes the old
   `ETCO_account_region || 'phx'` — now stale; the candidate doc should reference `api`.
2. A-10's TLS test (`packages/classic/test/notificationSourceContract.test.js:275`) uses
   `PHOENIX_TLS_REGIONS: 'phx'` as a synthetic region. That is a deliberate non-default
   region and is fine as test coverage, but it helped seed the false impression that `phx`
   is the real region; consider switching the fixture to `api` to match production.
3. Root's tasking said `ensure-tls-certs.mjs` derives names from `ETCO_account_region`; it
   does not (`PHOENIX_TLS_REGIONS`). Worth correcting in the task record.

## 6. Unknowns

- Whether the live deployed `/var/jibo/credentials.json` on the physical robot currently says
  `api` (root reports it does; not re-read here — read-only robot access was out of scope).
- Whether any deployment `.env` (not the example) still carries `ETCO_account_region=phx`.
  The account store contents were not inspected.
