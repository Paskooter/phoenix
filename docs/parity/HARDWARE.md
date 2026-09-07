# Moth hardware validation

Current connection update, 2026-09-07: Moth now uses supervised authenticated
Phoenix29ffac3 on Hub29000/TLS29443. Native signed TLS issuance, both Hub paths
and a clock turn after normal-service restart passed. Reboot, microphone/ring
and full Notification acceptance remain open. The local Account Store currently
contains the authentication account and no household/Loop records; account
workflows need separate state setup and verification. Older backend descriptions below
are historical; consult the private canonical receipt before changing Moth.
See the [connected deployment review](evidence/2026-09-07/hardware/supervised-authenticated/review.json).

The [latest portable-parser trial](evidence/2026-09-07/hardware/portable-snapshot/review.json)
used frozen `614e1e8`, the installed 98-graph JSON/gzip profile and original BE
11.0.1. Real native signed TLS token issuance, both authenticated sockets and
SDK clock/TTS/display passed. Root viewed later captures with hour, minute and
seconds hands visible. A joke turn completed with speech activity and six
observed native playback calls; their `STOPPED` outcomes remain recorded.

Root independently verified rollback, configuration/credential/trust hashes,
removed temporary resources, five healthy services and idle. Moth currently uses
diagnostic backend `3150063`; persistent authenticated deployment remains open.
The microphone session returned an empty `SOS_TIMEOUT`, which does not verify
speech recognition, hotphrase activation or physical blue-ring illumination.
A previous unexplained BE exit remains a stability follow-up. Read the private
`.parity/robots/moth/20260906/current.json` receipt before acting on any process.


## Native authentication verified on 2026-09-06

The [first native authentication review](evidence/2026-09-06/hardware/a02-native-auth-reviewed.json)
verified the real signed `Account_20151111.CreateHubToken` request over TLS 1.2,
authenticated listen/proactive sockets and a rendered clock at `5e626b8`.

The subsequent [cached-token rotation review](evidence/2026-09-06/hardware/h10-cache-rotation/review.json)
tested the reviewed authentication and identity changes at `e0956e5`. Root
changed only the temporary issuer and Hub secret while native Jetstream kept
PID 1962. Two requests carrying the cached token received HTTP 401; the native
client fetched one new token, then completed `/v1/listen` and `/v1/proactive`
with that token. SDK clock turns succeeded before and after rotation, and root
inspected both clock screenshots. Proactive requests used a valid explicit
`SURPRISE` trigger through the original BE SDK. Natural proactive behavior,
expiry, exact HTTP retry grouping, the account-backed extension and physical
wake/microphone/ring acceptance remain open.

At that earlier checkpoint Moth was restored to BE 11.0.1 and transport stack `5e626b8`.
Root verified configuration, credentials and certificate trust byte-for-byte,
temporary trust removal, `/usr/local` read-only state and Hub health. The
authoritative private handoff is `.parity/robots/moth/20260906/current.json`;
read its current receipt before acting on a process. At this checkpoint the
restored Hub PID is 879351 and native Jetstream PID is 2101. The retained
`057f67c` full production capture remains a historical baseline; main advances
independently. Six failed preparation/trial attempts and the fourth attempt's
manual restoration are retained in the rotation review.

The user made Moth available on 2026-09-05 and authorized connecting it to
Phoenix, testing on the robot, and iterating. This supersedes the earlier
hardware reservation for Moth. The other robot remains outside this run.
Original Pegasus and pinned consumer source remain the behavioral references;
the simulator and the modified Hermes skill are not parity oracles.

V-04's reproducible real-robot test loop has passed [lead review](evidence/2026-09-05/hardware/review.json).
R-04 remains the complete hardware acceptance gate. V-03's bounded capture writer
and full original controls are reviewed, with external-action coverage gaps
retained. Finding a working conversation does not close the source, authentication, persistence, provider,
or release gates.

## Starting configuration

- Robot: `moth-radius-breazeal-felt.jibo`, currently `192.168.1.217`.
- SSH: key-based `root` access; Node 6.9.2, Buildroot 2015.11.
- Running skill: `@hermes/jibo-be-chat`, `/opt/jibo/Jibo/Skills/hermes-be`.
- Installed original-named BE: `@be/be` 12.0.0, with local additions; it is not
  assumed to be an unmodified release.
- Jetstream: `/usr/local/bin/jibo-jetstream-service`; configuration at
  `/usr/local/etc/jibo-jetstream-service.json`.
- Hub override: `shell.tk:9000`, entrypoint `api.jibo.com`, LINEAR16 audio.
- The server already using port 9000 runs from **`/home/shell/work/phoenix-jibo`**,
  not this checkout. Its processes and the existing CDP tunnel are preserved.
- Root filesystem is read-only; `/opt` is writable, with approximately 7.7 GiB
  available at discovery. Record and restore mount state after configuration edits.

## Test procedure and evidence rules

1. Retain private, uniquely owned backups and public hashes of every changed
   robot configuration. Record running skills, service versions, mount state,
   native binary hashes, consumer release hash and Phoenix working-tree inputs.
