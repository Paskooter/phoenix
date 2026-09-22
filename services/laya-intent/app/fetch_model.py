"""Fetch a pinned Laya checkpoint into an operator-owned persistent volume.

This runs only from the explicit Compose ``bootstrap`` profile. The serving
container mounts the result read-only and keeps Hugging Face offline.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_REPO = os.environ.get("LAYA_MODEL_REPO", "convaiinnovations/laya")
MODEL_REVISION = os.environ.get("LAYA_MODEL_REVISION", "1c5edc17a7acd8701df6fc341c0d179f1c62c982")
MODEL_PATH = Path(os.environ.get("LAYA_MODEL_PATH", "/models/laya"))
ALLOW_PATTERNS = ["rl_agent_config.json", "model.safetensors", "tokenizer/*", "encoder/*"]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_tokenizer_config() -> None:
    """Apply Laya's documented tokenizer compatibility normalization once.

    The upstream runtime performs this defensively at model load.  Our serving
    volume is read-only, so make the same narrow, data-only normalization in
    the bootstrap job instead.
    """
    path = MODEL_PATH / "tokenizer" / "tokenizer_config.json"
    if not path.is_file():
        return
    config = json.loads(path.read_text(encoding="utf-8"))
    changed = False
    if config.get("tokenizer_class") in (None, "TokenizersBackend"):
        config["tokenizer_class"] = "PreTrainedTokenizerFast"
        config.pop("backend", None)
        config.pop("is_local", None)
        changed = True
    extra = config.get("extra_special_tokens")
    if isinstance(extra, list):
        config["extra_special_tokens"] = {f"extra_{index}": value for index, value in enumerate(extra)}
        changed = True
    if changed:
        path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    if not MODEL_PATH.is_absolute():
        raise RuntimeError("LAYA_MODEL_PATH must be an absolute path")
    MODEL_PATH.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot_download(
        repo_id=MODEL_REPO,
        revision=MODEL_REVISION,
        local_dir=str(MODEL_PATH),
        allow_patterns=ALLOW_PATTERNS,
    )
    required = [MODEL_PATH / "rl_agent_config.json", MODEL_PATH / "model.safetensors"]
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"checkpoint download is incomplete: {', '.join(missing)}")
    prepare_tokenizer_config()
    files = {
        str(path.relative_to(MODEL_PATH)): sha256(path)
        for path in sorted(MODEL_PATH.rglob("*")) if path.is_file() and path.name != "phoenix-model-manifest.json"
    }
    (MODEL_PATH / "phoenix-model-manifest.json").write_text(json.dumps({
        "schema": "phoenix.laya.model-manifest.v1",
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "files": files,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
