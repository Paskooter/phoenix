# Voice-turn latency observability

Phoenix emits JSON lines to its ordinary service stdout for each conversational
turn. They answer where a response spent time without retaining a second copy
of speech, NLU, skill payloads, audio, credentials, account identity, or robot
identity.

## What is emitted

The gateway creates a fresh UUID `turnId` for every `/listen` WebSocket. It
keeps the existing `x-jibo-transid` behavior and sends the opaque internal
header `x-phoenix-turn-id` to parser, skill, and history peers. The header is
for Phoenix-internal hops only; clients do not need to send, store, or trust it.

Gateway lines have one of these safe shapes:

```json
{"event":"voice_turn_started","turnId":"…","entrypoint":"gateway_listen"}
{"event":"voice_turn_span","turnId":"…","stage":"nlu","durationMs":34,"outcome":"ok"}
{"event":"voice_turn_complete","turnId":"…","totalMs":119,"outcome":"skill"}
```

`voice_turn_span` stages are:

| Stage | Measurement boundary |
|---|---|
| `context_wait` | Hub waiting for the robot context message (once per turn) |
| `asr` | Server ASR session, from creation through final recognition/endpoint |
| `nlu` | Gateway parser request round trip |
| `route` | Local intent routing and decision mediation |
| `skill`, `skill_redirect` | Each cloud-skill request round trip |
| `history_launch`, `history_speech` | Fire-and-forget history write completion; may appear after the final response |
| `response_ready` | Gateway accepted the final protocol frame for writing |
| `http_request` | Server-side parser/skills/history handler duration; emitted by that service when the internal turn header is present |

The existing Parakeet `ASR turn` breakdown (`audioMs`, `silenceWaitMs`, and
`recognizeMs`) now carries that same `turnId`; it remains content-free (its
`chars` field is a count, not text).

Outcomes are a small fixed vocabulary (`ok`, `matched`, `unmatched`,
`remote_error`, `timeout`, `error`, `cancelled`, `abandoned`, and final response
kind). They deliberately exclude exception messages because those can include
upstream text or malformed input.

`totalMs` is gateway-accept to final-frame-ready. It is the useful cloud-side
reply-latency budget. It is not a claim about speaker-to-audio playback time.

## Operating it

No collector, schema migration, or feature flag is required: use the existing
stdout collector. For a native launch, inspect the hub log; with Compose, use
the container logs. Filter by the generated ID from any one line, never by a
transcript.

```bash
# Native launcher (the hub's usual log file)
rg 'voice_turn_(span|complete)' /tmp/phx-compose-gateway.log

# Compose, live
docker compose logs -f gateway parser skills history | rg 'voice_turn_(span|complete)'
```

To identify the next optimization, group completed records by `stage` and look
at p50/p95 `durationMs`; then use the same `turnId` to compare gateway and
server-side lines. A large `asr` span points to endpointing/ASR work, `nlu` to
parser or its configured fallback, `skill` to the selected skill/provider, and
`response_ready - total prior spans` to orchestration/context wait. History is
off the critical response path, so do not optimize it ahead of the final
response.

Keep normal log retention short and access-controlled. Although the new records
contain no speech content, the randomly generated `turnId` and the pre-existing
`transId` are operational correlation data. Do not join them with customer
records unless that is explicitly required and governed. Do not enable
`PHOENIX_ASR_CAPTURE_DIR` merely to investigate latency: audio capture is a
separate diagnostic facility and is not needed for these spans.

Leave `ETCO_hub_recordSpeechHistory=false` (the default) unless a separately
approved speech-retention policy requires it. That legacy history option stores
turn content and is independent of this latency telemetry.

## Boundaries and limits

Wake-word detection, microphone buffering, local end-of-speech sensing, robot
network queueing, TTS synthesis, and audible playback run in native robot
components that do not currently emit a correlated Phoenix event. Therefore
Phoenix starts its clock when the listen WebSocket reaches the gateway, not when
the wake word is heard, and ends when the final response frame is accepted for
write, not when the robot finishes speaking. Compare repeated server-side turns
first; measuring the missing native phases requires a robot-side instrumented
build that propagates the same opaque turn ID and monotonic timestamps.

The Classic `log` service is a separate AWS-JSON robot telemetry protocol, not
the conversational WebSocket path. Its uploads cannot be reliably joined to a
listen turn and may contain device diagnostics, so this feature neither parses
them nor copies them into turn logs. The existing Classic log sink policy stays
unchanged.
