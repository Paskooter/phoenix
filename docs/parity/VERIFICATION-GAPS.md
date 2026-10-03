# Verification review — 2026-10-03

The normal robot repoint and OTA flow is **owner-certified on hardware**, with
the repoint helper verified on ten firmware combinations. The
[owner sign-off](evidence/2026-10-03/ota-owner-certification/README.md) closes
R-06 and R-07 at that scope. This page collects the remaining checks and the
claims that need clarification, so successful OTA delivery does not keep
appearing as unfinished work.

[tasks.json](tasks.json) owns task status; [TASKS.md](TASKS.md) is generated from
it. Dated evidence, candidate reviews and internal work logs describe the state
at capture time. A limitation in an older record is superseded when a later
accepted record covers the same behavior. The current task finding must reflect
that later acceptance.

An unchecked item below means **confirmation or evidence is still needed for
that specific item**. The owner may already have performed it. It does not
withdraw the certification of the normal OTA flow. Routine checks for a newly
built release are listed separately at the end.

## Signed off

- [x] Normal repoint and native OTA flow on physical robots, including stock
  robots — owner certification, 2026-10-03 (R-06).
- [x] Repoint helper exercised on ten firmware combinations — owner
  certification, 2026-10-03.
- [x] Phoenix configuration delivered by the working OTA flow — owner
  certification, 2026-10-03 (R-07).
- [x] Factory RTM QR + Wi-Fi setup followed by native OTA — owner follow-up,
  2026-10-03, recalling all RTM releases.
- [x] Reported firmware/migration reruns — owner follow-up, 2026-10-03; explicit
  recalled cases also include 13.0.0 and a robot previously repointed to `5x1`.
- [x] All eight Update operations and package byte/hash delivery —
  [A-08 acceptance](evidence/2026-09-10/a08-update-delivery/review.md).
- [x] Native OOBE protocol, TLS, credential issuance and setup-token replay
  rejection on Aero — [A-05 acceptance](evidence/2026-09-17/a05-oobe-aero/README.md).
- [x] Native CreateHubToken/Bearer sockets and cached-token rotation/refetch —
  [H-10 acceptance](evidence/2026-09-11/h10-native-bearer-upgrade/review.md).
- [x] Durable account/loop/settings/history/backup/key/media/voice-training
  contracts and notification queue/socket delivery — the accepted records in
  [TASKS.md](TASKS.md). The former missing/stub/in-memory summaries are stale.

## OTA cases to identify or confirm

| ID | Status | Check or remaining detail |
|---|---|---|
| OTA-01 | Documentation follow-up | Itemize the ten combinations. Known coverage includes all RTM releases, 13.0.0 and prior `5x1` routing; individual OS/services/OOBE/BE versions, revisions and dates can be added as available. |
| OTA-02 | **Owner-verified** | Clean factory RTM2/RTM3 Wi-Fi, camera QR, setup and native OTA; the October 3 follow-up supersedes the historical factory setup gaps. |
| OTA-03 | **Owner-verified rerun**; source follow-up | The reported 12.10.0/migration case was included in the follow-up. Exact source for SSM SHA-256 `b0809e59adb0e9b857f46de3eab6726501038cf02d6eff1731a832335e5ae32d` is still useful as a regression fixture; the inspected production archive has a different hash. |
| OTA-04 | **Owner-verified** | Previously migrated robot rerun; the follow-up closes the named migration checks and explicitly recalls a robot previously repointed to `5x1`. |
| OTA-05 | **Not tested** | Corrupt or truncated package refused by the physical updater: retain advertised checksum/length, rejection and subsequent boot evidence (R-10). |
| OTA-06 | **Not tested** | Interrupted update recovery: disconnect/download, host killed during query override, and interrupted installation separately. Local lease/planning tests exist; hardware observations remain open (R-10). |
| OTA-07 | **Not tested** | A/B fallback from an unbootable OS slot: observe U-Boot `bootcount`/`bootlimit` recovery and a usable robot afterward (R-10). |
| OTA-08 | Detailed witness to confirm | Identity, keys, Wi-Fi, calibration, registry and household state before/after. Preservation is part of the supported design; a detailed comparison was not included in the owner's statement. |
| OTA-09 | Negative cases to confirm | Cached-ID/dependency failure controls on hardware; normal release installation and factory filters are covered by the certified flow. New IDs, aligned dependencies and accurate version reporters remain release rules (R-10). |
| OTA-10 | Specific capacity/layout case to confirm | Small stock `/opt` filesystem grown in place, adequate scratch space, original mount modes restored, unsupported layouts refused. General factory setup is signed off. |
| OTA-11 | Negative control to confirm | Deliberately incorrect baked endpoint fails to connect without leftover LAN redirects or prior configuration masking it (R-10, former R-07 criterion). |

