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
import tempfile
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect

from .recognizer import Recognizer, Transcript, rms
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
API_VERSION = "0.1.0" if BACKEND == "faster-whisper" else "0.2.1"

_recognizer: Optional[Recognizer] = None
# NeMo's model is shared across connections. Keep inference serial (as it was
# on the old event-loop path), but run it off-loop so sockets can keep receiving
# audio while an interim is in flight. A bounded worker also avoids concurrent
# GPU calls and the associated VRAM spikes.
_inference_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="parakeet-infer")


async def _infer(method, *args) -> Transcript:
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_inference_executor, lambda: method(*args))


def set_recognizer(recognizer: Recognizer) -> None:
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
    yield


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
def healthz() -> dict:
    """Readiness without loading the model, so an orchestrator can poll cheaply."""
    return {"ok": True, "api_version": API_VERSION, "sample_rate": SAMPLE_RATE}


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

    data = await file.read()

    # Keep temp-file ownership inside the worker. If the HTTP client disconnects
    # and cancels this coroutine, a queued/running inference must not lose its
    # input file before the recognizer has finished opening it.
    def transcribe_upload() -> Transcript:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(data)
            path = tmp.name
        try:
            return get_recognizer().transcribe_wav(path)
        finally:
            if os.path.exists(path):
                os.remove(path)

    try:
        transcript = await _infer(transcribe_upload)
    except RuntimeError as error:                      # ffmpeg / decode failure
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
            transcript = await _infer(get_recognizer().transcribe_pcm, snapshot, snapshot_rate)
            if not ending and snapshot_generation == generation and transcript.text and transcript.text != last_text:
                last_text = transcript.text
                await ws.send_text(json.dumps({
                    "type": "interim",
                    **_payload("stream", transcript, normalize),
                }))
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

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                return

            if message.get("bytes") is not None:
                chunk = message["bytes"]
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

            kind = control.get("type")
            if kind == "start":
                generation += 1
                sample_rate = int(control.get("sampleRate") or SAMPLE_RATE)
                normalize = bool(control.get("normalize", False))
                interim_bytes = int(sample_rate * 2 * INTERIM_MS / 1000)
                buffer = bytearray()
                pending = 0
                last_text = None
            elif kind == "eos":
                ending = True
                # Let an in-flight interim finish, but skip any queued partial
                # buffers. Only the final full-buffer decode is useful now.
                if interim_task is not None:
                    await interim_task
                transcript = (await _infer(get_recognizer().transcribe_pcm, bytes(buffer), sample_rate)
                              if buffer else Transcript(text=""))
                await ws.send_text(json.dumps({
                    "type": "final",
                    **_payload("stream", transcript, normalize),
                }))
                return
    except WebSocketDisconnect:
        ending = True
        if interim_task is not None:
            interim_task.cancel()
        return
