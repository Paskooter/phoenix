# Parakeet ASR service

A drop-in superset of the Parakeet server deployed at `192.168.1.252:6972`
(`Parakeet ASR REST API` 0.1.0). It keeps that server's only endpoint
byte-compatible, adds streaming and confidence, and batches simultaneous robots'
recognition jobs on one resident model.

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

| | 0.1.0 (original) | 0.3.0 (this) |
| --- | --- | --- |
| `POST /transcribe` | yes | yes, unchanged shape |
| confidence | always `null` | real, or `null` — never invented |
| interim results | none | `WS /stream` |
| health check | none | `GET /healthz`, no model load |
| number rewriting | none | opt-in `?normalize=true` |
| simultaneous recognition | one recording per call | bounded dynamic batches across streams and uploads |

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

## Simultaneous robots

API 0.2.1 already accepted multiple sockets, but queued **every decode one at a
time** behind a single inference worker. API 0.3.0 keeps one worker owning the
shared NeMo model and combines independent recordings into GPU batches, using
[NeMo's supported `transcribe(..., batch_size=...)` interface](https://docs.nvidia.com/nemo/speech/nightly/asr/inference.html).
Running concurrent `transcribe()` calls on the same mutable model or adding
uvicorn workers would instead risk shared decoder state or duplicate model
weights in VRAM.

Defaults admit **32 open streams**, decode up to **4 recordings per batch**, and
allow at most **64 queued plus running jobs**. A 10 ms collection window groups
simultaneous arrivals. Every socket keeps its own PCM, transcript and confidence;
HTTP WAV uploads use the same scheduler. Only one interim per socket can be
pending. EOS and disconnect cancel stale queued interims; finals take priority
over other sockets' queued interims. A GPU call already running completes safely.

These are configurable service limits, **not a measured promise that a 16 GB GPU
can transcribe 32 continuously talking robots at acceptable latency**. Start
with batches of 4; benchmark 8 and 16 simultaneous talkers before increasing the
production target. If CUDA runs out of memory, the recognizer retries smaller
microbatches and remembers the reduced limit. An individual failure still
returns an error; it never creates a transcript or restarts the service.

`GET /healthz` now includes `concurrency`: configured limits, active streams,
queued finals/interims, running jobs, completed/failed jobs, number and largest
size of batches, overload count, and a reduced `model_batch_limit` after an OOM.
An exhausted queue returns HTTP **503** with `Retry-After: 1`; extra sockets close
with **1013**. PCM buffers are limited to 30 seconds per stream (Phoenix's own
utterance cap), and WAV uploads to 8 MiB. Oversized audio gets 1009 or HTTP 413.
The CPU fallback remains serial and advertises its actual batch size of 1.

### Measure capacity on the GPU host

Use a short speech WAV in 16 kHz mono PCM16 format, ideally several distinct
utterances tested in separate runs. The included benchmark sends every stream in
real time, waits for finals, samples health, and samples `nvidia-smi` when it is
available **on the machine running the benchmark**. It reports GPU memory used
by all applications, so concurrent desktop/LLM use counts against the budget.

```bash
# Run inside the new container, with a speech WAV copied to /tmp/speech.wav.
docker cp /path/to/speech.wav phoenix-parakeet:/tmp/speech.wav
docker exec phoenix-parakeet python tools/benchmark.py \
  --wav /tmp/speech.wav --streams 1 4 8 16 32 --rounds 3
```

The benchmark reports final transcript latency measured from EOS, first interim
latency, errors and peak queue/GPU usage. It stops increasing load after errors,
failed health probes, or p95 final latency above 2 seconds. `--expected-text`
also checks the exact normalized transcript. Choose a count with no errors,
responsive interims and room in GPU memory; repeat with longer utterances and
other GPU applications running. Open idle connections cost almost no inference;
capacity depends on how many robots speak simultaneously and for how long.

A single baseline sweep against `192.168.1.252:6972` on **2026-10-03**, while it
still served API **0.2.1**, used the same synthesized 2.74-second sentence on all
streams (100 ms frames). It completed all streams, with these final latencies:

| simultaneous talkers | p95 final latency after EOS | errors |
| --- | --- | --- |
| 1 | 88 ms | 0 |
| 4 | 389 ms | 0 |
| 8 | 1,933 ms | 0 |

This establishes that the existing service handles overlapping connections and
shows latency rising under its serial inference queue. It does not measure
maximum capacity or the new batching implementation on that GPU; no GPU memory
probe was available from the remote benchmark host.

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

The production image requires CUDA and explicitly moves NeMo to `cuda`. If
Torch cannot see the GPU, startup fails instead of quietly transcribing on CPU.
After rebuilding, `/healthz` reports API `0.3.0` and `concurrency.batching: true`;
`0.2.1` or older means the serial image is still serving. Do not assume the
container was rebuilt just because Docker reports it as running.

For a PC that already has a working Blackwell CUDA/Torch/NeMo image, update its
API without reinstalling the GPU stack. Build to a separate tag so the old image
remains available for rollback:

```bash
# Run on the GPU host, from the newly copied source directory. This discovers
# the original Compose files and service name from the existing container.
python3 tools/update-compose.py --container parakeet-asr-gpu --apply
```

The helper reads the existing container's **image ID**, so no guessed image tag
or registry login is required. It builds and verifies API 0.3.0, then uses a
small Compose override to select that image. GPU access, ports, environment,
model-cache volumes and other services are preserved. Mounts hiding `/srv/app`
are redirected to the newly copied application code. The service runs one
uvicorn worker so all requests use the same model and batching scheduler.

Without `--apply`, it only prepares the image and prints the command to recreate
the ASR service. It writes `compose.parakeet-0.3.0.yaml` and
`parakeet-compose-0.3.0.sh` alongside the original Compose files. Use that shell
wrapper for future Compose commands: with no arguments it starts only the ASR
service, or pass `logs -f`, `config`, or other Compose arguments. The original
files stay available for rollback. The override requires Compose 2.24.4 or newer.
After a source change, rerun the helper to rebuild and verify it before starting.

`docker compose up -d --build` only builds services with a `build:` definition.
If an existing Compose file contains only `image:`, copying new Python files
and recreating the container still starts the old image. The helper supplies
the missing build configuration and selects the verified new image.

For a manual image build, first alias the actual running image:

```bash
ASR_IMAGE=$(docker inspect -f '{{.Image}}' parakeet-asr-gpu)
docker tag "$ASR_IMAGE" parakeet-asr:working-base
docker build -f Dockerfile.update \
  --build-arg PARAKEET_BASE_IMAGE=parakeet-asr:working-base \
  -t parakeet-asr:0.3.0 .
docker run --rm --entrypoint python parakeet-asr:0.3.0 -m pytest tests/ -q
```

Recreate the ASR container from `parakeet-asr:0.3.0` with its existing GPU, port,
model-cache volume and environment settings during an idle window. `/healthz` must show
0.3.0 before benchmarking. No Phoenix Hub update is needed. Production server
release changes still go through `scripts/deploy-native-release.sh` and its
Hub/OTA activity guard; updating this separate PC image does not require a Hub
restart.

### GPU checks on Windows/WSL2

Use an up-to-date NVIDIA **Windows** driver, WSL2 kernel, and Docker Desktop
WSL2 backend with integration enabled for your distro. Do not install a Linux
NVIDIA display driver inside WSL. From WSL, first check host and Docker GPU
visibility, then the exact Parakeet image:

```bash
nvidia-smi  # or /usr/lib/wsl/lib/nvidia-smi if it is not on PATH
docker run --rm --gpus all --entrypoint python parakeet-asr:latest -c \
  'import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.device_count()); print(torch.cuda.get_arch_list())'
```

The existing local image is the most useful probe: it avoids a registry
download and tests the exact Torch installation Parakeet uses. If `docker run
--gpus all` fails before Python starts, fix WSL/Docker GPU pass-through. If it
starts but Torch reports `False` or `torch.version.cuda` is `None`, check the
GPU device request and Torch build. For an RTX 50-series GPU the
Torch build must support its Blackwell architecture (`sm_120`); inspect the
printed architecture list rather than assuming a CUDA wheel is sufficient.
If all checks pass, recreate the existing Parakeet container with `--gpus all`
(or Compose `gpus: all`), verify `/healthz` says `0.3.0`, and repeat the Torch
check **inside that running container**. Docker's GPU flag is set when the
container is created; restarting one created without it does not add a GPU.

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
| `PARAKEET_BATCH_SIZE` | `4` | maximum independent recordings submitted in one model batch |
| `PARAKEET_BATCH_WAIT_MS` | `10` | collection window when the inference queue becomes nonempty |
| `PARAKEET_MAX_STREAMS` | `32` | maximum admitted WebSocket streams |
| `PARAKEET_MAX_PENDING` | `64` | maximum queued plus running inference jobs across both endpoints |
| `PARAKEET_MAX_AUDIO_SECONDS` | `30` | maximum buffered PCM per stream, matching Phoenix's utterance cap |
| `PARAKEET_MAX_UPLOAD_BYTES` | `8388608` | maximum WAV upload admitted for inference |

## Tests, and what they do not cover

```bash
python3 -m pytest tests/ -q     # contract tests; no GPU/model required
```

They run without a model or a GPU, because the recognizer is injected. That
means the **wire contract is verified and the model integration is not**:
`NemoRecognizer` is exercised with a fake NeMo model, including multi-input
calls, result/confidence isolation, invalid-upload isolation and OOM backoff.
The tests also open 16 overlapping sockets and prove that their finals enter
bounded model batches. Real NeMo/CUDA batching and its memory/latency still need
a run of the new image on the GPU host. The old live service's confidence value
is not proof of the new image's model integration.

Falsification: reverting the confidence field to a constant `1.0` fails three
named tests, including `test_absent_confidence_is_null_not_invented`.
