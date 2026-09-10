# w3/keyimport — one-time loop-key bootstrap + removing the Firebase dependency

Date: 2026-09-10. Branch `w3/keyimport`, forked from `main` @ d464df5.
Robot: `root@192.168.1.217` (Moth-Radius-Breazeal-Felt, region `api`).
Emulator: `emulator-5554` (Android 14), app `com.jibo` 1.0.9/33, rebuilt debug APK from
`/home/shell/jibo-android` @ `5da4ec8` + the one-line service fix below.
Server: `phoenix-robot@moth.service` on the `deploy-7fd47e8` checkout, `ETCO_classic_keyMintOnRequest=0`.

## Documents consulted (Jibo archive MCP, https://pvindex.org/mcp)

Read in full with `jibo_read`; quotes are verbatim.

1. **`/confluence/display/JN/User+Generated+Content+Key`** (Rich Sadowsky, 2016-12-02)
   - "A stated design goal is that Jibo the company and its servers do not possess or store the
     user generated content key (UGC key)."
   - "The UGC key is a 256-bit key used with the AES block cipher."
   - "A key exchange mechanism is used to allow a client to ask another client for the UGC Key and
     it will be exchanged wrapped in a public/private key cryptography. The Jibo servers do not
     store this key."
   - "That passphrase will be used to store an encrypted version of the UGC key that is associated
     with the owner ID and loop ID."
   - "The unencrypted UGC key should not be passed to the server. Therefore the cryptography must
     happen on the device. The algorithms involved are AES-256 and SHA-256."
2. **`/confluence/display/SER/Key+Backup+and+Restore`** (Oleksandr Rysenko, 2016-12-16, under JiboKeys)
   - "Loop common key can be backed up and later restored. We use Key.Backup and Key.Restore
     methods for that. Common key is encypted/decrypted on the client."
   - "encryptedKey = BASE64(AES(commonKey, SHA256(passphrase))"
   - "AES here is our regular AES encryption that uses 32-bytes key."
3. **`/confluence/display/SER/JiboKeys`** (Oleksandr Rysenko, 2016-10-24)
   - "Each device (mobile app or Jibo) creates it's own pair of RSA keys and stores them securely
     (locally)."
   - "**Symmetrical key is created by robot only once robot gets his credentials/loop details.**"
   - "Whenever robots/devices are added to crew owner account or to account of crew members,
     symmetrical key is shared with them."
   - Flow table, verbatim: "Incoming \"key.needed\" notification **OR listIncomingRequests returns
     pending requests** | React with calling Key.shareSymmetricalKey".
   - "Symmetrical key could be created by calling Key.loadOrCreateSymmetricalKey method. It will
     generate 32 bytes length random sequence, base64 to string."
4. **Pinned source** `jiborobot/srv-key-ws@master src/controllers/key.ctrl.ts` via `gitea_read_file`
   (quoted below).

### Where design and implementation disagree (both are real; say so)

* **Robot originates the key** (JiboKeys: "created by robot only") — matches the 2017 data on the
  robot (`/var/jibo/keys/symmetric-5a0b20f5ddee0000197e2881.json`, 32-byte AES key, Nov 2017). The
  recovery-doc claim that the *app* mints the key is wrong for this robot: the app's only
  `generateSymmetricKey` call site is commented out (`JiboDetailsFragment.java:230-232`).
* **JiboKeys describes a device-id API** (`Keys.Set/Get/Share/GetShared/RequestSharing`) while the
  shipped service is `Key_20160201` with `(accountId, loopId, publicKey)` request documents
  (`CreateRequest/GetRequest/Share/ListIncomingRequests`). The shipped shape is what the app in
  `/home/shell/jibo-android` actually calls, so Phoenix correctly models the shipped shape.
* **JiboKeys' `encryptCommonKey` is sign-then-encrypt** ("Encrypts common key with private key of the
  source; Encrypts result with public key of the target"). The shipped app does **encrypt-only** —
  one `RSA/NONE/PKCS1Padding` pass to the recipient's public key, no source signature. Phoenix
  matches the shipped app (see `key.js:464-468`). Recorded as a divergence candidate, not "fixed".

## (a) Key.Backup / Key.Restore — re-verified, not assumed

Pinned source (`srv-key-ws/src/controllers/key.ctrl.ts`), verbatim:

