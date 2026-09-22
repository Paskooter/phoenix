"""Fetch a pinned Laya checkpoint into an operator-owned persistent volume.

This runs only from the explicit Compose ``bootstrap`` profile. The serving
container mounts the result read-only and keeps Hugging Face offline.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
from pathlib import Path

from huggingface_hub import snapshot_download


MODEL_REPO = os.environ.get("LAYA_MODEL_REPO", "convaiinnovations/laya")
MODEL_REVISION = os.environ.get("LAYA_MODEL_REVISION", "1c5edc17a7acd8701df6fc341c0d179f1c62c982")
MODEL_PATH = Path(os.environ.get("LAYA_MODEL_PATH", "/models/laya"))
# Match Laya 0.3.5's own restricted snapshot, plus the conventional optional
# top-level Transformers config when a compatible checkpoint supplies one.
ALLOW_PATTERNS = ["rl_agent_config.json", "model.safetensors", "config.json", "tokenizer/*", "encoder/*"]
REQUIRED_ROOT_FILES = ("rl_agent_config.json", "model.safetensors")
OPTIONAL_ROOT_FILES = ("config.json",)
# Laya loads tokenizer/ and encoder/ locally. Their absence makes the library
# fall back to a remote model ID, which cannot work in the offline service.
REQUIRED_NESTED_FILES = ("tokenizer/tokenizer.json", "tokenizer/tokenizer_config.json", "encoder/config.json")
MODEL_DIRECTORIES = ("tokenizer", "encoder")
MANIFEST_NAME = "phoenix-model-manifest.json"
STAGING_DIRECTORY = ".download"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def prepare_tokenizer_config(model_path: Path) -> None:
    """Apply Laya's documented tokenizer compatibility normalization once.

    The upstream runtime performs this defensively at model load.  Our serving
    volume is read-only, so make the same narrow, data-only normalization in
    the bootstrap job instead.
    """
    path = model_path / "tokenizer" / "tokenizer_config.json"
    if path.is_symlink():
        raise RuntimeError(f"checkpoint contains an unsafe artifact: {path}")
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


def staging_path() -> Path:
    """Keep old Hub clients' permission probe inside the private model tree."""
    return MODEL_PATH / STAGING_DIRECTORY


def _artifact_files(root: Path) -> list[Path]:
    """Return only regular, non-symlink checkpoint files from allowed paths."""
    files: list[Path] = []
    for relative in (*REQUIRED_ROOT_FILES, *REQUIRED_NESTED_FILES):
        path = root / relative
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"checkpoint download is incomplete: {path}")
        files.append(path)
    for name in OPTIONAL_ROOT_FILES:
        path = root / name
        if path.is_symlink() or (path.exists() and not path.is_file()):
            raise RuntimeError(f"checkpoint contains an unsafe artifact: {path}")
        if path.is_file():
            files.append(path)
    for name in MODEL_DIRECTORIES:
        directory = root / name
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError(f"checkpoint contains an unsafe artifact: {directory}")
        for path in sorted(directory.rglob("*")):
            if path.is_symlink():
                raise RuntimeError(f"checkpoint contains an unsafe artifact: {path}")
            if path.is_file():
                if path not in files:
                    files.append(path)
            elif not path.is_dir():
                raise RuntimeError(f"checkpoint contains an unsafe artifact: {path}")
    return files


def write_manifest(root: Path) -> None:
    """Hash only files that the serving process is permitted to load."""
    files = {
        str(path.relative_to(root)): sha256(path)
        for path in _artifact_files(root)
    }
    (root / MANIFEST_NAME).write_text(json.dumps({
        "schema": "phoenix.laya.model-manifest.v1",
        "repo": MODEL_REPO,
        "revision": MODEL_REVISION,
        "files": files,
    }, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _remove_artifact(path: Path) -> None:
    """Remove a prior known artifact without following a link outside the volume."""
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        raise RuntimeError(f"model destination contains an unsafe artifact: {path}")


def promote_staged_checkpoint(staging: Path) -> None:
    """Move verified staged data into the immutable serving location.

    `snapshot_download(local_dir=MODEL_PATH)` causes pre-1.18 Hugging Face Hub
    releases to create a temporary permission-probe file at `/models`, where
    the unprivileged downloader cannot write. One directory deeper keeps that
    probe inside `MODEL_PATH`, which is deliberately private to this account.
    All promotion happens after the files have been validated, and still after
    the bootstrap process has dropped root privileges.
    """
    _artifact_files(staging)
    for name in (*REQUIRED_ROOT_FILES, *OPTIONAL_ROOT_FILES, *MODEL_DIRECTORIES, MANIFEST_NAME):
        source = staging / name
        if not source.exists():
            if name in REQUIRED_ROOT_FILES or name in MODEL_DIRECTORIES or name == MANIFEST_NAME:
                raise RuntimeError(f"checkpoint staging is incomplete: {source}")
            continue
        destination = MODEL_PATH / name
        if destination.exists() or destination.is_symlink():
            _remove_artifact(destination)
        os.replace(source, destination)
    # The local-dir cache is not executable model content, and the service is
    # permanently offline. Leave no downloader state in the serving directory.
    if staging.exists():
        shutil.rmtree(staging)


def main() -> None:
    if not MODEL_PATH.is_absolute():
        raise RuntimeError("LAYA_MODEL_PATH must be an absolute path")
    MODEL_PATH.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging = staging_path()
    snapshot_download(
        repo_id=MODEL_REPO,
        revision=MODEL_REVISION,
        local_dir=str(staging),
        allow_patterns=ALLOW_PATTERNS,
    )
    prepare_tokenizer_config(staging)
    write_manifest(staging)
    promote_staged_checkpoint(staging)


if __name__ == "__main__":
    main()
