"""Laya adapter with a deterministic test double and explicit unknown gating."""

from __future__ import annotations

import importlib
import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .profiles import Profile


@dataclass(frozen=True)
class Classification:
    intent: str | None
    confidence: float
    probabilities: dict[str, float]
    unknown: bool
    reason: str


class StubClassifier:
    """Contract-test classifier. Production never selects this backend by default."""

    def __init__(self, intent: str | None = None, confidence: float = 0.99, intents: dict[str, str] | None = None):
        self.intent = intent
        self.intents = intents or {}
        self.confidence = confidence
        self.ready = True
        self.device = "stub"

    def load(self) -> None:
        return None

    def classify(self, text: str, profile: Profile) -> Classification:
        del text
        selected = self.intents.get(profile.name, self.intent)
        intent = selected if selected in profile.criteria else None
        unknown = intent is None
        probabilities = {candidate.id: 0.0 for candidate in profile.candidates}
        probabilities[intent or "unknown"] = self.confidence
        return Classification(
            intent=intent,
            confidence=self.confidence if not unknown else 1.0,
            probabilities=probabilities,
            unknown=unknown,
            reason="stub",
        )


class LayaClassifier:
    """Loads exactly one operator-selected Laya checkpoint at startup."""

    def __init__(
        self,
        model_repo: str,
        model_subfolder: str | None,
        device: str,
        require_cuda: bool,
        loader: Callable[..., Any] | None = None,
    ):
        self.model_repo = model_repo
        self.model_subfolder = model_subfolder or None
        self.device_name = device
        self.require_cuda = require_cuda
        self._loader = loader
        self.router: Any = None
        self.ready = False
        self.device = None

    def load(self) -> None:
        self._verify_local_model_manifest()
        laya = None if self._loader is not None else importlib.import_module("laya")
        if self.require_cuda:
            torch = importlib.import_module("torch")
            if not bool(torch.cuda.is_available()):
                raise RuntimeError("CUDA is required but no CUDA device is available")
        # `Router` is Laya's supported public API.  It is deliberately pinned
        # to one English checkpoint; automatic language/task routing would make
        # capacity and model selection depend on untrusted utterance content.
        router_factory = self._loader or laya.Router
        model_spec: Any = (self.model_repo, self.model_subfolder) if self.model_subfolder else self.model_repo
        self.router = router_factory(
            models={"english": model_spec},
            device=self.device_name,
            default="english",
            max_loaded=1,
            auto_task_detection=False,
        )
        self.router.preload(["english"])
        agent = self.router.load("english")
        actual_device = str(getattr(getattr(agent, "device", None), "type", ""))
        self.device = actual_device or self.device_name
        if self.require_cuda and actual_device != "cuda":
            raise RuntimeError("Laya loaded without CUDA even though CUDA is required")
        self.ready = True

    def _verify_local_model_manifest(self) -> None:
        """Require the bootstrap job's pinned file manifest before model load."""
        if self._loader is not None:
            return
        root = Path(self.model_repo)
        manifest_path = root / "phoenix-model-manifest.json"
        try:
            document = json.loads(manifest_path.read_text(encoding="utf-8"))
            files = document["files"]
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RuntimeError("missing or invalid pinned Laya model manifest") from error
        if document.get("schema") != "phoenix.laya.model-manifest.v1" or not isinstance(files, dict) or not files:
            raise RuntimeError("invalid pinned Laya model manifest")
        for required in ("rl_agent_config.json", "model.safetensors"):
            if required not in files:
                raise RuntimeError("pinned Laya model manifest is incomplete")
        root_resolved = root.resolve()
        for relative, expected_hash in files.items():
            if not isinstance(relative, str) or not isinstance(expected_hash, str) or len(expected_hash) != 64:
                raise RuntimeError("invalid pinned Laya model manifest entry")
            path = (root / relative).resolve()
            if root_resolved not in path.parents or path.is_symlink() or not path.is_file():
                raise RuntimeError("pinned Laya model manifest contains an unsafe path")
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            digest = digest.hexdigest()
            if not hmac.compare_digest(digest, expected_hash):
                raise RuntimeError("pinned Laya model file hash mismatch")

    def classify(self, text: str, profile: Profile) -> Classification:
        if not self.ready or self.router is None:
            raise RuntimeError("Laya model is not ready")
        # This is the only state and question shape sent to Laya.  The request
        # cannot provide instructions, criteria, model names, or extra fields.
        questions = {
            "intent": {
                "type": "choice",
                "instructions": profile.instructions,
                "criteria": profile.criteria,
            },
        }
        result = self.router.predict(text, questions, model="english")
        answer = result.get("answers", {}).get("intent", {})
        choice = answer.get("choice")
        probabilities = answer.get("probabilities")
        if not isinstance(choice, str) or not isinstance(probabilities, dict):
            raise RuntimeError("Laya returned an invalid choice result")
        clean_probabilities: dict[str, float] = {}
        for candidate in profile.candidates:
            value = probabilities.get(candidate.id, 0.0)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise RuntimeError("Laya returned an invalid probability")
            clean_probabilities[candidate.id] = max(0.0, min(1.0, float(value)))
        if choice not in clean_probabilities:
            raise RuntimeError("Laya returned a choice outside the server profile")

        ordered = sorted(clean_probabilities.values(), reverse=True)
        top_probability = clean_probabilities[choice]
        margin = top_probability - (ordered[1] if len(ordered) > 1 else 0.0)
        # `confidence` from Laya is an entropy-derived score.  Keep it in the
        # response for diagnostics, but gate on the actual top probability and
        # margin so the unknown path is explicit and reproducible.
        model_confidence = answer.get("confidence", top_probability)
        if isinstance(model_confidence, bool) or not isinstance(model_confidence, (int, float)):
            model_confidence = top_probability
        model_confidence = max(0.0, min(1.0, float(model_confidence)))
        if choice == "unknown":
            return Classification(None, model_confidence, clean_probabilities, True, "candidate")
        if top_probability < profile.min_confidence:
            return Classification(None, model_confidence, clean_probabilities, True, "low_confidence")
        if margin < profile.min_margin:
            return Classification(None, model_confidence, clean_probabilities, True, "ambiguous")
        return Classification(choice, model_confidence, clean_probabilities, False, "match")


