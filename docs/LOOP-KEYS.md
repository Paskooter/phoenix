# Browser access to encrypted loop content

The console is a key-holding client, like the original Jibo mobile app. Account
credentials authorize requests; they are **not** the loop's content-encryption
key. Each loop has its own existing 32-byte key. Do not replace it during
migration: historical photos/messages would become unreadable.

## User flow

- Gallery automatically connects this signed-in browser to an online Jibo via
  `Key_20160201.CreateRequest`, the existing `KeyNeeded` robot notification,
  and bounded `GetRequest` polling. No SSH/export step is required on robots
  running the original secure-transfer service (`jibo-sts`).
- The browser creates an ephemeral RSA key pair, uploads only its public key,
  and unwraps the robot's response locally. The server relays wrapped keys; it
  never generates or obtains the plaintext loop key.
- Thumbnails, the full-size viewer, downloads, sharing, and Overview previews
  decrypt locally. A successful HTTP download can still contain ciphertext;
  assigning its URL directly to an `<img>` is incorrect for `isEncrypted=true`.
- Once unlocked, the owner is prompted to create a recovery passphrase (at
  least 12 characters). The browser encrypts the **same** key and verifies its
  backup round trip before uploading ciphertext and the stock password proof.
  First-backup creation is atomic/create-only, so another tab cannot overwrite
  an existing backup. Use Change recovery passphrase for an existing backup.
- On another device, online exchange is automatic. If Jibo is offline, the
  owner can restore using their recovery passphrase. Original Key.Backup/Restore
  ownership rules remain: accepted members get the key through exchange, not
  the owner's recovery-backup API.
- "Remember on this device until sign-out" is off by default. Opting in writes
  AES-GCM-wrapped key bytes plus a nonextractable device-wrapping CryptoKey to
  IndexedDB, scoped by account and loop. Forget/sign-out remove those records,
  wipe in-memory key buffers, and revoke decrypted media Blob URLs. API content
  and plaintext media are never added to the service-worker cache.
  Supporting browsers also notify other open console tabs to forget/revoke
  their copies on sign-out or an explicit Forget action.

## Compatibility and trust boundaries

The wire algorithms must match shipped clients, not a new guessed scheme:

- Exchange: RSA-2048 SPKI public key, RSAES-PKCS1-v1_5 encrypted raw 32-byte
  key. WebCrypto generates the RSA key pair; locally served, dependency-pinned
  `node-forge` unwraps stock v1.5 ciphertext (WebCrypto supports OAEP, not that
  legacy encryption padding). `/api/crypto/forge.js` is a fixed public JS asset,
  **not** a server crypto service. Keep `/api/` proxied to Account.
- Media: AES-256-CBC/PKCS padding, with the IV formed from key byte positions
  `[2,4,6,8,31,29,27,25,9,11,13,15,24,22,20,18]` (jibo-sts KeyExtended).
- Recovery: AES-CBC of the UTF-8 base64 key string, using SHA-256(passphrase)
  and Android KeyManager's fixed passphrase IV; SHA-1(passphrase) is the stock
  server password proof. Accept Android's base64 line ending on restore.

These legacy formats are retained for robot/app interoperability. They do not
provide modern authenticated encryption or a deliberately expensive password
KDF. Use a strong, unique recovery passphrase. A compromised storage server
has ciphertext and a password hash and can attempt offline guessing; online
rate limiting does not prevent that.

Browser confidentiality also trusts code served by the instance and other
same-origin scripts. IndexedDB CryptoKeys are not an OS/hardware keystore, and
an actively malicious server/XSS could modify client code to read decrypted
content. Do not claim this protects against a malicious operator delivering
new JavaScript. Keep scripts local/reviewed, HTTPS enabled, and CSP restricted.
Only actual account owners/accepted members may use the portal exchange routes;
they are session authenticated, CSRF protected, rate limited, and no-store.

## Troubleshooting and verification

- **Connecting securely to Jibo:** one exchange per loop is in progress.
  Polling is bounded to about one minute, with explicit retry thereafter.
- **Photos locked:** bring Jibo online or use the owner's saved recovery
  passphrase. An account-password reset cannot reconstruct a missing key.
- **Recovery not configured:** not a statement about robot filesystem backups;
  it means no passphrase-encrypted *loop-key* backup exists.
- **Capture unavailable:** distinguish HTTP/upload/file errors from decryption
  errors. A key cannot recreate missing local/cloud photo files.
- If all key-holding devices and the recovery passphrase are lost, the server
  cannot recover the original protected content. Never fix this by minting a
  different key or decrypting on the server.

Run `node --test packages/account/test/loopCrypto.test.js
packages/account/test/portalLoopKeys.test.js` for stock-format, privacy, isolation,
revocation, limits and authenticated-relay tests. Run
`node scripts/portal-loop-key-smoke.mjs` with the sibling simulator's Puppeteer
and Chromium (or `SIM_DIR`/`CHROME_BIN`) for the real mobile-browser flow.
Before release, also verify a real robot answers the browser request and a real
encrypted photo renders; mocked exchange alone does not prove notifications
reach jibo-sts.