2. Use dedicated Phoenix processes, ports, storage and logs. Verify their actual
   working directory and readiness. Do not reuse the separate Hermes backend.
3. Install verified BE release archives in separate validation slots. Record every
   deployment-only change, such as its distinct package name and endpoint
   configuration. Preserve compiled client code and the other skill slots.
4. Launch and stop through SSM on port 8686. Restart Jetstream through System
   Manager on 8585. Capture native events and Phoenix wire traces together.
5. Run the native text-injection path first to isolate transport, routing and
   Nimbus/JCP execution. Label it as text injection, not microphone acceptance.
   Follow with real audio, encodings, local follow-ups, cancel/reconnect and
   source-backed skill-family scenarios. Read and retain the actual outcomes.
6. Reproduce each defect in a focused regression/differential test, repair the
   server, rerun the failing robot scenario, and retain both results. Authentication
   bypasses, local fixture providers or missing physical observations remain
   explicit limitations and cannot close their product tasks.
7. Record current configuration, owned processes and precise rollback steps at
   every handoff. Do not reset accounts, erase data or apply firmware updates as
   part of this connection test.

Raw credentials and bearer tokens stay out of tracked evidence. Diagnostic
captures that can contain household data remain in ignored `.parity/robots/`;
publish only reviewed, sanitized results under `docs/parity/evidence/`.

## Status

The isolated Phoenix stack is running from the root-owned lead integration worktree on ports 19000 (hub),
19003 (skills), 19005 (parser), 19006 (history), and 19007 (data). The native
Jetstream override points to `192.168.1.182:19000`, with an empty entrypoint for
this explicitly unauthenticated transport trial. LINEAR16 audio reaches Parakeet
at `192.168.1.252:6972`. Classic/account endpoints remain outside this trial.

The latest owned stack loaded candidate `7d87cae491ccaa99dc1ddc8141bcb816f4a15dc8`;
its private receipt is `integration-report-reviewed/stack.json`. It includes the
reviewed parser, prompt-data, report-view and news-image changes. The earlier `f330480` audio profile remains
pinned to its own observations. On this new stack, the original Jetstream SDK's
`check the weather` request launches Nimbus, speaks, and visibly displays the
high/low temperatures and cloud icon before returning to idle. Root inspected
the [screen capture](evidence/2026-09-05/hardware/s13-weather-reviewed.png) and
recorded [timing and scope](evidence/2026-09-05/hardware/s13-weather-reviewed.json).
The new RSS adapter also preserves source image metadata: `tell me the news`
rendered three actual BBC images with Technology, Sports and Business overlays
while Nimbus spoke, then returned to idle. Root inspected all three images and
[recorded the result](evidence/2026-09-05/hardware/s13-news-reviewed.json).
Calendar and commute displays still need real-client checks. Current NPR image
gaps and the original AP attribution text under a replacement provider remain
explicit D-06 limitations.

The H-07 decoder/VAD repair has passed new quiet-microphone runs in native OGG,
FLAC and LINEAR16: each returns `SOS_TIMEOUT` without a false speech-start event.
The original LINEAR16 configuration was restored byte-for-byte. These
[bounded audio results](evidence/2026-09-05/hardware/native-audio-fixed.json)
supersede the compressed-byte failure below; recognition quality and physical
wake-word/ring observation remain open. The integrated S-04 `smile` path also
has a fresh [visually reviewed animation](evidence/2026-09-05/hardware/s04-smile-reviewed.json)
with 32-hex JCP command IDs and restored observers.

On verified BE 12.0.0, native text injection launches Nimbus and executes joke
speech. The user confirmed hearing the guitar-and-fish joke. Its frozen original
MIM specifies TTS and automatic speech gestures, with no separate illustration;
gesture fidelity is still open. A separate real microphone request, "what time
is it," sent 73,600 audio bytes and routed to `@be/clock` in 2,558 ms. The user
confirmed spoken time and the clock screen. These are individual observations,
not complete skill-task acceptance.

BE 12.0.0's original local-listening path commands only LED off, matching the
user's missing-blue-ring report. [BE-RELEASES.md](BE-RELEASES.md) locates the
listening-light and eye-animation change at 11.0.1 → 11.0.2, plus a separate
proactive configuration change that explains the after-speech null error.
Verified archives for 11.0.3, 11.0.2, and 11.0.1 are deployed in additional
slots. Root compared them in descending order against the same Phoenix process.
Only 11.0.1 issued `[0.05, 0.73, 0.94]` and queued
`hj-sp-transition-to-blink-ns` during the local listening test. Screenshots
confirm its cyan listening eye; the newer release screenshots show the ordinary
pale eye. 11.0.1 also initializes the proactive runtime, executes Nimbus joke
TTS, and reaches original surprise/local-listening interactions after speech.
It remains running in `phoenix-be-11-0-1-parity`. The user's physical wake-word
ring observation remains pending. No full hardware feature parity is certified.