def create_classifier() -> LayaClassifier | StubClassifier:
    backend = os.environ.get("LAYA_BACKEND", "laya").strip().lower()
    if backend == "stub":
        # Test-only, profile-keyed answers let the contract suite exercise a
        # multi-level tree without importing a model.  The production Compose
        # file fixes LAYA_BACKEND=laya, so this cannot enable a mock remotely.
        import json
        raw = os.environ.get("LAYA_STUB_INTENTS", "")
        try:
            intents = json.loads(raw) if raw else {}
        except json.JSONDecodeError as error:
            raise RuntimeError("LAYA_STUB_INTENTS must be a JSON object") from error
        if not isinstance(intents, dict) or not all(isinstance(key, str) and isinstance(value, str) for key, value in intents.items()):
            raise RuntimeError("LAYA_STUB_INTENTS must map profile names to intent strings")
        return StubClassifier(os.environ.get("LAYA_STUB_INTENT") or None, intents=intents)
    if backend != "laya":
        raise RuntimeError("LAYA_BACKEND must be 'laya' or 'stub'")
    return LayaClassifier(
        # Production loads an already-prepared local checkpoint.  A repository
        # ID here would let the serving process download model code/weights.
        model_repo=os.environ.get("LAYA_MODEL_PATH", "/models/laya"),
        model_subfolder=os.environ.get("LAYA_MODEL_SUBFOLDER") or None,
        device=os.environ.get("LAYA_DEVICE", "cuda"),
        require_cuda=os.environ.get("LAYA_REQUIRE_CUDA", "true").strip().lower() == "true",
    )
