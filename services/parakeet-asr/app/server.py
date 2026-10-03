"""Parakeet ASR REST API — a drop-in superset of the deployed 0.1.0 server.

WHY THIS EXISTS
The deployed server offers one endpoint, ``POST /transcribe``, which returns a
dumped NeMo hypothesis. Two robot-visible behaviours are missing as a result,
both recorded against Phoenix:

  H07b  earlyEOS cannot work. The hub truncates an utterance the moment an
        interim transcript matches a trigger phrase ("live", "stop"). A batch
        recognizer produces no interim results, so the hub hears the whole
        utterance and routes it to a skill the original never reached.
  H07c  Confidence is absent. Every confidence field comes back null, so the
        client synthesised a constant 1.0 that reached the robot looking like a
        measurement. The original reported Google's real per-utterance value
        and ranked interim results by it.

This server keeps the existing endpoint byte-compatible and adds what those two
need: interim results over a WebSocket, and real confidence from the decoder.

COMPATIBILITY
``POST /transcribe`` still accepts multipart ``file`` and still answers
``{"filename": ..., "transcript": {..., "text": ...}}``. Both existing clients
read ``json.transcript`` and accept a string or an object with ``.text``
(pegasus ParakeetASRSession.ts:236-246, phoenix parakeetSession.js:542-545), so
added keys are ignored by them and nothing has to be upgraded in lockstep.
"""
from __future__ import annotations

import asyncio
import json
import os
from typing import Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect

from .recognizer import AudioInput, Recognizer, Transcript, rms
from .inference import InferenceScheduler, ServiceBusy
from .normalize import normalize_text, to_asr_text

SAMPLE_RATE = int(os.environ.get("PARAKEET_SAMPLE_RATE", "16000"))
# How much new audio to accumulate before re-decoding during streaming. The hub
# applies earlyEOS to whatever interim text it has, so this is the granularity
# at which a trigger word can cut an utterance short.
INTERIM_MS = int(os.environ.get("PARAKEET_INTERIM_MS", "300"))
# Below this RMS a chunk is silence and not worth a decode pass.
SILENCE_RMS = float(os.environ.get("PARAKEET_SILENCE_RMS", "200"))

# CPU Whisper is intentionally batch-only.  Advertising 0.1 keeps existing
# Hub clients on the mature POST /transcribe fallback, avoiding the repeated
# partial-buffer inference that streaming requires from a GPU-sized backend.
BACKEND = os.environ.get("PARAKEET_BACKEND", "nemo").strip().lower()
API_VERSION = "0.1.0" if BACKEND == "faster-whisper" else "0.3.0"
MAX_STREAMS = int(os.environ.get("PARAKEET_MAX_STREAMS", "32"))
BATCH_SIZE = int(os.environ.get("PARAKEET_BATCH_SIZE", "4"))
BATCH_WAIT_MS = int(os.environ.get("PARAKEET_BATCH_WAIT_MS", "10"))
MAX_PENDING = int(os.environ.get("PARAKEET_MAX_PENDING", "64"))
MAX_AUDIO_SECONDS = int(os.environ.get("PARAKEET_MAX_AUDIO_SECONDS", "30"))
MAX_UPLOAD_BYTES = int(os.environ.get("PARAKEET_MAX_UPLOAD_BYTES", str(8 * 1024 * 1024)))

_recognizer: Optional[Recognizer] = None

def get_scheduler() -> InferenceScheduler:
    scheduler = getattr(app.state, "inference", None)
    if scheduler is None:
        raise ServiceBusy("ASR is not ready")
    return scheduler


def set_recognizer(recognizer: Optional[Recognizer]) -> None:
    """Inject a recognizer. Tests use this; production leaves it unset."""
    global _recognizer
    _recognizer = recognizer


