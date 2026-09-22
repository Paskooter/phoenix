"""Recognizer behind a narrow interface, so the server is testable without a GPU.

The NeMo model is loaded lazily and only by ``NemoRecognizer``. Everything the
HTTP and WebSocket layers do is exercised in tests against ``StubRecognizer``,
which is the only way this service can be verified anywhere but the machine
holding the model.
"""
from __future__ import annotations

import math
import os
import wave
from dataclasses import dataclass, field
from typing import List, Optional, Protocol


@dataclass
class Transcript:
    """One hypothesis.

    ``confidence`` is None when the model did not supply one. It is never
    fabricated: the previous server reported a constant 1.0, which reached the
    robot looking like a real measurement (see Phoenix DIVERGENCES H07c).
    """

    text: str
    score: Optional[float] = None
    confidence: Optional[float] = None
    word_confidence: List[float] = field(default_factory=list)

    def as_payload(self) -> dict:
        return {
            "text": self.text,
            "score": self.score,
            "confidence": self.confidence,
            "word_confidence": list(self.word_confidence),
        }


class Recognizer(Protocol):
    def transcribe_wav(self, path: str) -> Transcript: ...
    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> Transcript: ...


def mean_confidence(values: List[float]) -> Optional[float]:
    """Utterance confidence as the mean of per-word confidences.

    NeMo reports confidence per word; the wire contract carries one number for
    the utterance, which is what the original Google provider supplied
    (``result.alternatives[0].confidence``). An empty list yields None rather
    than a default, so "no confidence available" stays distinguishable from
    "confidently zero".
    """
    if not values:
        return None
    return max(0.0, min(1.0, sum(values) / len(values)))


