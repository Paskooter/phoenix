import importlib
import json
import sys
import types

from app.classifier import LayaClassifier


def load_fetch_model(monkeypatch):
    """Import the downloader without installing the GPU-only dependencies."""
    hub = types.ModuleType("huggingface_hub")
    hub.snapshot_download = lambda **_kwargs: None
    monkeypatch.setitem(sys.modules, "huggingface_hub", hub)
    sys.modules.pop("app.fetch_model", None)
    return importlib.import_module("app.fetch_model")


def test_download_staging_keeps_legacy_hub_umask_probe_in_private_model_directory(tmp_path, monkeypatch):
    fetch_model = load_fetch_model(monkeypatch)
    model_path = tmp_path / "models" / "laya"
    monkeypatch.setattr(fetch_model, "MODEL_PATH", model_path)

    # Older huggingface_hub computes the probe as destination.parent.parent.
    # A staged top-level model file therefore probes MODEL_PATH, never /models.
    staged_file = fetch_model.staging_path() / "model.safetensors"
    assert staged_file.parent.parent == model_path


def test_staged_download_is_verified_manifested_and_promoted_without_cache(tmp_path, monkeypatch):
    fetch_model = load_fetch_model(monkeypatch)
    model_path = tmp_path / "models" / "laya"
    monkeypatch.setattr(fetch_model, "MODEL_PATH", model_path)
    calls = []

    def fake_snapshot_download(**kwargs):
        calls.append(kwargs)
        stage = model_path / ".download"
        (stage / "tokenizer").mkdir(parents=True)
        (stage / "encoder").mkdir(parents=True)
        (stage / ".cache" / "huggingface").mkdir(parents=True)
        (stage / "rl_agent_config.json").write_text("{}", encoding="utf-8")
        (stage / "model.safetensors").write_bytes(b"model")
        (stage / "config.json").write_text("{\"model_type\": \"modernbert\"}", encoding="utf-8")
        (stage / "encoder" / "config.json").write_text("{\"model_type\": \"modernbert\"}", encoding="utf-8")
        (stage / "tokenizer" / "tokenizer.json").write_text("{}", encoding="utf-8")
        (stage / "tokenizer" / "tokenizer_config.json").write_text(
            json.dumps({"tokenizer_class": "TokenizersBackend", "backend": "unused"}),
            encoding="utf-8",
        )
        (stage / ".cache" / "huggingface" / "download-state").write_text("cache", encoding="utf-8")

    monkeypatch.setattr(fetch_model, "snapshot_download", fake_snapshot_download)
    fetch_model.main()

    assert calls[0]["local_dir"] == str(model_path / ".download")
    assert (model_path / "rl_agent_config.json").read_text(encoding="utf-8") == "{}"
    assert (model_path / "model.safetensors").read_bytes() == b"model"
    assert (model_path / "config.json").is_file()
    assert (model_path / "encoder" / "config.json").is_file()
    assert not (model_path / ".download").exists()
    assert not (model_path / ".cache").exists()
    tokenizer = json.loads((model_path / "tokenizer" / "tokenizer_config.json").read_text(encoding="utf-8"))
    assert tokenizer["tokenizer_class"] == "PreTrainedTokenizerFast"
    assert "backend" not in tokenizer
    manifest = json.loads((model_path / "phoenix-model-manifest.json").read_text(encoding="utf-8"))
    assert set(manifest["files"]) == {
        "rl_agent_config.json",
        "model.safetensors",
        "config.json",
        "encoder/config.json",
        "tokenizer/tokenizer.json",
        "tokenizer/tokenizer_config.json",
    }
    # This is the same offline integrity check the read-only serving container
    # executes before it imports Laya or touches the GPU.
    LayaClassifier(str(model_path), None, "cuda", True)._verify_local_model_manifest()
