import os
import stat
from pathlib import Path

import pytest

from app import bootstrap_model


def test_bootstrap_accepts_only_the_compose_pinned_model_path(monkeypatch):
    monkeypatch.delenv("LAYA_MODEL_PATH", raising=False)
    assert bootstrap_model.configured_model_path() == bootstrap_model.MODEL_PATH

    monkeypatch.setenv("LAYA_MODEL_PATH", "/tmp/other-model")
    with pytest.raises(RuntimeError, match="/models/laya"):
        bootstrap_model.configured_model_path()


def test_prepare_model_directory_sets_private_service_ownership(tmp_path, monkeypatch):
    model_root = tmp_path / "models"
    model_root.mkdir()
    model_path = model_root / "laya"
    operations = []
    real_chmod = os.chmod
    monkeypatch.setattr(bootstrap_model, "MODEL_ROOT", model_root)
    monkeypatch.setattr(bootstrap_model, "MODEL_PATH", model_path)
    monkeypatch.setattr(
        os,
        "chmod",
        lambda path, mode: (operations.append(("chmod", path, mode)), real_chmod(path, mode)),
    )
    monkeypatch.setattr(os, "chown", lambda path, uid, gid: operations.append(("chown", path, uid, gid)))
    real_lstat = Path.lstat
    class RootOwnedInfo:
        st_mode = stat.S_IFDIR | 0o700
        st_uid = 0
        st_gid = 0
    monkeypatch.setattr(Path, "lstat", lambda self: RootOwnedInfo() if self == model_path else real_lstat(self))

    bootstrap_model.prepare_model_directory(model_path, uid=10001, gid=10001)

    assert model_path.is_dir()
    assert operations == [
        ("chmod", model_path, 0o700),
        ("chown", model_path, 10001, 10001),
    ]
    assert model_path.stat().st_mode & 0o777 == 0o700


def test_prepare_model_directory_rejects_symlinks(tmp_path, monkeypatch):
    model_root = tmp_path / "models"
    model_root.mkdir()
    model_path = model_root / "laya"
    model_path.symlink_to(tmp_path)
    monkeypatch.setattr(bootstrap_model, "MODEL_ROOT", model_root)
    monkeypatch.setattr(bootstrap_model, "MODEL_PATH", model_path)

    with pytest.raises(RuntimeError, match="must not be a symlink"):
        bootstrap_model.prepare_model_directory(model_path, uid=10001, gid=10001)


def test_prepare_model_directory_is_a_safe_noop_after_an_interrupted_bootstrap(tmp_path, monkeypatch):
    model_root = tmp_path / "models"
    model_root.mkdir()
    model_path = model_root / "laya"
    model_path.mkdir(mode=0o700)
    monkeypatch.setattr(bootstrap_model, "MODEL_ROOT", model_root)
    monkeypatch.setattr(bootstrap_model, "MODEL_PATH", model_path)
    monkeypatch.setattr(os, "chown", lambda *_args: pytest.fail("a ready directory must not be chowned again"))
    monkeypatch.setattr(os, "chmod", lambda *_args: pytest.fail("a ready directory must not be chmodded again"))

    # The test process cannot chown to the service uid; model the lstat result
    # that a retry sees after the first bootstrap completed ownership handoff.
    real_lstat = Path.lstat
    actual = real_lstat(model_path)
    class ReadyInfo:
        st_mode = actual.st_mode
        st_uid = 10001
        st_gid = 10001
    monkeypatch.setattr(Path, "lstat", lambda self: ReadyInfo() if self == model_path else real_lstat(self))

    bootstrap_model.prepare_model_directory(model_path, uid=10001, gid=10001)


def test_drop_privileges_clears_supplementary_groups(monkeypatch):
    calls = []
    state = {"uid": 0, "gid": 0, "groups": [0]}
    monkeypatch.setattr(os, "setgroups", lambda groups: (calls.append(("groups", groups)), state.update(groups=groups)))
    monkeypatch.setattr(os, "setgid", lambda gid: (calls.append(("gid", gid)), state.update(gid=gid)))
    monkeypatch.setattr(os, "setuid", lambda uid: (calls.append(("uid", uid)), state.update(uid=uid)))
    monkeypatch.setattr(os, "geteuid", lambda: state["uid"])
    monkeypatch.setattr(os, "getegid", lambda: state["gid"])
    monkeypatch.setattr(os, "getgroups", lambda: state["groups"])

    bootstrap_model.drop_privileges(uid=10001, gid=10001)

    assert calls == [("groups", []), ("gid", 10001), ("uid", 10001)]
