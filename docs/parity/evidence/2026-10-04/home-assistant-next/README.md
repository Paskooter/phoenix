# Home Assistant next beta validation — 2026-10-04

This record separates isolated software checks, archive integrity, physical
robot acceptance, and catalog publication. Household data, identities,
credentials, captures, BE source, and operator notes remain outside Git.

## Release artifacts and isolated checks

| Item | Verified scope |
| --- | --- |
| Phoenix integration 0.2.0b2 | Runtime source `4d69523fe0b6a671089f3d1f1da175365f2e42a9`; protocol 1, current-volume announcements, minimum receiver BE 13.1.2. |
| Final flat `phoenix.zip` | 17 payload files; 77,194 bytes; SHA-256 `f9298fd439decabd77031fffb744ae21b906c6442affc19167b2b7ce438aa009`. Exact payload bytes match committed source. |
| HA 2026.8.1 | 66/66 full integration cases in 347.85 seconds; 68 warnings. |
| HA 2026.9.4 | 66/66 full integration cases in 376.03 seconds; 68 warnings. |
| CI packaging validation | HACS and hassfest passed in the [same full run](https://github.com/Paskooter/phoenix-home-assistant/actions/runs/37190564109). |
| Phoenix focused regression | 69/69 Home Assistant/native/broker/Classic/activity checks; strict parity gate 43/43. |
| Jev 0.3.0b1 | 266/266 isolated cases on each tested HA version. Provider HTTP is simulated. |
| BE 13.1.2 package | 173,404,160 bytes; SHA-256 `7d5a2727e5786a44926282b0b4a3ec37f27771f2bab958b36fc04c31a7dfc78d`. |
| Official BE integrity gate | 21,590 official files; 21,604 candidate files; 14 additions; zero unresolved package entry points. Official 11.0.1 archive SHA-256 `1f85e593cf7e868b969d74bed3eef78b447e72207fa4b3892de013aeb3e97d8d`. |

The HA matrix uses actual disposable HA cores, their built-in conversation
agent and services, synthetic devices and identities, real Phoenix persistence
and authorization, and an isolated TLS edge. Native peers and provider HTTP are
synthetic. B2's standard Announcement status sensor keeps readiness and minimum
firmware visible while notify is unavailable; local quiet-hours status refreshes
every 30 seconds without network I/O, with timer cleanup on unload.

The exact final archive passed fresh extraction and serial lifecycle checks on
actual HA 2026.8.1 in **96.717 seconds** and 2026.9.4 in **49.413 seconds**.
The checks covered synthetic TLS linking, saved options, unload/reload, a
fresh-process persisted restart, and confirmed credential revocation/removal.
Both versions displayed minimum BE 13.1.2. Quiet-hours status changed on the
real local timer without new status reads or roster frames; unload/restart
cleaned up all interval timers. These archive checks sent **zero announcement
frames**, performed **zero device actions**, and made **zero provider calls**.
They do not establish physical receiver acceptance.

Captured baseline and candidate regression logs contain the same failing-case
labels: **two Gateway/skills failures** and **51 Account failures**. Gateway/skills
passed 961/963 on the baseline and 983/985 on the candidate; Account passed
537/588 and 550/601, respectively. This is a comparison of those captured runs.
The broader Phoenix suite is not reported as passing.

## Accepted physical scope

The accepted BE 13.1.2 checks ran against Phoenix application source
`b2dcca8cce9c2b514a8487320f029a61cc08090e` and the gated package above.
The owner reported the installed 0.2.0b1 connector; authenticated metadata
established HA Core 2026.8.1 and its historical minimum label 13.1.0. The
final B2 archive and its corrected 13.1.2 labels were tested separately in
the disposable HA installations above.

| Physical check | Accepted result |
| --- | --- |
| Selected native update | BE-only 13.1.2 update completed; OS/services 13.0.7 and OOBE 9.0.2 remained unchanged. Package integrity is the independent gate above; installed checks do not claim a hash audit of every file. |
| Announcement | Native `SUCCEEDED`, correlated `completed` result, and HA service success at the current volume. Service invocation to completion was 2410.3ms; native start to correlated result was about 2.3 seconds. |
| Idle receiver reconnect | A 12-second observation after one idle-channel reconnect saw no additional announcement or replay. This does not establish pending-action recovery across a robot reboot. |
| Native conversation preemption | A supplied-ASR `mimicGlobalTurn` ran on the physical robot. Owned native `STOPPED` and explicit stop acknowledgement preceded successful clock speech; no overlap was observed. The interrupted announcement returned correlated `uncertain` / `interrupted`, without HA success. A Gateway cancellation frame was not observed. |
| Normal-mode reboot | Supported reboot was acknowledged; a fresh boot, saved/reporter/HTTP mode readbacks of `normal`, automatic BE startup without a manual start, one ready/idle native canvas, authenticated receiver TLS, and an empty private marker were confirmed. |
| Approved light cycle | Two native home turns confirmed off → on → off through the owner's connector, matched the Home Assistant skill and completed with native `SUCCEEDED`. The starting state was restored; no direct cleanup service call was needed. |

All four acceptance groups passed release review. Master volume was preserved.
Physical microphone, human wake and physical touch inputs were not exercised.

A native turn with supplied ASR text begins after recognition. Its latency may
include routing, the owner's outbound HA connector, physical device state
confirmation and spoken completion; it excludes microphone recognition.
Light-state confirmation took **2485.9ms on / 1613.5ms off**, and native spoken
reply completion took **5797ms / 4240ms** from native turn invocation. The
announcement's start-to-result timing includes speech and marker handling; it
is not a measurement of acoustic speech duration. No microphone or human wake-phrase acceptance is
inferred from these turns. That check remains deferred by the owner.

The new area, state-question, follow-up and routine behavior has isolated real
HA evidence. Those additions were not separately exercised on the physical robot in this
checkpoint. No broader household-device
coverage or independent owner installation cohort is inferred.

## Prior accepted behavior and held candidates

The earlier BE 13.0.2 proof remains valid. Four supplied-ASR production turns
through the owner-installed HA 2026.8.1 connector controlled one approved light
and completed native spoken replies in 5506/4157ms for direct off/on and
4495/4457ms for explicit off/on. A 2026-10-04 regression completed on/off spoken
turns in 5088/4209ms. Each cycle restored the light's starting state; the regression preserved
master volume. The owner reported the integration update; authenticated
connector metadata established HA Core 2026.8.1. Those records do not identify
an installed integration version cryptographically.

BE 13.1.0 failed speech-adapter initialization because of a module-export
mismatch. BE 13.1.1 corrected that adapter, but a browser timer binding failed
before the receiver connected. Both are held historical candidates. Their
source/archive and synthetic checks never established physical receiver
acceptance.

## Release and trust boundaries

At this documentation checkpoint, physical BE 13.1.2 acceptance was complete,
while normal OTA offers still selected BE 13.0.2. Activating BE 13.1.2 in the
general catalog and publishing the prepared HA 0.2.0b2 archive are separate
release steps. The previously published 0.2.0b1 archive remains
unchanged and protocol-compatible. Every changed offer needs a new update ID and
exact OS/services 13.0.7 dependencies aligned across `""`, `fcs`, and `eau`.
Server activation uses the native deployment guard with fresh Hub/OTA activity
and a full uninterrupted quiet minute; catalog discovery alone does not prove
physical boot or spoken completion.

Announcements are separately opt-in, respect local HA quiet hours, use Jibo's
current volume, and require native completion acknowledgement. Busy/offline,
expired or revoked work is rejected without a replay queue. A requested stop
retains execution activity until native stop is proved. Scene/script completion
means the routine started, not that every affected device reached a final state.

Phoenix and its recognition path remain trusted command origins. TLS and
installation credentials reject unrelated callers; they do not exclude an
operator controlling the running Phoenix server. No independent robot-to-HA
signature, direct LAN transport or offline voice mode is implemented. See the
integration's [trust documentation](https://github.com/Paskooter/phoenix-home-assistant/blob/main/docs/security.md).
