# A-05 remaining-gap analysis — 2026-09-14

Status: **gap analysis only — A-05 is not claimed or verified by this file.**

A-05's accepted work covers the SDK surface: the installed original
`@jibo/jibo-server-client` 3.0.110 under Node 8.9.4 drives all five normal/admin
OOBE operations across both Account and Classic faces, 38 initial and 46
post-restart checks pass, and issued ordinary/replacement/service credentials
survive a real **service-process** restart. What remains is hardware-bound.

## One stale item in the recorded finding

The A-05 finding still reads "A-03/A-04 completion, robot restart and fresh
hardware/firmware/date evidence remain open". A-03 and A-04 are both `verified`
in the current ledger, so only the hardware items are genuinely outstanding.
The finding is corrected accordingly; no new A-05 evidence is implied by that
correction.

## The remainder splits by how disruptive it is

The previous review recorded the outstanding set as: real robot identity,
firmware and date, native pairing, TLS ingress, camera/microphone/screen/
notification behaviour, household preservation or migration, and deployment on
accepted hardware. Those do not all carry the same risk, and treating them as
one undifferentiated block has kept the whole task parked.

### Tier 1 — read-only, no robot state change

Robot identity, firmware and date evidence. Already partly in hand: a read-only
probe records the robot's boot id and the SHA-256 of `/var/jibo/credentials.json`
without reading any secret value. The credential document carries exactly the
keys `accessKeyId`, `region`, `secretAccessKey`, and its digest agrees with the
`identity.credentialsSha256` recorded independently by the S-13 provenance
collector, which cross-checks the capture.

### Tier 2 — a reboot, reversible, NAND backup exists

"Preserve issued credentials across service/**robot** restart" is the one
acceptance clause that needs a restart and nothing more. It has a clean witness
that needs no OOBE and no re-pairing:

| | before | after |
| --- | --- | --- |
| `/proc/sys/kernel/random/boot_id` | recorded | must differ |
| `sha256(/var/jibo/credentials.json)` | recorded | must be identical |

A differing boot id proves the robot really restarted; an identical credential
digest proves the issued credentials survived it. Captured before-half at
2026-09-14T06:23Z: boot id `e6dedbec-…`, credentials digest `2c8fdf39…`.

The robot was up 1 day 4:42 under a load average near 9 at capture time, so a
reboot is user-visible and should be scheduled rather than taken unilaterally.

### Tier 3 — needs explicit user consent

Native pairing and the full normal/admin OOBE setup flows against the real
robot mean running out-of-box pairing on Moth. That can detach the robot from
the user's household and account state. It is not covered by the standing
permission to "restart/deploy Phoenix and use the authorized Moth robot", and it
should not be attempted without the user deciding it explicitly.

TLS ingress, camera/microphone/screen/notification behaviour and household
migration sit alongside it: each changes or exercises live household state.

## Recommendation

Close Tier 1 and Tier 2 first — they are cheap, low-risk and would discharge the
"preserve issued credentials across service/robot restart" clause outright, with
fresh robot/firmware/date evidence attached. Tier 3 stays open pending a user
decision, and A-05 stays `todo` until it is discharged or explicitly bounded.

Nothing on the robot was changed to produce this file. The probe was read-only
and no secret value was copied.
