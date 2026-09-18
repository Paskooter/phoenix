# The over-the-air upgrade path (R-06, R-07)

This is a release gate. It is written down because the goal is not "a robot we
already repointed by hand keeps working" — it is **any** robot, on whatever
firmware it arrived with, upgrading itself to the version this server supports
and reaching this server without a human touching it over SSH.

Ledger: **R-06** (the journey, on hardware) and **R-07** (the payload it needs).
R-05, the release report, depends on both.

## The case to prove

A robot flashed to **stock 5.4.0 over USB** upgrades over the air to
**13.0.0** — the final Jibo firmware ("Last Dance", 2019-02-25 production) — and
afterwards:

1. it is running 13.0.0, confirmed from the robot itself;
2. it reaches this Phoenix server with **no manual repoint step**;
3. it completes a real spoken turn end to end;
4. its per-robot calibration survived, because the update swaps the inactive
   rootfs slot and never touches `/var`.

## What already exists

- `packages/ota` implements the pinned Update API
  (`jiborobot/srv-update-ws`): `ListUpdates`, `ListUpdatesFrom`,
  `GetUpdateFrom`, `CreateUpdate`, `RemoveUpdate`, `ListUniqueFilters`,
  `SetTarget`, `ListTargets`, plus `GET /ota/package?id=` streaming the bytes
  with `Content-Length` so the robot's downloader can show progress and verify
  the SHA-1. It is unit-tested, including the version ordering, the wildcard
  `fromVersion`, the target overrides and the never-offered-again loop guard.
- `packages/ota/data/` holds the real 13.0.0 packages (`os-13.0.0.tar`,
  `services-13.0.0.tar`), and `scripts/build-ota-packages.sh` rebuilds them from
  a flash buildroot so they are reproducible rather than checked-in artefacts.
- The robot's own updater is `jibo-ota-updater`
  (`src/package-update.js` for the packaging shape): an uncompressed tar holding
  `./filesystem.tar.bz2`; `apply_os.js` writes that to the inactive rootfs slot
  and flips `activeroot`.

## What is missing

- **Nothing has ever run it.** No robot has walked an upgrade. The standing
  `ECONNREFUSED 127.0.0.1:7015` symptom is the development launcher
  (`scripts/parity-robot/authenticated-stack.mjs`) starting only account, classic
  and gateway — never OTA — so the service a robot would call is not even up in
  the configuration we test with.
- **The payload does not carry the repoint.** The published packages are the
  stock Jibo build. Everything that lets a robot reach Phoenix is applied
  afterwards over SSH by `scripts/point-robot-at-phoenix.sh`: the hosts entry,
  the patched `@jibo/jibo-server-client` CA handling (DIVERGENCES R1), the BE
  package, and the server URL. A robot that has never been repointed therefore
  upgrades its firmware and still cannot reach us — which is precisely the case
  the goal is about.

## What the payload must carry (R-07)

- the **hosts-file entry** the repoint script sets;
- the **certificate-trust change** — the patched `@jibo/jibo-server-client`
  CA loading from DIVERGENCES R1, inside the image, not an SSH step after it;
- **BE 11.0.1** (`phoenix-parity-11-0-1`), *not* the newest BE: 12.0.0-era
  `@be/be` loses the cyan listening eye, the proactive runtime and the Nimbus
  follow-ups (see `docs/parity/BE-RELEASES.md`);
- a **default server URL** derived from this server's configured public URL, so
  a robot that has never been repointed finds us; the manifest must state what
  happens when that URL is unset;
- the manifest entry's **real length and SHA-1**, computed from the artefact,
  because the robot verifies both.

## Procedure to follow when this is picked up

1. Record the "before" state: serial, installed version read off the robot,
   configuration — before touching anything.
2. Bring the OTA service up in the deployed stack and confirm the robot can
   reach it.
3. Confirm `Update_20160301.GetUpdateFrom` / `ListUpdatesFrom` offer 13.0.0 to
   that robot's `fromVersion`.
4. Let the robot upgrade; capture robot-side logs and timings.
5. Verify the four outcomes in "The case to prove" above.
6. Falsify: corrupt a package so its bytes no longer match the advertised SHA-1
   and confirm the robot's updater refuses it **and** still boots the old slot.
   An update path that has never been seen to refuse a bad package is not a
   verified update path.

## Risks worth naming before starting

- An OTA that rewrites the hosts file and the server URL is a remote
  configuration change; it must be idempotent and must not strand a robot with
  no reachable server.
- The robot must survive a failed update. The A/B slot design is what makes that
  true, and the falsification step above is what proves it rather than assumes it.
- Destructive trials (factory reset, wiping) need the owner's explicit
  authorisation, as A-05 established.
