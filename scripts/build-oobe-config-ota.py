#!/usr/bin/env python3
"""Build the jibo.io setup-skill (oobe-config) OTA whose screens name jibo.io.

The stock setup skill tells a new owner to "Go to the Jibo app on your phone",
an app that no longer exists. This rebuilds the published oobe-config package
with those screens changed to text that names this server, using the same
patcher the repoint helper applies to a robot's installed skill
(scripts/robot-client/patch-oobe-setup-text.cjs).

The base is the published oobe-config OTA package. Its inner filesystem tar is
streamed member by member; only three files change (the artwork, the bundle
holding the error messages, and package.json's version). Every other member's
bytes, owner, mode and time are copied as they are.

    python3 scripts/build-oobe-config-ota.py \\
      --base /var/lib/phoenix/ota/packages/oobe-config-9.0.1-jibo-io.tar \\
      --out  /tmp/oobe-build --version 9.0.2

Publish the result under a new update ID in every filter ("", fcs, eau) with the
same exact os/services dependencies as the package it replaces (docs/RUNBOOK.md).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import subprocess
import tarfile
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PATCHER = REPO / "scripts" / "robot-client" / "patch-oobe-setup-text.cjs"
ART = "./assets/oobe/oobe.js"
BUNDLE = "./oobe-config.js"
PACKAGE = "./package.json"
SKILL_UID = 2000  # the robot's jibo-skill user and group


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path, name: str) -> str:
    digest = hashlib.new(name)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def run_patcher(function: str, text: str, suffix: str) -> dict:
    """Call the patcher module's patchArt/patchBundle, so the robot and the package agree."""
    program = (
        "const p = require(process.argv[1]); let input = '';"
        "process.stdin.setEncoding('utf8'); process.stdin.on('data', (c) => { input += c; });"
        "process.stdin.on('end', () => {"
        f"  const out = p.{function}(input, process.argv[2]);"
        "  process.stdout.write(JSON.stringify(typeof out === 'string' ? { source: out } : out));"
        "});"
    )
    result = subprocess.run(["node", "-e", program, str(PATCHER), suffix], input=text.encode("utf-8"),
                            capture_output=True, check=True)
    return json.loads(result.stdout)


def patcher_pins() -> tuple[str, str]:
    result = subprocess.run(["node", "-e", "const p = require(process.argv[1]);"
                             "console.log(p.ART_ORIGINAL_SHA256 + ' ' + p.ART_PATCHED_SHA256)", str(PATCHER)],
                            capture_output=True, check=True, text=True)
    original, patched = result.stdout.split()
    return original, patched


def transform(member: tarfile.TarInfo, data: bytes, suffix: str, version: str, pins: tuple[str, str],
              changed: dict) -> bytes:
    if member.name == ART:
        if sha256(data) != pins[0]:
            raise ValueError(f"{ART}: base artwork is not the reviewed stock file")
        out = run_patcher("patchArt", data.decode("utf-8"), suffix)["source"].encode("utf-8")
        if suffix == "jibo.io" and sha256(out) != pins[1]:
            raise ValueError(f"{ART}: patched artwork does not match the reviewed output")
        changed[ART] = sha256(out)
        return out
    if member.name == BUNDLE:
        result = run_patcher("patchBundle", data.decode("utf-8"), suffix)
        if result["count"] == 0:
            raise ValueError(f"{BUNDLE}: no app phrases found; the base is not the expected skill")
        changed[BUNDLE] = f"{result['count']} phrases"
        return result["source"].encode("utf-8")
    if member.name == PACKAGE:
        package = json.loads(data)
        if package.get("name") != "oobe-config":
            raise ValueError(f"{PACKAGE}: base is not the oobe-config skill")
        changed["from_version"] = package.get("version")
        package["version"] = version
        changed[PACKAGE] = version
        return (json.dumps(package, indent=2) + "\n").encode("utf-8")
    return data


