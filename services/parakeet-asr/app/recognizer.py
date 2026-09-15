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
    """NVIDIA NeMo Parakeet.

    Word confidence is OFF by default in NeMo; it has to be asked for through
    the decoding config. That is why the deployed 0.1.0 server returned
    ``frame_confidence``/``token_confidence``/``word_confidence`` all null and
    the client had nothing to report.
    """

    def __init__(self, model_name: Optional[str] = None, device: Optional[str] = None) -> None:
        self.model_name = model_name or os.environ.get(
            "PARAKEET_MODEL", "nvidia/parakeet-tdt-0.6b-v2")
        self.device = device or os.environ.get("PARAKEET_DEVICE", "cuda")
        self._model = None

    def _load(self):
        if self._model is not None:
            return self._model
        import nemo.collections.asr as nemo_asr  # imported lazily: heavy, GPU-bound
        model = nemo_asr.models.ASRModel.from_pretrained(model_name=self.model_name)
        model = model.to(self.device)
        model.eval()
        self._enable_confidence(model)
        self._model = model
        return model

    @staticmethod
    def _enable_confidence(model) -> None:
        """Ask the decoder for confidence. Without this every field comes back null."""
        try:
            from omegaconf import open_dict
            cfg = model.cfg.decoding
            with open_dict(cfg):
                cfg.preserve_alignments = True
                cfg.compute_timestamps = True
                confidence = cfg.get("confidence_cfg", {})
                confidence["preserve_frame_confidence"] = True
                confidence["preserve_token_confidence"] = True
                confidence["preserve_word_confidence"] = True
                cfg.confidence_cfg = confidence
            model.change_decoding_strategy(cfg)
        except Exception:  # pragma: no cover - depends on model/NeMo version
            # A model whose decoder cannot preserve confidence still transcribes;
            # it reports confidence None, which the wire contract allows.
            pass

    @staticmethod
    def _to_transcript(hyp) -> Transcript:
        text = getattr(hyp, "text", None)
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
        model = self._load()
        hyps = model.transcribe([path], return_hypotheses=True)
        if isinstance(hyps, tuple):  # some versions return (best, all)
            hyps = hyps[0]
        if not hyps:
            return Transcript(text="")
        return self._to_transcript(hyps[0])

    def transcribe_pcm(self, pcm: bytes, sample_rate: int) -> Transcript:
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
            with wave.open(tmp.name, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(sample_rate)
                w.writeframes(pcm)
            return self.transcribe_wav(tmp.name)


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