New firmware or executable variants should be added to OTA-01/03 as they appear.
Unknown patch targets retain their preflight refusal. Owner-verified rows are
closed; the remaining rows identify specific untested cases or documentation
details beyond the successful flow.

## Wider release and hardware acceptance

| ID | Remaining acceptance | Where it is tracked |
|---|---|---|
| HW-01 | Full USB/RCM flash with baked configuration, no later repoint, `/var` preservation and fallback | R-08. An OTA sign-off does not identify a completed USB flash trial. The image baker exists; the old claim that no image can carry a repoint is obsolete. |
| HW-02 | Maintained public CA bundle, actual OS/Node/Electron consumers, valid chains and rejected hostname/expired chains | R-09. Public jibo.io TLS and Node 4/6 bundle handling work; comprehensive trust-store refresh and negative chain tests remain separate. |
| HW-03 | Physical wake word, microphone recognition across encodings/noise/pauses and visible listening ring | R-04/H-07/H-10, [HARDWARE.md](HARDWARE.md). Existing text injection, quiet-microphone checks and individual spoken turns do not cover the complete acoustic matrix. |
| HW-04 | Real local/global follow-ups, natural proactive preferences, complete skill-family displays/gestures and reconnect | R-04. Accepted source/fixture tests and individual display captures exist; owner observations can close specific physical cases. |
| HW-05 | Account/loop/settings persistence across robot/server reboot for supported firmware/client journeys | R-04. Process/store restart checks exist; the complete user journey matrix still needs its own record. |
| HW-06 | Three-hour native token expiry and notification rejection/retry/keepalive behavior | H-10/A-10 evidence qualifications. Secret rotation/refetch and real delivered/acknowledged frames are already verified. |
| HW-07 | Skill-session cutover on a real robot after host/graph shape changes | [S-01 cutover acceptance](evidence/2026-09-11/s01-graph-sessions/cutover-runbook.md). The deployed cutover gate is tested; the physical cutover action was left unknown. |
| REL-01 | Final release parity report with every accepted scope and residual gap reconciled | R-05. Depends on R-04, R-08, R-09 and R-10; R-06/R-07 are now signed off. |

## Accepted scope with remaining qualifications

These task checkboxes are already verified at their recorded scope. The rows
below preserve a narrower remaining experiment, implementation difference or
external dependency; they are not a new claim that the whole task is missing.

