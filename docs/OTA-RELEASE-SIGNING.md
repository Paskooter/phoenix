# Signed OTA releases

Official Phoenix OTA rows carry a detached signature made with an **offline** Phoenix release
key. The catalog passes it to robots unchanged. A robot image with the signature gate refuses a
package that is unsigned, signed by a key it does not pin, changed after signing, or older than
what it already runs. A server, including a self-hosted one that relays jibo.io's releases, can
pass a release on or hold it back, but it cannot change one or roll a robot back.

The robot half is the signature gate the official image builder bakes into the OTA downloader
(see "Robot gate" below). Robots without it (stock firmware, older Phoenix images) enforce
nothing. Stock firmware never sees the new field: the robot's `@jibo/jibo-server-client` JSON
parser keeps only the members modelled in the `Update` shape (`lib/json/parser.js`,
`translateStructure`).

## Format `phoenix-ota-release/1`

Each signed manifest row, and the `Update` record the catalog serves for it, has:

```json
"phoenixSignature": {
  "format": "phoenix-ota-release/1",
  "alg": "RSA-SHA256",
  "keyId": "phoenix-ota-20261112",
  "payload": "{\"format\":\"phoenix-ota-release/1\",\"keyId\":\"phoenix-ota-20261112\",\"id\":\"os-13.0.9-fcs\",...}",
  "signature": "<base64>"
}
```

The package download (`GET /ota/package`) of a signed row also sends the same object as
`x-phoenix-ota-signature: base64(JSON.stringify(phoenixSignature))`. Use whichever the gate can
reach: the downloader only gets a URL, and the JSON client drops unmodelled members unless the
image adds `phoenixSignature` to the `Update` shape. Both copies are the same signed bytes; a
relay must pass the header through unchanged.

