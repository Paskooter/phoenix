#!/usr/bin/env python3
"""Build the 13.0.6 jibo.io OTA from the published, hardware-tested 13.0.5.

The system packages are transformed as tar streams so every unchanged inode
keeps its original numeric owner, group, mode, and link target.  In particular,
debugfs rdump must never be used to repack rootfs/services: as an unprivileged
user it silently changes ownership and drops setuid bits.

The two skill packages use the *per-skill* layout of Jibo's published skill OTAs,
not a dump of the skills partition.  The BE payload is the tested Phoenix parity
11.0.1 tree, installed under the stock @be/be identity; OOBE is a separate
payload so its TLS client is updated without deleting any other skill.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import posixpath
import stat
import subprocess
import tarfile
import tempfile
import time


BASE_HASHES = {
    "os": "fc9c073a5d664dd422f25b0d5ebea31d82ed08e15d0569b189585e392cee2f21",
    "services": "d66f14ad2779356b7ab3a960685890a517e9d7d17966a829803b4e251d25c8af",
    "skills_image": "b99e13e39f4d7c618d1d074559a7e854100281b23d898ffb2d55717820d6eaee",
}
BACKUP_HASHES = {
    "./bin/jibo-system-backup": (
        "d17fbf4150dee58a988fe5ee72071d4515ef74f29876215bf66de2601e33e522",
        "fa438f59b09dcdc863526aaa574f9e8939670c465b40ed83236dd5646ab881d5",
    ),
    "./bin/jibo-system-restore": (
        "b5e7ec06c4ea72b641b8738b789a389575e250b152b3b6ecddd952d593e05ee6",
        "7c48b4a15bc30405fc30570251071b6f0efaf7f3057546a2fc403a20b64beb03",
    ),
}
CLIENT_SHA256 = "29686ca0aec6b93b8b716b94fca443ce25e6e7e55e01e798be56bce920c66bac"
ROOT_MARKER = b"MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw"
# The published 13.0.5 payloads still embed the stock reporter.  Aero's live
# reporters were corrected later, outside those packages.  Match the published
# bytes exactly rather than assuming their filenames describe their contents.
OLD_RELEASE = b"Release-13.0.0-20190225"
NEW_RELEASE = b"Release-13.0.6-20190225"
PATCHER = Path(__file__).resolve().parent / "robot-client/patch-system-backup-tls.cjs"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(path: Path, expected: str) -> None:
    actual = file_sha256(path)
    if actual != expected:
        raise ValueError(f"unexpected source hash for {path}: {actual} (expected {expected})")


def patch_release(data: bytes, name: str) -> bytes:
    if data.count(OLD_RELEASE) != 1:
        raise ValueError(f"{name}: published stock release marker not found exactly once")
    return data.replace(OLD_RELEASE, NEW_RELEASE)


def patch_backup(name: str, data: bytes) -> bytes:
    original, patched = BACKUP_HASHES[name]
    if sha256(data) != original:
        raise ValueError(f"{name}: backup helper does not match the reviewed original")
    method = "patchBackup" if name.endswith("backup") else "patchRestore"
    js = (
        f"const p=require({json.dumps(str(PATCHER))});"
        f"process.stdout.write(p.{method}(require('fs').readFileSync(0,'utf8'),"
        "'/etc/ssl/certs/ca-certificates.crt'));"
    )
    result = subprocess.run(["node", "-e", js], input=data, capture_output=True, check=True)
    if sha256(result.stdout) != patched:
        raise ValueError(f"{name}: generated TLS helper differs from the reviewed patch")
    return result.stdout


def write_outer(inner_bz2: Path, output: Path) -> None:
    with tarfile.open(output, "w", format=tarfile.GNU_FORMAT) as outer:
        root = tarfile.TarInfo("./")
        root.type = tarfile.DIRTYPE
        root.mode = 0o755
        root.mtime = int(time.time())
        outer.addfile(root)
        member = tarfile.TarInfo("./filesystem.tar.bz2")
        member.mode = 0o644
        member.mtime = root.mtime
        member.size = inner_bz2.stat().st_size
        with inner_bz2.open("rb") as stream:
            outer.addfile(member, stream)


def transform_system(source: Path, output: Path, subsystem: str) -> dict:
    release_path = "./usr/bin/jibo-version" if subsystem == "os" else "./bin/jibo-service-version"
    targets = {release_path}
    if subsystem == "services":
        targets.update(BACKUP_HASHES)
    seen: set[str] = set()
    with tempfile.TemporaryDirectory(prefix=f"jibo-io-ota-{subsystem}-") as tmp:
        inner_path = Path(tmp) / "filesystem.tar.bz2"
        with tarfile.open(source, "r:") as outer:
            members = outer.getmembers()
            if [m.name for m in members if m.isfile()] != ["./filesystem.tar.bz2"]:
                raise ValueError(f"{source}: unexpected outer OTA members")
            inner_stream = outer.extractfile("./filesystem.tar.bz2")
            if inner_stream is None:
                raise ValueError(f"{source}: missing filesystem payload")
            with inner_stream, tarfile.open(fileobj=inner_stream, mode="r|bz2") as inner:
                with tarfile.open(inner_path, "w:bz2", format=tarfile.GNU_FORMAT) as out:
                    for member in inner:
                        payload = inner.extractfile(member) if member.isfile() else None
                        if member.name in targets:
                            if not member.isfile() or payload is None:
                                raise ValueError(f"{member.name}: expected a regular file")
                            data = payload.read()
                            data = patch_release(data, member.name) if member.name == release_path else patch_backup(member.name, data)
                            member.size = len(data)
                            payload = io.BytesIO(data)
                            seen.add(member.name)
                        out.addfile(member, payload)
        if seen != targets:
            raise ValueError(f"{source}: missing patch targets: {sorted(targets - seen)}")
        write_outer(inner_path, output)
    return {"file": output.name, "bytes": output.stat().st_size, "sha256": file_sha256(output), "patched": sorted(seen)}


def debugfs_skill(image: Path, source: str, work: Path) -> Path:
    result = subprocess.run(
        ["fakeroot", "debugfs", "-R", f"rdump {source} {work}", str(image)],
        capture_output=True, text=True,
    )
    if result.returncode or "Operation not permitted" in result.stderr:
        raise RuntimeError(f"debugfs skill extract failed: {result.stderr[-1500:]}")
    extracted = work / source.rsplit("/", 1)[-1]
    if not (extracted / "package.json").is_file():
        raise ValueError(f"skill package.json missing after extracting {source}")
    return extracted


def validate_skill_tree(root: Path, name: str, version: str) -> None:
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if package.get("name") != name or package.get("version") != version:
        raise ValueError(f"{root}: wrong skill identity/version: {package.get('name')} {package.get('version')}")
    entry_script = "index.js" if name == "@be/be" else "oobe-config.js"
    if not (root / entry_script).is_file() or not (root / "index.html").is_file():
        raise ValueError(f"{root}: skill entrypoints missing")
    client = root / "node_modules/@jibo/jibo-server-client"
    if file_sha256(client / "lib/http/node.js") != CLIENT_SHA256:
        raise ValueError(f"{root}: unpatched server client")
    config = (client / "lib/region_config.json").read_bytes()
    if b"jibo.com" in config or b"jibo.io" not in config:
        raise ValueError(f"{root}: client endpoints have not been repointed")
    if ROOT_MARKER not in (client / "lib/http/phoenix-ca.pem").read_bytes():
        raise ValueError(f"{root}: ISRG Root X1 missing from skill client's CA")
    if b"jibo.com" in (client / "dist/aws-sdk-all.js").read_bytes():
        raise ValueError(f"{root}: bundled client still contains old endpoints")


def set_skill_identity(root: Path, old_name: str, old_version: str, new_name: str, new_version: str) -> None:
    target = root / "package.json"
    metadata = target.stat()
    package = json.loads(target.read_text(encoding="utf-8"))
    if package.get("name") != old_name or package.get("version") != old_version:
        raise ValueError(f"{target}: unexpected source skill identity/version")
    package["name"] = new_name
    package["version"] = new_version
    target.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    target.chmod(stat.S_IMODE(metadata.st_mode))
    os.utime(target, ns=(metadata.st_atime_ns, metadata.st_mtime_ns))


def build_skill(image: Path, output: Path, source: str, old_name: str, old_version: str,
                new_name: str, new_version: str) -> dict:
    with tempfile.TemporaryDirectory(prefix="jibo-io-skill-") as tmp:
        work = Path(tmp)
        root = debugfs_skill(image, source, work)
        set_skill_identity(root, old_name, old_version, new_name, new_version)
        validate_skill_tree(root, new_name, new_version)
        inner_path = work / "filesystem.tar.bz2"

        def owner_and_mode(member: tarfile.TarInfo) -> tarfile.TarInfo:
            member.uid = member.gid = 2000  # stock robot's jibo-skill user/group
            member.uname = member.gname = "jibo-skill"
            if member.name.startswith("/") or ".." in Path(member.name).parts:
                raise ValueError(f"unsafe skill member: {member.name}")
            if member.issym():
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), member.linkname))
                if member.linkname.startswith("/") or resolved == ".." or resolved.startswith("../"):
                    raise ValueError(f"unsafe skill symlink: {member.name} -> {member.linkname}")
            return member

        with tarfile.open(inner_path, "w:bz2", format=tarfile.GNU_FORMAT) as inner:
            inner.add(root, arcname=".", recursive=True, filter=owner_and_mode)
        write_outer(inner_path, output)
    return {"file": output.name, "bytes": output.stat().st_size, "sha256": file_sha256(output),
            "subsystem": new_name, "version": new_version, "owner": "2000:2000"}


def verify_package(package_path: Path, kind: str) -> None:
    """Verify installed-file layout, identity, metadata and every patched anchor."""
    wanted: set[str]
    if kind == "os":
        wanted = {"./usr/bin/jibo-version", "./bin/busybox", "./etc/ssl/cert.pem"}
    elif kind == "services":
        wanted = {"./bin/jibo-service-version", *BACKUP_HASHES}
    else:
        wanted = {"./package.json", "./index.html", "./node_modules/@jibo/jibo-server-client/lib/region_config.json",
                  "./node_modules/@jibo/jibo-server-client/lib/http/node.js",
                  "./node_modules/@jibo/jibo-server-client/lib/http/phoenix-ca.pem",
                  "./node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js"}
        wanted.add("./index.js" if kind == "be" else "./oobe-config.js")
    found: set[str] = set()
    with tarfile.open(package_path, "r:") as outer:
        if [member.name for member in outer if member.isfile()] != ["./filesystem.tar.bz2"]:
            raise ValueError(f"{package_path}: not an official-shape OTA wrapper")
        stream = outer.extractfile("./filesystem.tar.bz2")
        if stream is None:
            raise ValueError(f"{package_path}: missing filesystem tar")
        with stream, tarfile.open(fileobj=stream, mode="r|bz2") as inner:
            for member in inner:
                if kind in {"be", "oobe"} and (member.uid != 2000 or member.gid != 2000):
                    raise ValueError(f"{package_path}: wrong skill owner on {member.name}")
                if member.name not in wanted:
                    continue
                found.add(member.name)
                if kind == "os" and member.name == "./bin/busybox" and not member.mode & stat.S_ISUID:
                    raise ValueError("OS busybox lost its setuid bit")
                if kind == "os" and member.name == "./etc/ssl/cert.pem":
                    if not member.issym() or member.linkname != "certs/ca-certificates.crt":
                        raise ValueError("OS OpenSSL default CA link is wrong")
                    continue
                if not member.isfile():
                    raise ValueError(f"{member.name}: expected regular file")
                payload = inner.extractfile(member)
                if payload is None:
                    raise ValueError(f"{member.name}: missing bytes")
                data = payload.read()
                if member.name.endswith("jibo-version") or member.name.endswith("jibo-service-version"):
                    if data.count(NEW_RELEASE) != 1 or OLD_RELEASE in data:
                        raise ValueError(f"{member.name}: wrong embedded release")
                if member.name in BACKUP_HASHES and sha256(data) != BACKUP_HASHES[member.name][1]:
                    raise ValueError(f"{member.name}: TLS helper patch missing")
                if member.name == "./package.json":
                    metadata = json.loads(data)
                    expected = ("@be/be", "11.0.1") if kind == "be" else ("oobe-config", "9.0.1")
                    if (metadata.get("name"), metadata.get("version")) != expected:
                        raise ValueError(f"{package_path}: wrong skill package identity")
                if member.name.endswith("/lib/region_config.json") and (b"jibo.com" in data or b"jibo.io" not in data):
                    raise ValueError(f"{package_path}: unrepointed skill client config")
                if member.name.endswith("/lib/http/node.js") and sha256(data) != CLIENT_SHA256:
                    raise ValueError(f"{package_path}: wrong skill client transport")
                if member.name.endswith("/lib/http/phoenix-ca.pem") and ROOT_MARKER not in data:
                    raise ValueError(f"{package_path}: public trust root missing")
                if member.name.endswith("/dist/aws-sdk-all.js") and b"jibo.com" in data:
                    raise ValueError(f"{package_path}: bundled client still points at old cloud")
    if found != wanted:
        raise ValueError(f"{package_path}: missing required members: {sorted(wanted - found)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--os-base", required=True, type=Path)
    parser.add_argument("--services-base", required=True, type=Path)
    parser.add_argument("--skills-image", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--resume", action="store_true", help="verify and reuse completed packages from an interrupted build")
    args = parser.parse_args()
    for name, source in (("os", args.os_base), ("services", args.services_base), ("skills_image", args.skills_image)):
        require_hash(source, BASE_HASHES[name])
    if args.out.exists():
        if not args.resume or (args.out / "build-manifest.json").exists():
            raise ValueError(f"refusing to overwrite existing output directory: {args.out}")
    else:
        args.out.mkdir(parents=True)
    def make_or_resume(kind: str, filename: str, make):
        output = args.out / filename
        if output.exists():
            if not args.resume:
                raise ValueError(f"refusing to overwrite existing package: {output}")
            verify_package(output, kind)
            return {"file": filename, "bytes": output.stat().st_size, "sha256": file_sha256(output), "resumed": True}
        result = make(output)
        verify_package(output, kind)
        return result
    results = {}
    results["os"] = make_or_resume("os", "os-13.0.6.tar", lambda output: transform_system(args.os_base, output, "os"))
    results["services"] = make_or_resume("services", "services-13.0.6.tar", lambda output: transform_system(args.services_base, output, "services"))
    results["be"] = make_or_resume("be", "be-11.0.1-jibo-io.tar", lambda output: build_skill(
        args.skills_image, output,
        "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity", "@be/phoenix-parity-11-0-1", "11.0.1",
        "@be/be", "11.0.1",
    ))
    results["oobe"] = make_or_resume("oobe", "oobe-config-9.0.1-jibo-io.tar", lambda output: build_skill(
        args.skills_image, output,
        "/jibo/Jibo/Skills/oobe-config", "oobe-config", "9.0.0", "oobe-config", "9.0.1",
    ))
    manifest = {
        "kind": "jibo-io-ota-13.0.6", "created": int(time.time()),
        "sources": {"os": BASE_HASHES["os"], "services": BASE_HASHES["services"], "skills_image": BASE_HASHES["skills_image"]},
        "packages": results,
        "notes": "BE/OOBE are independent per-skill OTAs; neither replaces the skills partition. No hooks are present.",
    }
    (args.out / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
