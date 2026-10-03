# OTA hardware certification — owner sign-off, 2026-10-03

The project owner certifies the normal robot repoint and native over-the-air
update flow as working, including stock robots. The owner reports having
verified `robot-ota-repoint.sh` on **ten different firmware combinations**.
This is accepted hardware evidence for the supported flow, and supersedes the
September statements that no robot had completed an update or that the normal
stock-to-OTA journey still awaited sign-off.

The evidence is the owner's statement in the project conversation on
2026-10-03:

> I have verified the OTA repoint script on 10 different firmware combinations

The owner also states that the OTA system works and that this flow can be
completed without issues, while acknowledging that more firmware combinations
continue to appear. Record the successful flow as verified and collect those
additional cases individually.

The owner then answered a follow-up covering factory RTM2/RTM3 QR + Wi-Fi setup,
the reported 12.10.0/OpenJibo migration reruns, interrupted/corrupt downloads,
and A/B rollback:

> all but the last 2. i know i did all the rtm releases, 13.0.0, and one that was repointed to 5x1 before

This closes the named factory setup and migration rerun checks. The owner
explicitly recalls **all RTM releases**, **13.0.0**, and a robot previously
repointed to **5x1**. Interrupted/corrupt-update recovery and A/B rollback were
not tested and remain open under R-10. Keep `5x1` as the owner's identifier;
do not invent an OS version from that name.

## Acceptance and provenance

- **R-06:** the normal repoint/native OTA journey is owner-certified on hardware.
- **R-07:** delivery of the Phoenix configuration through the working OTA flow is
  owner-certified. The repository contains the image baker, package tooling,
  native update planner and package catalog supporting that flow.
- The sign-off is owner-reported hardware testing. This reconciliation did not
  run another robot update, reset, flash or deployment.
- The ten starting OS/services/BE combinations were partially identified by
  the follow-up above. Exact component versions for each run, robot identities,
  tested helper/server revisions, package hashes, dates and logs were not
  supplied. These are documentation follow-ups, not a reason to describe
  the certified flow as unverified. The archived firmware survey is a source
  inventory and must not be substituted for the owner's ten test cases.
- The checkout inspected for this reconciliation starts at
  `bf2733f28e8e6e130ec07a3b1f590b9279616fa9`. That identifies the audited
  repository, not the unspecified commits used in the owner's hardware trials.

R-06 and R-07 now describe the certified normal flow. Their former deliberate
failure experiments and artifact-level negative controls are retained under
**R-10** and in [VERIFICATION-GAPS.md](../../../VERIFICATION-GAPS.md). USB flash
acceptance (R-08), comprehensive trust-store acceptance (R-09), and the wider
hardware journey matrix (R-04) retain their own scope.

## Supported procedure

Use the public repoint and OTA procedure in [RUNBOOK.md](../../../../RUNBOOK.md).
The documented jibo.io release uses OS/services 13.0.7, OOBE 9.0.2 and custom
`@be/be` 13.0.2. The helper discovers compatible offers from the server instead
of pinning those version numbers; the repository's stock example manifest is
not the production jibo.io release catalog.

Credentialed migration and credential-free QR provisioning follow the branches
documented in the runbook. Factory RTM QR/Wi-Fi setup and the named migration
reruns are included in the owner's follow-up certification.

The existing release gates still apply to every changed package: complete BE
source in the separate local `jibo-be` project, independent BE integrity checks,
fresh catalog IDs for changed offers, compatible dependencies and filters, and
physical boot/voice acceptance. A successful prior OTA certifies the flow; each
new payload still needs its release checks.
