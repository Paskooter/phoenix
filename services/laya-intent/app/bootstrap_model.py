"""Prepare the model volume, then fetch the checkpoint as an unprivileged user.

Docker initializes a named volume as ``root:root``.  The normal Laya process
must not run as root, but its explicit bootstrap job has to create the first
directory in that volume.  This module performs only that narrow setup while
root, then permanently switches to the same uid/gid as the serving process
before importing or running the downloader.
"""

from __future__ import annotations

import os
import pwd
import stat
from pathlib import Path


MODEL_ROOT = Path("/models")
MODEL_PATH = MODEL_ROOT / "laya"
SERVICE_USER = "phoenix"


def configured_model_path() -> Path:
    """Accept only the Compose-pinned checkpoint path while privileged."""
    configured = Path(os.environ.get("LAYA_MODEL_PATH", str(MODEL_PATH)))
    if configured != MODEL_PATH:
        raise RuntimeError("LAYA_MODEL_PATH must be /models/laya for the bootstrap job")
    return configured


def prepare_model_directory(path: Path, *, uid: int, gid: int) -> None:
    """Create the sole writable checkpoint directory with private ownership."""
    if path != MODEL_PATH:
        raise RuntimeError("bootstrap may prepare only /models/laya")
    if MODEL_ROOT.is_symlink() or not MODEL_ROOT.is_dir():
        raise RuntimeError("the /models volume is missing or unsafe")
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise RuntimeError("the Laya model directory must not be a symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("the Laya model path exists but is not a directory")

    mode = stat.S_IMODE(info.st_mode)
    # A retry after the first setup may find an already-private directory
    # owned by phoenix.  The bootstrap container intentionally has no
    # CAP_FOWNER, so touching that directory would fail even though there is
    # nothing to repair.  Leave that secure, idempotent state alone.
    if info.st_uid == uid and info.st_gid == gid and mode == 0o700:
        return

    # A new named volume makes this directory root-owned.  That is the only
    # mutable ownership state this narrowly-capable setup job repairs.  If an
    # operator supplied a different non-root owner or mode, fail closed rather
    # than adding CAP_FOWNER/DAC_OVERRIDE just to override it.
    if info.st_uid != 0:
        raise RuntimeError("the Laya model directory must be private to phoenix or root-owned for bootstrap")
    # Enforce the service account's private directory on both fresh volumes
    # and a retry before ownership was handed off. File writes themselves occur
    # only after privileges have been dropped below.
    os.chmod(path, 0o700)
    # CHOWN is intentionally last: this bootstrap container retains CAP_CHOWN
    # but not CAP_FOWNER, so it can no longer change the mode after handing
    # ownership to the unprivileged service account.
    os.chown(path, uid, gid)


def drop_privileges(*, uid: int, gid: int) -> None:
    """Irreversibly drop root and all supplementary groups before download."""
    os.setgroups([])
    os.setgid(gid)
    os.setuid(uid)
    if os.geteuid() != uid or os.getegid() != gid or os.getgroups():
        raise RuntimeError("failed to drop bootstrap privileges")


def main() -> None:
    if os.geteuid() != 0:
        raise RuntimeError("the bootstrap initializer must start as root")
    account = pwd.getpwnam(SERVICE_USER)
    path = configured_model_path()
    prepare_model_directory(path, uid=account.pw_uid, gid=account.pw_gid)
    drop_privileges(uid=account.pw_uid, gid=account.pw_gid)

    # Importing the downloader only after setuid ensures network-provided model
    # data and its supporting libraries never execute with volume-owner rights.
    from .fetch_model import main as fetch_model

    fetch_model()


if __name__ == "__main__":
    main()