class StubRecognizer:
    """Deterministic recognizer for tests. Returns whatever it was primed with."""

    def __init__(self, text: str = "", confidence: Optional[float] = None,
                 word_confidence: Optional[List[float]] = None) -> None:
        self.text = text
        self.confidence = confidence
        self.word_confidence = word_confidence or []
        self.calls = 0

    def _result(self, nsamples: int) -> Transcript:
        self.calls += 1
        conf = self.confidence
        if conf is None:
            conf = mean_confidence(self.word_confidence)
        return Transcript(
            text=self.text,
            score=float(nsamples),
            confidence=conf,
            word_confidence=self.word_confidence,
        )

    def transcribe_wav(self, path: str) -> Transcript:
        with wave.open(path, "rb") as w:
            return self._result(w.getnframes())

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> Transcript:
        return self._result(len(pcm) // 2)


class NemoRecognizer:
    """NVIDIA NeMo Parakeet, modelled on the original hive_mind parakeet-service.

    Three things are inherited from that service deliberately, because changing
    any of them changes what the robot hears:

    * **Model.** ``nvidia/parakeet-rnnt-0.6b``. This is not interchangeable with
      the newer ``parakeet-tdt-0.6b-v2``: the TDT model emits punctuation and
      capitalisation, and punctuation stops the Jibo grammars dead
      ("turn on the lights." does not parse at all against jibo-nlu 2.8.3).
      The RNNT model returns the bare lowercase text the grammars expect.
    * **Resident in VRAM.** Loaded once at startup, not per request.
    * **ffmpeg resampling.** Any sample rate, channel count or bit depth is
      accepted and converted to 16 kHz mono s16 before inference. Canonical
      16 kHz mono s16 PCM from the gateway skips this redundant conversion.

    What is added: word confidence, which NeMo does not preserve unless the
    decoding config asks for it.
    """

    DEFAULT_MODEL = "nvidia/parakeet-rnnt-0.6b"

    def __init__(self, model_name: Optional[str] = None, device: Optional[str] = None) -> None:
        self.model_name = model_name or os.environ.get("PARAKEET_MODEL", self.DEFAULT_MODEL)
        self.device = device or os.environ.get("PARAKEET_DEVICE", "")
        self._model = None

    def load(self):
        """Load the model. Called at startup so the first request is not slow."""
        if self._model is not None:
            return self._model
        # The production image is GPU-only. A missing WSL/Docker device or a
        # CPU-only Torch wheel must fail readiness instead of silently turning
        # every streaming interim into seconds of CPU inference.
        if os.environ.get("PARAKEET_REQUIRE_CUDA", "false").strip().lower() == "true":
            import torch
            if not torch.cuda.is_available():
                raise RuntimeError(
                    "Parakeet CUDA is required but unavailable; check Docker GPU access "
                    "and the installed PyTorch CUDA build"
                )
        import nemo.collections.asr as nemo_asr  # heavy, GPU-bound; imported lazily
        model = nemo_asr.models.ASRModel.from_pretrained(model_name=self.model_name)
        if self.device:
            model = model.to(self.device)
        model.eval()
        self._enable_confidence(model)
        self._model = model
        return model

    # Kept for callers that reach a request before startup finished.
    _load = load

    @staticmethod
    def _enable_confidence(model) -> None:
        """Ask the decoder for word confidence; without this every field is null."""
        try:
            from omegaconf import open_dict
            cfg = model.cfg.decoding
            with open_dict(cfg):
                confidence = dict(cfg.get("confidence_cfg", {}) or {})
                confidence["preserve_frame_confidence"] = True
                confidence["preserve_token_confidence"] = True
                confidence["preserve_word_confidence"] = True
                confidence["exclude_blank"] = True
                confidence["aggregation"] = "mean"
                # NeMo defaults to an ENTROPY measure, which is not a
                # probability: a correct transcript came back at 0.07 with
                # per-word values near 0.002. `max_prob` is the max softmax
                # probability per token, the 0-1 quantity the wire contract
                # means and the one Google supplied.
                method = dict(confidence.get("method_cfg", {}) or {})
                method["name"] = "max_prob"
                confidence["method_cfg"] = method
                cfg.confidence_cfg = confidence
            model.change_decoding_strategy(cfg)
        except Exception:  # pragma: no cover - depends on model/NeMo version
            # A decoder that cannot preserve confidence still transcribes; it
            # reports confidence None, which the wire contract allows.
            pass

    @staticmethod
    def resample(path: str) -> str:
        """16 kHz mono s16 via ffmpeg, as the original service did.

        Clients may send whatever the robot captured; the model needs one
        format. Returns a NEW path; the caller cleans it up.
        """
        import subprocess
        out = path[:-4] + "_16k.wav" if path.endswith(".wav") else path + "_16k.wav"
        cmd = ["ffmpeg", "-y", "-i", path, "-ar", "16000", "-ac", "1",
               "-sample_fmt", "s16", out]
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        if result.returncode != 0:
            if os.path.exists(out):
                os.remove(out)
            raise RuntimeError(f"ffmpeg resampling failed: {result.stderr.decode()[:500]}")
        return out

    @staticmethod
    def _to_transcript(hyp) -> Transcript:
        text = getattr(hyp, "text", None)
        # Some NeMo versions nest a hypothesis inside `.text`, which is why both
        # existing clients defensively read `transcript.text`.
        if text is not None and not isinstance(text, str):
            text = getattr(text, "text", None) or str(text)
        if text is None:
            text = str(hyp)
        words = list(getattr(hyp, "word_confidence", None) or [])
        return Transcript(
            text=text or "",
            score=float(getattr(hyp, "score", 0.0) or 0.0),
            confidence=mean_confidence(words),
            word_confidence=words,
        )

    def transcribe_wav(self, path: str) -> Transcript:
        model = self.load()
        resampled = None
        try:
            # Streaming PCM is already 16 kHz mono s16. The old unconditional
            # ffmpeg pass started a subprocess and rewrote every interim WAV.
            # Unknown/non-canonical WAVs still take the original conversion.
            try:
                with wave.open(path, "rb") as audio:
                    canonical = (audio.getnchannels() == 1
                                 and audio.getsampwidth() == 2
                                 and audio.getframerate() == 16000
                                 and audio.getcomptype() == "NONE")
            except (OSError, wave.Error, EOFError):
                canonical = False
            if not canonical:
                resampled = self.resample(path)
            hyps = model.transcribe([resampled or path], return_hypotheses=True)
            if isinstance(hyps, tuple):  # some versions return (best, all)
                hyps = hyps[0]
            if not hyps:
                return Transcript(text="")
            return self._to_transcript(hyps[0])
        finally:
            if resampled and os.path.exists(resampled):
                os.remove(resampled)

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> Transcript:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = tmp.name
        try:
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(pcm)
            return self.transcribe_wav(path)
        finally:
            if os.path.exists(path):
                os.remove(path)


class FasterWhisperRecognizer:
    """CPU-safe compatibility recognizer for hosts without a CUDA-capable GPU.

    The Hub only needs the stable ``/transcribe`` response shape.  This backend
    deliberately reports no invented confidence and is advertised as API 0.1
    by the HTTP layer, causing the Hub to use its established batch fallback
    rather than repeatedly decoding a growing buffer on a small CPU host.
    """

    DEFAULT_MODEL = "base.en"

    def __init__(self, model_name: Optional[str] = None) -> None:
        self.model_name = model_name or os.environ.get("PARAKEET_CPU_MODEL", self.DEFAULT_MODEL)
        self.cpu_threads = int(os.environ.get("PARAKEET_CPU_THREADS", "2"))
        self._model = None

    def load(self):
        if self._model is not None:
            return self._model
        from faster_whisper import WhisperModel
        self._model = WhisperModel(
            self.model_name,
            device="cpu",
            compute_type="int8",
            cpu_threads=self.cpu_threads,
            num_workers=1,
        )
        return self._model

    def transcribe_wav(self, path: str) -> Transcript:
        segments, _info = self.load().transcribe(
            path,
            language="en",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        # `segments` is lazy: consume it while the model is retained, but do
        # not convert its score into a fake probability.  The Hub's historical
        # fallback for a provider without confidence remains authoritative.
        return Transcript(text=" ".join(segment.text.strip() for segment in segments).strip())

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> Transcript:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            path = tmp.name
        try:
            with wave.open(path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(pcm)
            return self.transcribe_wav(path)
        finally:
            if os.path.exists(path):
                os.remove(path)


def rms(pcm: bytes) -> float:
    """Frame energy, used to avoid decoding pure silence during streaming."""
    if len(pcm) < 2:
        return 0.0
    total = 0
    count = len(pcm) // 2
    for i in range(0, count * 2, 2):
        sample = int.from_bytes(pcm[i:i + 2], "little", signed=True)
        total += sample * sample
    return math.sqrt(total / count)