def build(base: Path, output: Path, version: str, suffix: str) -> dict:
    pins = patcher_pins()
    changed: dict = {}
    with tempfile.TemporaryDirectory(prefix="oobe-config-ota-") as tmp:
        inner_path = Path(tmp) / "filesystem.tar.bz2"
        with tarfile.open(base, "r:") as outer:
            if [m.name for m in outer if m.isfile()] != ["./filesystem.tar.bz2"]:
                raise ValueError(f"{base}: not an official-shape OTA wrapper")
            stream = outer.extractfile("./filesystem.tar.bz2")
            with stream, tarfile.open(fileobj=stream, mode="r|bz2") as src, \
                    tarfile.open(inner_path, "w:bz2", format=tarfile.GNU_FORMAT) as dst:
                for member in src:
                    if member.uid != SKILL_UID or member.gid != SKILL_UID:
                        raise ValueError(f"{member.name}: base member is not owned by the skill user")
                    if not member.isfile():
                        dst.addfile(member)
                        continue
                    data = src.extractfile(member).read()
                    data = transform(member, data, suffix, version, pins, changed)
                    member.size = len(data)
                    dst.addfile(member, io.BytesIO(data))
        missing = {ART, BUNDLE, PACKAGE} - set(changed)
        if missing:
            raise ValueError(f"{base}: missing {', '.join(sorted(missing))}")
        with tarfile.open(output, "w", format=tarfile.GNU_FORMAT) as outer:
            root = tarfile.TarInfo("./")
            root.type = tarfile.DIRTYPE
            root.mode = 0o755
            root.mtime = int(time.time())
            outer.addfile(root)
            member = tarfile.TarInfo("./filesystem.tar.bz2")
            member.mode = 0o644
            member.mtime = root.mtime
            member.size = inner_path.stat().st_size
            with inner_path.open("rb") as stream:
                outer.addfile(member, stream)
    return {
        "file": output.name, "bytes": output.stat().st_size,
        "sha1": file_digest(output, "sha1"), "sha256": file_digest(output, "sha256"),
        "subsystem": "oobe-config", "fromBase": changed.pop("from_version"), "version": version, "changed": changed,
    }


def verify(output: Path, base: Path, version: str) -> None:
    """Every member but the three rewritten files is byte- and metadata-identical to the base."""
    def members(path: Path) -> dict:
        found = {}
        with tarfile.open(path, "r:") as outer:
            stream = outer.extractfile("./filesystem.tar.bz2")
            with stream, tarfile.open(fileobj=stream, mode="r|bz2") as inner:
                for m in inner:
                    data = inner.extractfile(m).read() if m.isfile() else None
                    found[m.name] = (m.type, m.mode, m.uid, m.gid, m.linkname,
                                     sha256(data) if data is not None else None)
        return found
    before, after = members(base), members(output)
    if set(before) != set(after):
        raise ValueError("the rebuilt package does not hold the same files as its base")
    differing = sorted(name for name in before if before[name] != after[name])
    if differing != sorted([ART, BUNDLE, PACKAGE]):
        raise ValueError(f"unexpected changes: {differing}")
    with tarfile.open(output, "r:") as outer:
        stream = outer.extractfile("./filesystem.tar.bz2")
        with stream, tarfile.open(fileobj=stream, mode="r|bz2") as inner:
            for m in inner:
                if m.name == PACKAGE and json.loads(inner.extractfile(m).read()).get("version") != version:
                    raise ValueError("package.json does not carry the new version")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base", type=Path, required=True, help="published oobe-config OTA package")
    parser.add_argument("--out", type=Path, required=True, help="output directory")
    parser.add_argument("--version", required=True, help="new skill version, e.g. 9.0.2")
    parser.add_argument("--suffix", default="jibo.io", help="server name the screens show")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    output = args.out / f"oobe-config-{args.version}-{args.suffix.replace('.', '-')}.tar"
    if output.exists():
        raise SystemExit(f"refusing to overwrite {output}")
    result = build(args.base, output, args.version, args.suffix)
    verify(output, args.base, args.version)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