| ID | Qualification to review | Accepted record or current decision |
|---|---|---|
| QUAL-01 | Concurrent proactive selection/silent-message/context-timeout edges; late speech-history timeout and auth-disabled recording edges | H-06/H-08 notes. Reconfirm against current source; [R-03](evidence/2026-09-18/r03/README.md) covers general reliability. The former missing HubErrorCode values are now present and PARSER frames repaired. |
| QUAL-02 | Unsupported digit/year/city factories, finite word-list semantics and historical native grammar rebuild | Current rule inventory, N-01/N-02/N-05 and [DIVERGENCES.md](../DIVERGENCES.md). N-03 closes supported clock time/colon/AM-PM behavior; the older whole-time-factory blocker is superseded. Compiled and AST profiles retain their accepted boundaries. |
| QUAL-03 | Live Google/Outlook authorization, refresh/revocation and real provider calendars | D-03/D-04. Provider exchange/refresh/error/query contracts are exercised; live credentials were an external gate. |
| QUAL-04 | Historical weather outside the provider window and apparent temperature; RSS category/image/attribution metadata; real transit and optional route fields | D-05/D-06/D-07. TomTom now supplies measured live traffic, superseding the old ORS no-traffic gap. Other replacement-provider differences remain documented. |
| QUAL-05 | Live GQA vendors, complete word-list corpus and output goldens for input-only integration rows | [Q-01 acceptance](evidence/2026-09-13/q01-verification/review.md). Bounded source-shaped verification is accepted; 29 archive rows remain partial and retired vendors need a replacement or explicit scope decision. |
| QUAL-06 | Settings robot-face mutation membership difference and manufacturing/owner resolution beyond injected fixtures | A-06/A-07 qualifications. Current production authorization should be reviewed against the current source before treating an old qualification as a live defect. |
| QUAL-07 | SNS/Kafka event delivery beyond the local stores/outboxes | A-11/A-16/A-19 and [DIVERGENCES.md](../DIVERGENCES.md). Local key crypto, ROM certificates and Jot SDK contracts work; external event-bus equivalence is separately scoped. |
| QUAL-08 | Media URLs after a public origin/port changes | A-14: stored Create-time URLs were accepted with this limitation. This is an origin migration check, not a missing media store. |
| QUAL-09 | Original phonetic model/index equivalence and the optional legacy NLP POS/NER engine | A-15/A-17. Collision uses a documented grapheme approximation; legacy Phonetisaurus and spaCy/Python 2 behavior were not reproduced. |
| QUAL-10 | Physical handset push, Commander LAN session, IFTTT delivery and original-app voice enrollment | A-13/A-16/A-17/A-20. Available SDK/provider-seam contracts are accepted. Retired providers or an unavailable mobile app require a replacement client/provider or an explicit exclusion; they cannot be closed by a robot OTA trial. |
| QUAL-11 | Recovered non-SDK `app-toolkit-manager` and `logparser` surfaces | A-18 notes assign these to future discovery/child tasks; the completed five OAuthClients/LPS operations do not cover them. |
| QUAL-12 | Third-party skill-store/install metadata and other historical internal/admin services | [Classic inventory](../CLASSIC-SERVICES.md). These discovery surfaces are outside the certified conversation/pairing/OTA journey; decide required behavior and ownership before adding completion claims. |
| QUAL-13 | Original build/database infrastructure beyond the accepted fixtures | V-01/R-02 and [REFERENCE.md](REFERENCE.md). The original Gulp build and a complete restorable Mongo dump were unavailable; pinned executable fixtures and Phoenix JSON migration are accepted at their recorded scope. |
| QUAL-14 | Modern Node 22/Electron 43 composed firmware candidate | The [historical workbench note](OTA-UPGRADE.md#historical-firmware-workbench). Its full-flash geometry, runtime/sandbox and trust validation require their own hardware record; it is separate from the certified native OTA release. |
| QUAL-15 | Full runtime equivalence of additional archived firmware/client profiles | [COMPATIBILITY.md](COMPATIBILITY.md) and [CONSUMERS.md](CONSUMERS.md). BE 12 source-map comparisons and historical Hashbrown pins identify contracts; they do not establish every cross-profile runtime journey. Match the owner's ten trials to exact versions as those details become available. |

Facebook's retired operations, removed Jot party-era operations, source-faithful
quirks and explicitly accepted defensive behavior remain documented decisions
in [DIVERGENCES.md](../DIVERGENCES.md). They do not need another happy-path test
to become implemented. New scope would need a separate decision.

## Deployment cases to confirm when applicable

The deployment guides identify checks they did not perform in their local
environment. A working robot OTA does not establish these infrastructure
cases, and an unperformed guide check does not establish that the deployment is
broken. Confirm the target-host results or exclude an unused hosting option.

| ID | Remaining target-host check | Guide |
|---|---|---|
| OPS-01 | Real nginx ingress, DNS, Certbot issuance/renewal, trusted Classic TLS, a granted administrator account and an external client crossing the firewall | [Portal hosting verification scope](../portal-nginx-hosting.md#verification-scope). Direct Node routes were tested; the guide did not exercise the reverse proxy and public-host boundary. |
| OPS-02 | Cloudflare DNS/proxy, WebSockets, strict origin TLS, cache rules, optional Spectrum and original-client header restoration | [DEPLOYMENT.md](../DEPLOYMENT.md). These are conditional checks for a Cloudflare deployment, not requirements to adopt Cloudflare. |

## Checks for every changed release

These are continuing release gates, rather than evidence that the already
certified flow is unfinished:

- Build BE from the complete, committed tree in the separate local `jibo-be`
  project, and pass `scripts/be_ota_integrity.py` against the complete hash-pinned
  official 11.0.1 archive. Preserve the [BE release rules](BE-RELEASES.md).
- Inspect OS/services package members, baked endpoints/trust, filesystem
  metadata, version reporters, lengths and hashes; preserve the no-hook design.
- Give changed offers new IDs, align exact dependencies and validate selection
  across all filters; retain preflight, checksum and repeat-run guards.
- Run the existing real Node 4.1.2/6.9.2 helper regressions and physical boot/voice
  checks for a changed payload. Link the release's versions/hashes and outcome.
- Deploy the server through `scripts/deploy-native-release.sh` with fresh Hub
  and OTA activity and the full resettable 60-second idle interval.