```ts
public async checkOwnership(accountId, loopId) {
  const loops = await this.accountClient.listLoop(accountId, loopId);
  if (loops.length !== 1 || loops[0].owner !== accountId.toString()) {
    throw Boom.createWithCode(Errors.ONLY_OWNER_CAN_BACKUP_RESTORE);
  }
}
public async checkOwnerOrRobot(accountId, loopId) {            // restore
  ... loops[0].owner !== accountId && loops[0].robot !== accountId ...
  throw Boom.createWithCode(Errors.ONLY_OWNER_OR_ROBOT_CAN_RESTORE);
}
public async backup({ loopId, accountId, encryptedKey, passwordHash }) {
  await this.checkOwnership(accountId, loopId);
  let backup = await Backup.findOne({ loopId });               // ONE per loop
  ... backup.encryptedKey = encryptedKey; backup.passwordHash = passwordHash; return backup.save();
}
public async restore({ loopId, accountId, passwordHash }) {
  await this.checkOwnerOrRobot(accountId, loopId);
  const backup = await Backup.findOne({ loopId });
  if (!backup) throw Boom.createWithCode(Errors.BACKUP_NOT_FOUND);
  if (passwordHash && passwordHash !== backup.passwordHash) throw Boom.createWithCode(Errors.BACKUP_PASSWORD_WRONG);
  return backup;
}
```

Phoenix implements this faithfully — `packages/classic/src/key.js`:
`backup()` at :279-290 (one row per `loopId`, keyed with `accountId`), `restore()` at :628-643
("Source restore: only a SUPPLIED hash is compared; an omitted one restores"), and the same
`ONLY_OWNER_CAN_BACKUP_RESTORE` / `ONLY_OWNER_OR_ROBOT_CAN_RESTORE` / `BACKUP_NOT_FOUND` /
`BACKUP_PASSWORD_WRONG` codes at :54-67.

Live checks against the running service (all observed, `docs/parity/evidence/w3-keyimport-20260910/backup-restore-run.txt`):

| call | caller | result |
|---|---|---|
| `Backup` | non-owner (gallerytest) | **403 `ONLY_OWNER_CAN_BACKUP_RESTORE`** |
| `Restore` | non-owner (gallerytest) | **403 `ONLY_OWNER_OR_ROBOT_CAN_RESTORE`** |
| `Restore` wrong passphrase | owner | **409 `BACKUP_PASSWORD_WRONG`** |
| `Restore` unknown loop | owner | **404 `BACKUP_NOT_FOUND`** |
| `Backup` then `Restore` | owner | 200, ciphertext read back identically |

The server treats `encryptedKey` as opaque — it never parses or decrypts it. That is correct: the
SER page puts the crypto on the client, so the server's job is relay/storage only and there is
nothing for it to format-check.

**The app's own `Key.Backup` was observed live and refused for its role** (logcat):
`Received error response: ... "Only loop owner can backup and restore key" (Status Code: 403)`.
Gallery-test is a *member*, not the owner, so this is correct behaviour — but it is the single
biggest practical constraint on the bootstrap (see (b)/(c)).

## (b) Bootstrapping a passphrase backup for the 2017 key — options

The robot holds the only copy. The robot's key-sharing code is gone (reflashed to parity software),
so nothing on the robot can originate a Share, and no device holds the key.

* **(i) "any device holding the key creates the backup" — NOT VIABLE.** No device holds it. The
  robot's code is gone; the app on the emulator held only a *minted* key (a server-side divergence
  now disabled), not the 2017 key. JiboKeys is explicit that the key "is created by robot only", so
  the original design never needed a server-side originator either.
* **(ii) one-time import of the raw key into a device, which then creates the passphrase backup —
  RECOMMENDED, and demonstrated.** It is the only route that exists, it is a single auditable
  operation, and afterwards the ordinary documented restore applies.

**Recommended sequence** (what this branch delivers):
1. `scripts/import-robot-loop-key.mjs` reads the 32-byte key over SSH (nothing installed on the
   robot), resolves the target device's public key from its real `Key_20160201.CreateRequest`
   pending-request record, encrypts with `RSA/NONE/PKCS1Padding` and delivers through
   `Key_20160201.Share`. **The server only ever sees a 256-byte ciphertext.**
2. The device decrypts and stores the key; the app then creates the passphrase backup with
   `encryptedKey = BASE64(AES-256-CBC(key = SHA-256(passphrase), iv = <app constant>,
   plaintext = BASE64(rawKey)))` and `passwordHash = SHA1(passphrase)`.
