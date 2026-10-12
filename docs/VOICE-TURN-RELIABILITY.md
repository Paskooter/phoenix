# Voice-turn reliability

## Bounded command endpoint

All Phoenix recognizer modes (`parakeet`, `auto`, `google`) share the local
`ParakeetASRSession` endpointer. The legacy Google parity/mock seam is separate.
A command ends and its accepted audio is **recognized** after 12 seconds from
start-of-speech, measured both in decoded audio and wall-clock time. This budget
is not renewed by a discarded wake tail or an empty recognition window. The
endpoint reason is `max-utterance`; unlike `MAX_SPEECH_TIMEOUT`, it does not mark
the recognized words as unusable to the robot. The original 30-second buffer
limit remains the outer no-SOS/memory guard.

The existing adaptive floor only learns windows below its speech gate. Steady
noise starting above that gate can therefore be classified as speech indefinitely.
A hard cap is intentionally independent of that classifier. We retain the
900 ms silence gate and quieter-syllable hysteresis rather than raising them
blindly: the investigation's slow turns held 20.77–22.37 seconds of audio but
recognition took at most 208 ms, and earlier 400 ms silence gates clipped breaths.
This is a bound, **not** a claim to distinguish TV speech from the speaker.
Commands longer than the cap can be clipped; operators supporting dictation
should raise the cap and verify microphone/room behavior.

Environment values are read when the module loads; change them on the gateway
process and use the guarded release workflow, not a live unguarded restart.
Invalid/nonfinite/out-of-range values use the defaults.

| Variable | Default | Allowed range | Purpose |
|---|---:|---:|---|
| `PHOENIX_ASR_MAX_UTTERANCE_MS` | 12000 | 1000–30000 | Command audio and wall-clock cap after SOS |
| `PHOENIX_ASR_SILENCE_EOS_MS` | 900 | 100–5000 | Continuous trailing silence |
| `PHOENIX_ASR_SPEECH_RMS` | 400 | 1–32767 | Absolute RMS speech gate |
| `PHOENIX_ASR_SPEECH_MIN_MS` | 150 | 10–1000 | Cumulative speech before SOS |
| `PHOENIX_ASR_NOISE_MARGIN` | 1.8 | 1–10 | Initial speech/noise-floor ratio |
| `PHOENIX_ASR_CONTINUING_MARGIN` | 1.3 | 1–10 | Continuing ratio, capped by initial ratio |
| `PHOENIX_ASR_NOISE_ATTACK` | 0.05 | 0.001–1 | Rising noise-floor EMA weight |
| `PHOENIX_ASR_NOISE_DECAY` | 0.25 | 0.001–1 | Falling noise-floor EMA weight |
| `PHOENIX_ASR_SPEECH_DEBOUNCE_MS` | 30 | 10–1000 | Sustained energy required to resume speech |
| `PHOENIX_ASR_WAKE_TAIL_MS` | 200 | 0–1000 | Maximum ignored hotphrase-tail speech |
| `PHOENIX_ASR_WAKE_TAIL_IGNORE_LIMIT` | 1 | 0–3 | Ignored wake-tail windows |

## Empty-endpoint relisten budget

An empty silence candidate permits at most **one** relisten (two recognition
candidates total). The first empty result starts a non-renewable **2500 ms**
wait for fresh speech. No audio, or a near-empty energy burst, ends cleanly with
one wire EOS and an empty `SOS_TIMEOUT` result without posting another noise
clip. A fresh speech run meeting the existing SOS minimum cancels that wait so
a real second request can finish under the command cap. A longer genuine request
never buys another empty-result retry; the count budget remains in force.
The wait deadline survives additional empty windows when the retry count is
raised. Provider recognition itself retains its existing ASR deadline.

| Variable | Default | Allowed range | Purpose |
|---|---:|---:|---|
| `PHOENIX_ASR_RELISTEN_LIMIT` | 1 | 0–3 (integer, fractional values floored) | Extra empty-result recognition windows |
| `PHOENIX_ASR_RELISTEN_WAIT_MS` | 2500 | 250–10000 | Total wait for fresh speech after the first empty result |

## Failure and socket-close diagnostics

Every terminal ASR failure keeps the existing robot-facing `ASR` code/message,
but the service log's `transaction failed` record adds allowlisted `provider`
(`parakeet`, `google`, or `unknown`), `errorCode`, optional numeric `grpcCode`
(0–16), and optional fixed `failover` category. Provider finalize/stream/fallback
failure logs use the same fields instead of copying upstream messages or bodies.
HTTP rejection statuses become `HTTP_400`–`HTTP_599`; known local, network and
Google STT codes are preserved; unrecognized codes become `ASR_UNKNOWN`.
The one-day voice timing store persists the same safe fields under `failure`.
Neither provider URLs, arbitrary error text, transcripts, audio nor identity
fields are added. The existing transaction correlation ID remains available.

The legacy Google/mock recognizer uses the same safe diagnostics for failures,
malformed response frames, final-result timeout, and teardown errors. Its debug
and fallback logs no longer serialize recognizer frames or interim transcripts;
its robot-facing result, timeout policy and stream lifecycle remain unchanged.

A mid-turn disconnect emits `voice_turn_socket_close` and persists `socketClose`
with `stage`, `closedBy`, `closeCode`, and a fixed `reason` classification.
`closedBy=server` means the server explicitly called close/terminate first;
`peer` means a close frame was received first. An abnormal transport loss with
no close frame is `unknown`, **not** proof of an intentional client cancel.
Raw WebSocket reason strings are never retained. Routine closes after a settled
response do not count as abandonments. Stage labels distinguish ASR, context
wait, NLU, route, skill and redirect work without inspecting client content.

Tests use synthetic PCM, injected/local recognizers, and mocked clocks; these
are endpoint/lifecycle proofs, not acoustic accuracy or audible-playback proofs.
The pre-existing 20/30-second failover fixtures explicitly select the supported
30000 ms long-window override; independent endpoint tests pin the default cap.

## Unmatched global turns: retain the native contract

An unmatched global command still returns a final `LISTEN` with `match:null`
and its ASR/NLU result. `LISTEN` here is a **result type**, not a request for
another microphone turn. The native Jetstream SDK classifies the result as a
no-match and emits the global no-match event; Global Service/BE own the native
relaunch. Classic's Idle `HJNoMatch` flow provides eye/no-match sound feedback
and, when its stock frequency policy permits, the `IdleNMExplanation.mim` TTS
announcement. Repeated no-matches intentionally switch to non-verbal feedback.
False wakes annotated `SOS_TIMEOUT`, `GARBAGE` or `MAX_SPEECH_TIMEOUT` instead
follow the native no-input path and must not trigger a spoken failure prompt.

With Agent mode enabled **and connected**, the BE adapter claims fresh spoken
global relaunches and hands them to Agent chat (except native escape/admin/app
commands). Disabled/disconnected Agent mode retains the native Classic route.
Mode and host admission are robot-local; the hub has no authoritative mode flag.
Consequently no server-side skill/TTS fallback is injected: it could double-speak
or steal a turn from Agent and defeat Classic's deliberate no-match frequency
policy. Unmatched non-hotphrase skill follow-ups still update the active skill.

These conclusions come from offline SDK/Idle/BE adapter source and an executable
SDK/Idle module probe. They do not certify native Global Service delivery,
installed renderer health, sound volume, or audible TTS playback on a robot.
After release, verify both modes physically before calling unmatched results
"answered"; server `response_ready=listen` alone does not establish that.
