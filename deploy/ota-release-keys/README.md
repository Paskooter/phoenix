# Phoenix OTA release keys (public halves)

The official Phoenix robot image pins these keys in its OTA signature gate, and the release tools
sign and verify with them by default. Format and checks: `docs/OTA-RELEASE-SIGNING.md`.

| key id | role | SPKI DER SHA-256 |
| --- | --- | --- |
| `phoenix-ota-20261112` | current: signs releases | `c46cdf736ca2d00e8627d69cf16ca31498f4928c105bd73271a1db96e3fc2917` |
| `phoenix-ota-20261112b` | next: pinned now so a rotation needs no flag day | `afd76565a14d0ac73d5ae97bf43d29dbcaaa2cc4abc2cc7d8016d24b53ab3b3b` |

`release-keys.json` lists both with the SHA-256 of each `.pub.pem` file. Both loaders
(`scripts/ota-release-keys.mjs` and `load_pinned_ota_release_keys` in
`deploy/robot-patches/bake_jibo_io_native_image.py`) refuse the set unless there is exactly one
`current` key, at most one `next` key, every file matches its hash, and every key is an RSA public
key of at least 3072 bits. This directory never holds private key material.

The private keys are RSA 3072, kept outside Git on the release machine (mode 0600) with an
encrypted backup. They are never copied to a server, CI or a repository.

**Rotation:** sign with `next`; a new `next` key is generated and pinned; the old `current` key
is removed from this set. Robots running an image that pins the old pair keep accepting releases
signed by the new `current` key, so they can be updated to an image that pins the new pair.