3. From then on any device signed in as the **owner** (or the robot) restores with the passphrase.

Whoever runs step 1 necessarily sees the raw key once, over SSH. That is unavoidable — the robot is
the only holder — and it is the accepted cost for the user's own robot.

Because the owner's phone is not in the field and the owner's login password is a one-way hash in
the store, step 2's *owner-role* call was performed by the same script in a `--bootstrap-backup`
mode that is a client for exactly one call: it does the documented AES/SHA-256 on the client side
and never sends plaintext. The backup now exists and was proven to round-trip:

```
$ node scripts/import-robot-loop-key.mjs --verify-backup <owner creds> --passphrase-file <file>
backup ciphertext 48 bytes; recovered key 32 bytes
RESULT: MATCH - the backup holds the robot's key
```

stored row: `loopId=5a0b20f5ddee0000197e2881 accountId=3fbd897c356dc32527428c4f (owner) 48 ciphertext bytes`.

## (c) Can the app's `LoopPassphraseRestoreDialog` path restore? What triggers it?

Yes, the path is complete and correct — but **only for the owner or the robot**, and it is not
reached by the Gallery becoming keyless.

* Trigger chain (`MediaFragment.java`): `onLoadFinished` → `passphraseDialogHandler`
  (`PASSPHRASE_DIALOG_CHECK` :1812, `TIMEOUT_DIALOG_CHECK` :1814) →
  `showTimeoutPassphraseDialogsIfNeeded()` :862-890. It fires only when **all** of: the loop is in
  `SharedPreferencesUtil.getLoopsTimeout` (`PREF_LOOPS_IN_TIMEOUT`, written by
  `SharedPreferencesUtil.addLoopTimeout` :199-211, normally from a push), no key exists locally
  (`doesKeyExist`), and no passphrase dialog is already showing. It then calls
  `LoopPassphraseUtils.checkForBackup` (`LoopPassphraseUtils.java:159-183`), which is a
  `Key_20160201.Restore` with `passwordHash = null`; a 2xx → **restore** dialog, an error →
  "no backup" info dialog.
* The restore dialog (`LoopPassphraseRestoreDialog.onSetClicked`) sends
  `restoreEncryptedKey(loopId, sha1(passphrase))` and stores the result with
  `keyManager.saveSymmetricKey(context, loopId, encryptedKey, passphrase)`.
* There is also a user-reachable manual route: `RobotSettingsFragment` `@BindView btnPassphrase`
  (:87-91) → `setPassphraseListener` :495-500 (`DialogType.FROM_SETTINGS`) or
  `restoreContentListener` :502-508 (`DialogType.RESTORE`), wired at :270-298 depending on whether
  a key and/or a backup exists.

**Blocker, stated plainly:** `Key.Backup` and `Key.Restore` are owner/robot-only (verified in the
pinned source and live). The signed-in account on the emulator, `gallerytest@phoenix.local`, is a
*member*, so both calls are refused 403 no matter how good the backup is. The documented restore is
demonstrable only from a session belonging to the loop owner
(`superman1762@gmail.com`, `_id 3fbd897c356dc32527428c4f`). I could not sign the app in as that
account — only an iterated SHA-512 password hash is stored — so the *in-app restore* was not
exercised. The server half (backup exists, ciphertext-only, wrong hash 409, role gates) is proven.

## (d) Server-side work actually needed: **NONE**

`Key.Backup`/`Key.Restore` and the `Key_20160201` relay already implement the documented contract
(pinned source ↔ Phoenix agree). No new server code, no new endpoint, no server-held key.
The only server change is configuration: `ETCO_classic_keyMintOnRequest=0` (already applied by
root), which removes the divergence where Phoenix minted and stored plaintext loop keys.

## Residual server-held key material (identify, do not exfiltrate)

`ETCO_classic_keyFile` is unset, so the store is `$TMPDIR/phoenix-key.json` = **`/tmp/phoenix-key.json`**.
It still contains, from the period when minting was enabled:

* `loopSecrets[0]` — **one plaintext 32-byte AES loop key**, base64, for
  `loopId=5a0b20f5ddee0000197e2881` (44-char base64). This is real plaintext key material and is
  contrary to the design goal. **Recommended: root purges it.** I did not copy its value anywhere.
* `keys[2]` — two *encrypted* `CreateRequest` documents for `43ca532ad4090cfb80f2e7a5`. Not
  plaintext; they now carry the robot-key ciphertext delivered here (256-byte RSA blobs).