- **Algorithm:** RSASSA-PKCS1-v1_5 with SHA-256 (`crypto.createVerify('RSA-SHA256')`, available
  on the robot's Node 6.9.2). RSA keys of at least 3072 bits; the signer refuses smaller keys.
  Public keys are SPKI PEM (`-----BEGIN PUBLIC KEY-----`).
- **Signed bytes:** exactly `Buffer.from(payload, 'utf8')`. Verifiers never rebuild the
  statement; they verify `payload` as served, then `JSON.parse` it.
- **Statement** (key order fixed, no whitespace):

  | key | meaning |
  | --- | --- |
  | `format` | `phoenix-ota-release/1` |
  | `keyId` | must equal the outer `keyId`; selects the pinned public key |
  | `id` | catalog update ID (`_id` on the wire) |
  | `subsystem` | `os`, `services`, `@be/be` (the BE skill), `oobe-config`, … |
  | `fromVersion` | the **manifest** value: `"*"` means any installed version. The wire `fromVersion` echoes the robot's own version for `"*"` rows, so do not compare it with this. |
  | `toVersion` | the version this package installs: **the anti-downgrade field** |
  | `filter` | the OTA channel the row was published in (`""`, `fcs`, `eau`, a ring filter) |
  | `dependencies` | exact required versions of other subsystems, keys sorted, values strings |
  | `length` | package size in bytes |
  | `sha256` | package SHA-256, lowercase hex (authoritative) |
  | `sha1` | package SHA-1, lowercase hex (equals the wire `shaHash`; lets a gate reject a mismatched record before downloading) |

### What a robot gate must check

1. `phoenixSignature` is present, `format` and `alg` are as above, and `keyId` is pinned in
   the image (pin the current and the next key so a rotation needs no flag day).
2. The signature verifies over `payload` with that key.
3. The statement `keyId` equals the outer `keyId`, and `subsystem` is the subsystem being
   installed. Where the gate also has the served record, `id`, `toVersion`, `filter`, `length`,
   `sha1` and `dependencies` equal its `_id`, `toVersion`, `filter`, `length`, `shaHash` and
   `dependencies`; otherwise install against the statement's `dependencies`, not the record's.
4. After download, the file's length and SHA-256 equal the statement.
5. **Anti-downgrade:** `toVersion` is strictly newer than the installed version of that
   subsystem, compared like `cmpVersion` in `packages/ota/src/catalog.js` (numeric dotted
   segments; a SemVer pre-release such as `13.7.0-dev.2` sorts below `13.7.0`). The catalog
   never offers the version a robot already runs, so an equal version is refused too.
6. If `fromVersion` is not `"*"`, it equals the installed version.

Anything else is refused with a log line naming the reason. The reference implementation of
steps 1-4 is `verifyRow` in `packages/ota/src/releaseSignature.js` (reasons: `unsigned`,
`unknown-format`, `malformed`, `mismatch:<field>`, `untrusted-key:<id>`, `bad-signature`).

## Signing a release (publish kit)

Sign after the package is final and, for BE, after `scripts/be_ota_integrity.py` passes. The
kit runs the gate itself and refuses to sign a BE row (`@be/be`, or the short form `be`) without it:

```sh
scripts/ota-release-kit.sh --manifest manifest.json --data-dir <ota data dir> \
  --out manifest.signed.json --ids <new row ids> \
  --key /media/offline/phoenix-ota-YYYYMMDD.pem --key-id phoenix-ota-YYYYMMDD \
  --pubkey phoenix-ota-YYYYMMDD.pub.pem \
  --official-base ../jibo-be/.release-inputs/jibo-be-11.0.1.tar.gz
```

It writes a new manifest (never overwrites), then verifies it with the public key. Sign every
row the release adds, one per filter, because the ID and filter are signed. Re-sign after any
change to a row or rebuild of its package: the catalog logs `release signature does not match
this package` and serves such a row unsigned. The output then goes through the normal reviewed
catalog change and `scripts/deploy-native-release.sh`; the kit publishes nothing.

The release key is created once by the owner on an offline machine and never copied to a
server, CI or Git:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -aes-256-cbc -out phoenix-ota-YYYYMMDD.pem
openssl pkey -in phoenix-ota-YYYYMMDD.pem -pubout -out phoenix-ota-YYYYMMDD.pub.pem
```

An encrypted key reads its passphrase from `PHOENIX_OTA_KEY_PASSPHRASE`. Only the `.pub.pem`
goes into the robot image.

`node scripts/sign-ota-release.mjs verify --manifest <m> --data-dir <d> --pubkey <keyId>=<pub.pem>`
checks an existing manifest the same way.

## Robot gate (official image)

`deploy/robot-patches/bake_jibo_io_native_image.py` patches the robot's OTA downloader
(`@jibo/jibo-ota-updater/src/download-update.js`, run by the system manager for every package)
with the checks above. Build the official image with the public key(s) pinned:

```sh
python3 deploy/robot-patches/bake_jibo_io_native_image.py ... \
  --ota-release-pubkey phoenix-ota-YYYYMMDD=phoenix-ota-YYYYMMDD.pub.pem
```

Pin the current key and, once it exists, the next one (at most two). The builder refuses a
private key, a key under 3072 bits and an image without a pinned key; `--no-ota-signature-gate`
builds an ungated image for private tests only and the manifest records it
(`ota_signature_gate.enabled: false`).

How the downloader applies the checks:

- It reads the signature from the `x-phoenix-ota-signature` header of the package download,
  because the system manager hands it only `--id --url --destination --shasum`.
- The statement is bound to what the system manager will install: signed `id` equals `--id`,
  signed `sha1` equals `--shasum` (the record's `shaHash`), and `--destination` ends in
  `/<toVersion>-<subsystem>.tar`, the cache name the system manager builds from the record. A
  record therefore cannot relabel a signed package as another subsystem or version.
- The installed version comes from the system manager's own sources: `jibo-version` (os),
  `jibo-service-version` (services), and `/opt/jibo/Jibo/Skills/<subsystem>/package.json`
  (skills; a skill that is not installed counts as `0.0.0`).
- Everything is checked before a byte is written; the length and SHA-256 are checked again at
  the end. A refusal deletes the partial file, exits 1 (the system manager reports a failed
  download) and logs one syslog line: `Phoenix OTA gate refused update <id>: <reason>`.

Consequences for publishing to a gated robot: every row it may install must be signed,
including ring and test rows and admin uploads, and a version it already runs (or an older
one) is never installed again, even under a new update ID.
