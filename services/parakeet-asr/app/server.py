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

import json
import os
import tempfile
from typing import Optional

from fastapi import FastAPI, File, Query, UploadFile, WebSocket, WebSocketDisconnect

from .recognizer import Recognizer, Transcript, rms
from .normalize import normalize_text

SAMPLE_RATE = int(os.environ.get("PARAKEET_SAMPLE_RATE", "16000"))
# How much new audio to accumulate before re-decoding during streaming. The hub
# applies earlyEOS to whatever interim text it has, so this is the granularity
# at which a trigger word can cut an utterance short.
INTERIM_MS = int(os.environ.get("PARAKEET_INTERIM_MS", "300"))
# Below this RMS a chunk is silence and not worth a decode pass.
SILENCE_RMS = float(os.environ.get("PARAKEET_SILENCE_RMS", "200"))

API_VERSION = "0.2.0"

_recognizer: Optional[Recognizer] = None


def set_recognizer(recognizer: Recognizer) -> None:
    """Inject a recognizer. Tests use this; production leaves it unset."""
    global _recognizer
    _recognizer = recognizer


def get_recognizer() -> Recognizer:
    global _recognizer
    if _recognizer is None:
        from .recognizer import NemoRecognizer
        _recognizer = NemoRecognizer()
    return _recognizer


app = FastAPI(title="Parakeet ASR REST API", version=API_VERSION)


def _payload(filename: str, transcript: Transcript, normalize: bool) -> dict:
    raw = transcript.text
    text = normalize_text(raw) if normalize else raw
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
    data = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(data)
        tmp.flush()
        transcript = get_recognizer().transcribe_wav(tmp.name)
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

    Interim results are produced by re-decoding the buffer so far. That is more
    work than a cache-aware streaming model would do, but it is model-agnostic
    and a robot turn is a few seconds; correctness of the earlyEOS signal
    matters more here than decoder efficiency.
    """
    await ws.accept()
    normalize = False
    sample_rate = SAMPLE_RATE
    buffer = bytearray()
    pending = 0
    interim_bytes = int(sample_rate * 2 * INTERIM_MS / 1000)
    last_text = None

    try:
        while True:
            message = await ws.receive()
            if message.get("type") == "websocket.disconnect":
                return

            if message.get("bytes") is not None:
                chunk = message["bytes"]
                buffer.extend(chunk)
                pending += len(chunk)
                if pending >= interim_bytes and rms(chunk) >= SILENCE_RMS:
                    pending = 0
                    transcript = get_recognizer().transcribe_pcm(bytes(buffer), sample_rate)
                    # Only speak up when the hypothesis actually changed: the hub
                    # matches earlyEOS against each interim, and repeats would
                    # make a trigger appear to fire more than once.
                    if transcript.text and transcript.text != last_text:
                        last_text = transcript.text
                        await ws.send_text(json.dumps({
                            "type": "interim",
                            **_payload("stream", transcript, normalize),
                        }))
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
                sample_rate = int(control.get("sampleRate") or SAMPLE_RATE)
                normalize = bool(control.get("normalize", False))
                interim_bytes = int(sample_rate * 2 * INTERIM_MS / 1000)
                buffer = bytearray()
                pending = 0
                last_text = None
            elif kind == "eos":
                transcript = (get_recognizer().transcribe_pcm(bytes(buffer), sample_rate)
                              if buffer else Transcript(text=""))
                await ws.send_text(json.dumps({
                    "type": "final",
                    **_payload("stream", transcript, normalize),
                }))
                return
    except WebSocketDisconnect:
        return