Both encrypted requests were over-written with the robot-key ciphertext, so the previously minted
ciphertext is no longer served.

## End-to-end evidence (emulator-5554, no manual toggle)

Two fresh `uiautomator` dumps, `PREF_ENCRYPTION_ENABLED` **true** throughout:

| | dump | observed |
|---|---|---|
| BEFORE | `gallery-before.xml` | `"Jibo's Gallery"`, `'Waiting for Jibo'`, `@+id/viewNoKey`, 0 photo cells, no `loop_*` file |
| AFTER | `gallery-after.xml` | `"Jibo's Gallery"`, `'Today'`, `'SELECT ALL'`, **2 `com.jibo:id/photo` cells**, no `viewNoKey` |

* The app's key file exists again: `-rw-rw---- 256 loop_43ca532ad4090cfb80f2e7a5_5a0b20f5ddee0000197e2881`.
* The app holds the **robot's** key, not the minted one: the Debug Screen's `com.jibo:id/ugcKey`
  rendered the robot's exact base64 key (`debugscreen-ugcKey-redacted.xml`, value redacted), and
  `KeyManager` logged it back (`app-holds-robot-key.txt`, redacted). SHA-1 fingerprint
  `49d5de8d9311767d11be119eb71189480c055dc8` matches `sha1(robot key)`.
* A fresh real image + `thumb` pair was uploaded through `Media_20160725.Create`
  (`x-path=w3keyimg1` → 200; `x-path=w3keythumb1`, `x-type=thumb`, `x-reference=w3keyimg1` → 200
  with `reference` echoed) so the grid has a renderable row.

## The app fix (removing the Firebase dependency)

`app/src/main/java/com/jibo/service/KeyRequestingSharingService.java:192-202` returned early when
`PREF_PUSH_SERVICE_TOKEN` was empty, so a device whose FCM registration never completed never asked
for its key — the observed `FirebaseInstanceId: Token retrieval failed: INVALID_SENDER`. The minimal
change polls briefly for the token and then **proceeds regardless**, instead of giving up forever.
Nothing else reads the token on this path.

Requires a rebuilt APK to reach a phone; a freshly built `app-jibo-debug.apk`
(sha256 `aadc22db…4c09`) was installed on the emulator and the fixed method is visible in the
runtime trace: `KeyRequestingSharingService.requestSymmetricKey(KeyRequestingSharingService.java:215)`.
Patch: `app-fix.patch`.

## Falsification

A 31-byte buffer (not the 32-byte key) was encrypted to each request's public key and delivered via
the same `Share` path (server accepts it — it never validates length). After clearing the app's key
and relaunching, **the app stored nothing** (`ls /data/data/com.jibo/files/loop_*` empty), the
Gallery stayed on `'Waiting for Jibo'` + `viewNoKey` (`gallery-falsify-wrong-length-key.xml`), and
`PREF_ENCRYPTION_ENABLED` remained true. Re-running the import with the real key restored the key
file and the rendering grid (`gallery-restored.xml`). Details: `falsification.txt`.

## Divergence candidates (recorded, not edited into DIVERGENCES.md)

1. **`Key.Backup`/`Key.Restore` skip their owner check when the caller cannot be resolved.**
   `key.js:532` sets `accountId = caller || 'anon'` and `:620`/`:633` guard with
   `if (loop && caller && …)`, so an unauthenticated classic call is stored as `anon` with the
   ownership check bypassed. Inside Phoenix's documented LAN-trust boundary, but the pinned source
   has no such branch (its `accountId` is always the gateway credential).
2. **Key-exchange relay drops the source signature.** JiboKeys' `encryptCommonKey` signs with the
   source's private key then encrypts to the target; `Key_20160201.Share` (both source and Phoenix)
   carries a single encrypt-only blob, so a recipient cannot authenticate *who* shared a key.
3. **Server-side minting is a divergence that must not come back.** `mintOnRequest` made Phoenix
   hold plaintext loop keys; the design goal is explicit that the servers do not store the UGC key.
   Config left at `0`.

## What remains

* Purge `/tmp/phoenix-key.json` `loopSecrets` (root) — the only plaintext key material left.
* Rebuild + ship the APK so a real phone picks up the Firebase fix.
* The in-app *restore* dialog was not exercised end-to-end because the loop owner's credentials are
  not available for app login; the server half is proven and the gate is documented.
