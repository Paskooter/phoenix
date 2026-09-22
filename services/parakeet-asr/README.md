# Parakeet ASR service

A drop-in superset of the Parakeet server deployed at `192.168.1.252:6972`
(`Parakeet ASR REST API` 0.1.0). It keeps that server's only endpoint
byte-compatible and adds the two things Jibo's ASR contract needs.

## Why

Two robot-visible behaviours were missing, both recorded in Phoenix's
`DIVERGENCES.md`:

* **H07b — `earlyEOS` cannot work.** The hub cuts an utterance short the moment
  an *interim* transcript matches a trigger phrase. A batch recognizer produces
  no interim results, so "live long and prosper" is heard whole where the
  original heard "live", and the turn routes to a skill it never should have
  reached.
* **H07c — confidence was invented.** Every confidence field came back `null`,
  because NeMo does not preserve confidence unless the decoding config asks for
  it. The client filled the gap with a constant `1.0`, which reached the robot
  in `LISTEN.data.asr.confidence` looking like a measurement. The original
  reported Google's real per-utterance value and *ranked interim results by it*.

## What it adds

| | 0.1.0 (deployed) | 0.2.0 (this) |
| --- | --- | --- |
| `POST /transcribe` | yes | yes, unchanged shape |
| confidence | always `null` | real, or `null` — never invented |
| interim results | none | `WS /stream` |
| health check | none | `GET /healthz`, no model load |
| number rewriting | none | opt-in `?normalize=true` |

## Compatibility

`POST /transcribe` still takes multipart `file` and still answers
`{"filename": ..., "transcript": {..., "text": ...}}`. Both existing clients
read `json.transcript` and accept a string or an object with `.text`
(`pegasus ParakeetASRSession.ts:236-246`,
`phoenix parakeetSession.js:542-545`), so the added keys are ignored by them.

Verified by pointing Phoenix's **unmodified** client at both servers:

```
new 0.2.0 : {"text":"testing testing one two three","confidence":0.93}
live 0.1.0: {"text":"testing testing one two three","confidence":1}
```

The second is the historical synthetic value, still produced when a server
cannot supply a real one. Nothing has to be upgraded in lockstep.

## Number rewriting is opt-in, and here is why

The request was to switch digits and words automatically. Measured first,
against the original parser rather than assumed — `jibo-nlu` 2.8.3 over the
pinned `launch.fst`:

```
set a timer for five minutes  ->  start {minutes: '5'}
set a timer for 5 minutes     ->  start {minutes: '5'}
count to ten                  ->  requestCountToNumber {CountNumber: '10'}
count to 10                   ->  requestCountToNumber {CountNumber: '10'}
set the volume to five        ->  volumeToValue {volumeLevel: '05'}
set the volume to 5           ->  volumeToValue {volumeLevel: '05'}
```

The grammars already normalise number words through their own factories, so
both forms reach the same intent with the same slots. Rewriting before the
parser buys no parity and risks harm: "one" is a pronoun as often as a number.
So it is available per request and off by default:

```
?normalize=true   "testing testing one two three" -> "testing testing 1 2 3"
                  "the big one"                   -> "the big one"   (unchanged)
                  "twenty three"                  -> "23"
```

`text_raw` always carries the unmodified transcript.

## Streaming protocol

```
client -> {"type":"start","sampleRate":16000,"normalize":false}
client -> <binary PCM16LE frames>
client -> {"type":"eos"}
server -> {"type":"interim","text":...,"confidence":...}   (repeatedly)
server -> {"type":"final","text":...,"confidence":...}
```

Interim results still re-decode the buffer so far, preserving `earlyEOS`, but
inference runs in one background worker instead of blocking the WebSocket event
loop. Audio received during an interim is coalesced into the latest buffer;
once `eos` arrives, queued partial decodes are skipped and the full-buffer
final is prioritized. Canonical 16 kHz mono s16 WAVs from Phoenix skip a
redundant ffmpeg conversion on each decode. Non-canonical uploads still use
ffmpeg. Repeated identical hypotheses are suppressed, and silence alone does
not trigger an interim. The remaining full-buffer re-decodes are a model/API
limitation; a stateful streaming model would be the next larger improvement.

## Running

```bash
# the real deployment
docker build -t parakeet-asr:latest .
docker run -d --gpus all -p 6972:6972 parakeet-asr:latest

# contract only: no NeMo, torch or CUDA. Exercises the API and the streaming
# protocol on any machine; cannot transcribe.
docker build --target contract -t parakeet-asr:contract .
docker run --rm parakeet-asr:contract python -m pytest tests/ -q
```

### CPU-only fallback

The production Parakeet/NeMo model is GPU-oriented.  A small VPS must not
attempt to run it just because `PARAKEET_URL` is configured: model loading can
exhaust RAM and take the entire robot cloud down.  The same server includes a
batch-compatible CPU fallback using Faster-Whisper.  It preserves the private
`/healthz` and `POST /transcribe` contract, but intentionally advertises API
0.1 so the Hub uses batch recognition instead of expensive streaming partial
decodes.  It is a practical availability fallback, not a claim of acoustic
parity with the Parakeet model.

```bash
python3 -m venv /opt/phoenix-asr/venv
/opt/phoenix-asr/venv/bin/pip install -r requirements-cpu.txt
PARAKEET_BACKEND=faster-whisper \
  /opt/phoenix-asr/venv/bin/uvicorn app.server:app --host 127.0.0.1 --port 6972
```

It downloads the selected model on first start.  `PARAKEET_CPU_MODEL=base.en`
is the memory-safe default; use `small.en` only after measuring memory and
latency on the target.  Bind only to loopback and set Phoenix's
`PARAKEET_URL=http://127.0.0.1:6972`; never expose this microphone-input API to
the Internet.

The original built on `nvcr.io/nvidia/nemo:26.02`. That image needs an NGC
login to pull, so this installs NeMo from pip on a plain `python:3.10-slim`
base instead. Do not switch the base back without checking that the pull still
works.

| env | default | meaning |
| --- | --- | --- |
| `PARAKEET_MODEL` | `nvidia/parakeet-rnnt-0.6b` | NeMo model name. **Not** interchangeable with `parakeet-tdt-0.6b-v2`: TDT emits punctuation, and punctuation does not parse. |
| `PARAKEET_DEVICE` | *(unset)* | e.g. `cuda`; unset lets NeMo decide |
| `PARAKEET_INTERIM_MS` | `300` | interim decode window |
| `PARAKEET_SILENCE_RMS` | `200` | below this a chunk is silence |

## Tests, and what they do not cover

```bash
python3 -m pytest tests/ -q     # contract tests; no GPU/model required
```

They run without a model or a GPU, because the recognizer is injected. That
means the **wire contract is verified and the model integration is not**:
`NemoRecognizer` — including `_enable_confidence`, which is the part that makes
H07c closable — has never executed here. It needs one run on a machine with the
model before anything about real confidence values is claimed.

Falsification: reverting the confidence field to a constant `1.0` fails three
named tests, including `test_absent_confidence_is_null_not_invented`.