The subsequent [native audio baseline](evidence/2026-09-05/hardware/native-audio-baseline.json)
captures real Opus and FLAC microphone frames. Phoenix incorrectly reports speech
for both while independent decoded RMS remains below the speech threshold for
every 20 ms frame. The restored LINEAR16 profile produces no SOS. The original
LINEAR16 configuration and Phoenix override have been restored byte-for-byte.
That historical run's stack receipt is `native-audio/stack.json`; the current
handoff is named at the top of this document. Raw recordings remain private.
The later decoder/VAD repair and quiet-microphone checks above supersede this
failing baseline for bounded audio acceptance.

The original `smile` request also passes an individual
[rendering check](evidence/2026-09-05/hardware/smile-rendering.json): Phoenix emits
`RA_JBO_Smile_AN_03`, original embodied speech dispatches `happy_01` with screen
animation channels, and the [reviewed screenshot](evidence/2026-09-05/hardware/be-11.0.1-smile.png)
shows the smiling eye. Speech eye blinks and body initiation animations also
reach the animation service. Full gesture timing and all prompt variants remain
open; this is one observed working animation path.

The installed SSM treats `@be/` package names as BE relaunches. The validation
slots use unique names in that namespace; the first `@phoenix/` name prevented
Nimbus activation and was corrected as a deployment issue. Compiled release
files were verified before changing only the root package identity. Runtime
visual observers forward the original LED/animation calls and restore those
methods after each probe.

Sanitized observations are in
[moth-baseline.json](evidence/2026-09-05/hardware/moth-baseline.json). Private
deployment receipts, native events, screenshots and wire traces are under
`.parity/robots/moth/20260905/`. `turn.py --text` uses the original BE Jetstream
SDK's CLIENT_ASR path and does not certify microphone recognition. Without
`--text`, the same SDK opens a real microphone turn. Screenshots require visual
inspection; a view identifier alone cannot establish that its content rendered.

[be-release-ladder.json](evidence/2026-09-05/hardware/be-release-ladder.json)
records the four probes, screenshot hashes and the byte comparison of all 4,845
Phoenix package files against the unchanged private testing snapshot.

## Isolation and rollback

Implementation agents work in `.parity/worktrees/{http-contract,audio-encoding,
capture-writer,nlu-requests}`, each with its own branch and local workspace dependencies.
They cannot restart this stack or use Moth. Root reviews their commits, runs
differential checks, then integrates and repeats the robot scenarios. Candidate
submission never checks off a parity task by itself.

The owned SSH tunnel forwards host 19223/18090/18585/18686 to Moth's
9222/8090/8585/8686. The running stack receipt records its PID and trace path.
The preexisting port-9000 stack in `phoenix-jibo`, Hermes files, and other robot
are preserved.

To restore the starting configuration: stop the currently running validation
package through SSM `/stop`; remount `/usr/local` writable, copy
`/opt/phoenix-parity/20260905-moth/jetstream.before.json` back to
`/usr/local/etc/jibo-jetstream-service.json`, and restore `/usr/local` read-only
even if copying fails. Verify the original SHA-256
`e7200416a9d64e2087b775ca91350c684b9b3bf56e0bc517ad0d1047084e03d3`.
Restart only Jetstream using System Manager `/service/restart`, then launch
`@hermes/jibo-be-chat` through SSM `/run`. Use JSON `{"dirName":"package-name"}`
for SSM and `{"services":["jetstream"]}` for the native restart. Stop only the
owned local stack and tunnel after the robot has switched away from them.
Keep deployment slots and evidence until the review is complete; no user data
or other skills need to be removed.

## Timer cancellation repaired in lead integration

Moth BE11.0.1 now completes the original clock duration/cancel flow using Phoenix candidate16d9116. The source SDK local update returns the exact original named-rule result and the timer screen closes without retry. This is CLIENT_ASR injection, not microphone acceptance. [Evidence](evidence/2026-09-05/hardware/timer-local-cancel-fixed.json).

## 2026-09-06 passive observation after BE recovery

A [15-minute read-only observation](evidence/2026-09-06/service-integration/moth-passive-observation-review.json) sampled 840 BE states without connection errors. Moth produced a proactive greeting, entered speech and active listening, then completed two no-speech timeout turns and returned to idle. The observer injected no input. Backend/native processes and baseline configuration, credentials and trust hashes were unchanged at postflight.

No wake-word event or recognized speech was captured. The physical blue ring, microphone wake-up and full greeting/trigger semantics remain unverified. Successful transaction status on an empty `SOS_TIMEOUT` result is not speech-recognition success. The earlier unexplained BE exit remains a stability follow-up.

## Reviewed checkpoint on Moth, 2026-09-07

A temporary authenticated trial of `9fc671f` completed original native TLS token issuance, both Hub upgrade paths, an SDK clock turn with TTS/display, and a synthetic proactive request. Root verified rollback, configuration/credential/trust hashes, five restored service healthchecks and idle. The current backend remains `3150063`; this does not certify microphone wake, the physical blue ring, natural proactivity or complete clock animation/time rendering. See the [bounded review](evidence/2026-09-07/hardware/reviewed-checkpoint/review.json).
