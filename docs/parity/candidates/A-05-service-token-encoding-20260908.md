# A-05 service-token Base58 encoding follow-up

Status: **root accepted for token encoding only; full A-05 remains unverified**.

Root verified the pinned package archive integrity and compared 1,030 deterministic
vectors against the actual archived encoder under Node 8.9.4. All matched the
integrated candidate. The combined candidate passed 923 tests with seven skips
and the 43-case strict smoke gate. See the [root integration review](../evidence/2026-09-08/oobe-integration-root/review.json)
for installed-client controls and outstanding acceptance limits.

This candidate is based on `9d333c99a773427dfe3bc9715b396103e2bddf07` and
keeps the service-token flow unchanged except for the token byte encoder. It
adds `encodeTokenBytes(bytes)` as a pure source-parity seam and makes
`newTokenId` call it with exactly five bytes from its production
`randomBytes` source. Leading zero bytes are retained as Base58 leader
characters, including the all-zero five-byte value.

## Source proof

The pinned Account source is
`jiborobot/srv-account-ws@6cea43470825657d6a5722162f28c8f233153ee2`. Its
`package.json` declares `bs58: ^3.0.0`; its package lock resolves:

```
bs58 3.1.0, sha1-1MJjiL9IBMrHFBQbGUWqR+XrJI4=
base-x 1.1.0, sha1-QtPXF0dPnqAiB/bRqh9CaRPut6w=
```

The archived package tarballs were retrieved at those exact resolutions and
their SHA-256 values are `1ede9029c8643a0eeed869b7037313490f9a9c18485889693e43440db5c6228e`
(`bs58`) and
`0cc9813fa65317b9fdfb293a9c89effd898edf85bbea219cfafd051949d883eb`
(`base-x`). The extracted source hashes are:

- `bs58/index.js`: `0cfcec7b298a0c33588b432fad41e2fba216336d34ffd8c13422d21d3134ab57`
- `bs58/package.json`: `5d7934a8ba21f74cf449e97b10d1d28a3d9d26fea8e5f583a6970bfab09583ae`
- `base-x/index.js`: `32294838abda0a32ae8551f7b2958a8c4d1c14b0c3ce90383915cb21284c3c60`
- `base-x/package.json`: `4f3907a52065d2145eea89db52e09338fddc10a3c347377d33c72327907c62ec`

The source package delegates `bs58.encode` to `base-x`, whose encode loop
emits one leading `1` for each leading zero byte and emits the final digit for
an all-zero buffer. The candidate follows those observable rules without
adding the archived dependency to the production package.

## Controls

The source and candidate were executed together by
`.parity/reviews/a05-service-token-encoding-20260908/source-candidate-controls.mjs`.
The control imports the extracted `bs58@3.1.0` package and compares it with
both `encodeTokenBytes` and the injected `newTokenId` seam. Six deterministic
five-byte vectors passed: all zeroes, four, three, two and one leading zero,
and high-bit bytes. Every injected call asserted that production requests
exactly five bytes.

Result and provenance:

- `.parity/reviews/a05-service-token-encoding-20260908/source-candidate-controls.json`
  (SHA-256 `1bfcec301b5793a923df1ce8871656ed4be4571169427ab9e8913840de05a1b1`)
- command: `node .parity/reviews/a05-service-token-encoding-20260908/source-candidate-controls.mjs`
- exit: `0`
- runner SHA-256: `930ced8bf996474e281522d3ceb60379a30b460a5b4f57a3c5e2449a59c8c3a5`

The focused Account regression command was:

```
node --test packages/account/test/robotFace.test.js packages/account/test/robotServiceToken.test.js
```

It passed **13/13** tests with exit `0`. The captured stdout is
`.parity/reviews/a05-service-token-encoding-20260908/candidate-focused-source-fix.stdout`
and the exit receipt is the adjacent `candidate-focused-source-fix.exit`.

The candidate changes only `packages/account/src/model.js` and
`packages/account/test/robotServiceToken.test.js`; the service uses the
existing random five-byte production path. Full Account, original Mongo, and
real gateway/robot acceptance remain root-owned and unverified.