def get_recognizer() -> Recognizer:
    global _recognizer
    if _recognizer is None:
        if BACKEND == "faster-whisper":
            from .recognizer import FasterWhisperRecognizer
            _recognizer = FasterWhisperRecognizer()
        else:
            from .recognizer import NemoRecognizer
            _recognizer = NemoRecognizer()
    return _recognizer


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Load the model before accepting requests, as the original service did.

    The original logged "Model loaded successfully and ready for requests!"
    after pulling the weights into VRAM, so the first transcription is not the
    one that pays the 30-90s load. A recognizer injected by tests is left
    alone.
    """
    recognizer = _recognizer
    if recognizer is None:
        recognizer = get_recognizer()
        set_recognizer(recognizer)
    loader = getattr(recognizer, "load", None)
    if callable(loader):
        print(f"Loading {getattr(recognizer, 'model_name', 'model')} into VRAM...")
        loader()
        print("Model loaded successfully and ready for requests!")
    if min(MAX_AUDIO_SECONDS, MAX_UPLOAD_BYTES) < 1:
        raise ValueError("ASR audio limits must be positive")
    scheduler = InferenceScheduler(recognizer, batch_size=BATCH_SIZE,
                                   batch_wait_ms=BATCH_WAIT_MS, max_pending=MAX_PENDING,
                                   max_streams=MAX_STREAMS)
    _app.state.inference = scheduler
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.close()
        del _app.state.inference


app = FastAPI(title="Parakeet ASR REST API", version=API_VERSION, lifespan=lifespan)


def _payload(filename: str, transcript: Transcript, normalize: bool) -> dict:
    raw = transcript.text
    # Always applied. A model that emits punctuation and capitalisation breaks
    # the grammars outright ("turn on the lights." does not parse), and both the
    # 0.1.0 server and Google returned bare lowercase text. See normalize.py.
    text = to_asr_text(raw)
    if normalize:
        text = normalize_text(text)
    body = transcript.as_payload()
    body["text"] = text
    body["text_raw"] = raw
    # `transcript` keeps the shape both existing clients already parse; the
    # top-level copies are for anything new, which should not have to reach
    # into a hypothesis dump.
    return {
        "filename": filename,
        "transcript": body,
        "text": text,
        "confidence": transcript.confidence,
        "api_version": API_VERSION,
    }


@app.get("/healthz")
async def healthz() -> dict:
    """Readiness without loading the model, so an orchestrator can poll cheaply."""
    scheduler = getattr(app.state, "inference", None)
    return {"ok": True, "api_version": API_VERSION, "sample_rate": SAMPLE_RATE,
            "concurrency": scheduler.stats() if scheduler else None}


@app.post("/transcribe")
async def transcribe_audio(
    file: UploadFile = File(...),
    normalize: bool = Query(
        default=False,
        description=(
            "Rewrite spoken numbers as digits. Default off: the original Jibo "
            "grammars accept both forms and resolve them to the same slots "
            "(verified against jibo-nlu 2.8.3), so normalising by default would "
            "change text for no parity gain."
        ),
    ),
) -> dict:
    # The original rejected anything but .wav; keep that so a client that
    # depends on the 400 still gets it.
    if not (file.filename or "").endswith(".wav"):
        raise HTTPException(status_code=400, detail="Only .wav files are supported.")

    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="ASR WAV upload is too large")
    try:
        transcript = await get_scheduler().submit(AudioInput(data))
    except ServiceBusy as error:
        raise HTTPException(status_code=503, detail=str(error), headers={"Retry-After": "1"})
    except Exception as error:                         # ffmpeg / decode failure
        raise HTTPException(status_code=500, detail=str(error))
    return _payload(file.filename or "audio.wav", transcript, normalize)


@app.websocket("/stream")
async def stream(ws: WebSocket) -> None:
    """Streaming recognition: interim transcripts while audio is still arriving.

    Protocol, all JSON except the audio itself:

        client -> {"type":"start", "sampleRate":16000, "normalize":false}
        client -> <binary PCM16LE frames>
        client -> {"type":"eos"}
        server -> {"type":"interim","text":...,"confidence":...}   (repeatedly)
        server -> {"type":"final","text":...,"confidence":...}

    Interim results still decode the buffer so far for model compatibility.
    While a decode is in flight we continue receiving audio, coalesce pending
    interim work into the latest buffer, and prioritize the final at EOS.
    """
    await ws.accept()
    try:
        scheduler = get_scheduler()
        scheduler.acquire_stream()
    except ServiceBusy:
        await ws.close(code=1013)
        return
    normalize = False
    sample_rate = SAMPLE_RATE
    buffer = bytearray()
    pending = 0
    interim_bytes = int(sample_rate * 2 * INTERIM_MS / 1000)
    last_text = None
    interim_task: Optional[asyncio.Task] = None
    ending = False
    generation = 0

    def start_interim(chunk_voiced: bool) -> None:
        nonlocal pending, interim_task
        if ending or interim_task is not None or not chunk_voiced or pending < interim_bytes:
            return
        snapshot = bytes(buffer)
        snapshot_rate = sample_rate
        snapshot_generation = generation
        pending = 0
        interim_task = asyncio.create_task(emit_interim(snapshot, snapshot_rate, snapshot_generation))

    async def emit_interim(snapshot: bytes, snapshot_rate: int, snapshot_generation: int) -> None:
        nonlocal interim_task, last_text, ending
        try:
            transcript = await scheduler.submit(AudioInput(snapshot, snapshot_rate), final=False)
            if not ending and snapshot_generation == generation and transcript.text and transcript.text != last_text:
                last_text = transcript.text
                await ws.send_text(json.dumps({
                    "type": "interim",
                    **_payload("stream", transcript, normalize),
                }))
        except ServiceBusy:
            # Under pressure, skip a partial hypothesis and preserve capacity
            # for final transcripts. The next voiced window can try again.
            pass
        except Exception:
            # The gateway retains PCM and falls back to POST /transcribe when
            # this socket fails; a broken inference must not leave it waiting.
            if not ending:
                ending = True
                await ws.close(code=1011)
        finally:
            interim_task = None
            # Do not immediately decode a backlog that arrived during this
            # inference: its newest packets (possibly EOS) have not necessarily
            # been consumed yet. The next audio packet can start a fresh interim.

    async def cancel_interim() -> None:
        if interim_task is not None:
            interim_task.cancel()
            await asyncio.gather(interim_task, return_exceptions=True)

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                return

            if message.get("bytes") is not None:
                chunk = message["bytes"]
                if len(buffer) + len(chunk) > sample_rate * 2 * MAX_AUDIO_SECONDS:
                    await ws.close(code=1009)
                    return
                buffer.extend(chunk)
                pending += len(chunk)
                # Like the original gate, a silence packet cannot start a new
                # inference even if earlier speech left enough buffered bytes.
                start_interim(rms(chunk) >= SILENCE_RMS)
                continue

            text = message.get("text")
            if not text:
                continue
            try:
                control = json.loads(text)
            except ValueError:
                continue

            if not isinstance(control, dict):
                continue
            kind = control.get("type")
            if kind == "start":
                await cancel_interim()
                generation += 1
                try:
                    sample_rate = int(control.get("sampleRate") or SAMPLE_RATE)
                    if not 1 <= sample_rate <= 48000:
                        raise ValueError("Invalid sample rate")
                except (ValueError, TypeError):
                    await ws.close(code=1008)
                    return
                normalize = bool(control.get("normalize", False))
                interim_bytes = int(sample_rate * 2 * INTERIM_MS / 1000)
                buffer = bytearray()
                pending = 0
                last_text = None
            elif kind == "eos":
                ending = True
                # Remove stale queued work immediately. A running GPU batch
                # finishes safely, then the final outranks all queued interims.
                await cancel_interim()
                transcript = (await scheduler.submit(AudioInput(bytes(buffer), sample_rate))
                              if buffer else Transcript(text=""))
                await ws.send_text(json.dumps({
                    "type": "final",
                    **_payload("stream", transcript, normalize),
                }))
                await ws.close()
                return
    except WebSocketDisconnect:
        return
    except ServiceBusy:
        await ws.close(code=1013)
    except Exception:
        await ws.close(code=1011)
    finally:
        ending = True
        try:
            await cancel_interim()
        finally:
            # ASGI shutdown/test clients may cancel the handler during the
            # await above. Admission accounting must still release its slot.
            scheduler.release_stream()
