#!/usr/bin/env python3
"""Reject incomplete BE skill OTAs before they can be published.

The official 11.0.1 archive is the complete runtime baseline. A valid custom
BE may replace or add reviewed files, but it must never silently drop files
from that baseline (as the 11.0.2 package did on 2026-09-27).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import posixpath
import tarfile
from pathlib import Path


OFFICIAL_11_0_1_SHA256 = "1f85e593cf7e868b969d74bed3eef78b447e72207fa4b3892de013aeb3e97d8d"
KNOWN_BAD_FIXTURES = {
    "node_modules/resolve/test/resolver/incorrect_main/package.json",
    "node_modules/glslify/node_modules/resolve/test/resolver/incorrect_main/package.json",
    "node_modules/glslify-deps/node_modules/resolve/test/resolver/incorrect_main/package.json",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_name(member: tarfile.TarInfo) -> str:
    name = member.name.removeprefix("./")
    if name in ("", "."):
        return ""
    if name.startswith("/") or name.startswith("../") or "/../" in name or name.endswith("/.."):
        raise ValueError(f"unsafe tar member path: {member.name}")
    normalized = posixpath.normpath(name)
    if normalized != name.rstrip("/"):
        raise ValueError(f"noncanonical tar member path: {member.name}")
    if member.issym() or member.islnk():
        target = member.linkname
        if target.startswith("/"):
            raise ValueError(f"absolute tar link: {member.name} -> {target}")
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
        if resolved == ".." or resolved.startswith("../"):
            raise ValueError(f"escaping tar link: {member.name} -> {target}")
    elif not (member.isdir() or member.isfile()):
        raise ValueError(f"special tar member is not allowed: {member.name}")
    return name


def inspect_tar(stream: tarfile.TarFile, *, require_skill_owner: bool = False,
                retain: set[str] | None = None) -> tuple[dict[str, tuple[str, str]], dict[str, dict], dict[str, bytes]]:
    """Return per-file fingerprints, parsed manifests and selected file bytes."""
    records: dict[str, tuple[str, str]] = {}
    packages: dict[str, dict] = {}
    retained: dict[str, bytes] = {}
    seen: set[str] = set()
    for member in stream:
        name = safe_name(member)
        if not name:
            continue
        if name in seen:
            raise ValueError(f"duplicate tar member: {name}")
        seen.add(name)
        if require_skill_owner and (member.uid != 2000 or member.gid != 2000):
            raise ValueError(f"wrong BE OTA ownership for {name}: {member.uid}:{member.gid}")
        if member.isdir():
            continue
        if member.isfile():
            payload = stream.extractfile(member)
            if payload is None:
                raise ValueError(f"missing bytes for {name}")
            digest = hashlib.sha256()
            data = bytearray() if name.endswith("package.json") or name in (retain or ()) else None
            with payload:
                for block in iter(lambda: payload.read(1024 * 1024), b""):
                    digest.update(block)
                    if data is not None:
                        data.extend(block)
            records[name] = ("file", digest.hexdigest())
            if data is not None:
                if name.endswith("package.json"):
                    try:
                        packages[name] = json.loads(data)
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise ValueError(f"invalid {name}: {exc}") from exc
                if name in (retain or ()):
                    retained[name] = bytes(data)
        else:
            records[name] = ("link", member.linkname)
    return records, packages, retained


def inspect_official(path: Path, retain: set[str] | None = None):
    if file_sha256(path) != OFFICIAL_11_0_1_SHA256:
        raise ValueError("official BE base does not match pinned 11.0.1 archive")
    with tarfile.open(path, "r|gz") as source:
        return inspect_tar(source, retain=retain)


def inspect_ota(path: Path, retain: set[str] | None = None):
    with tarfile.open(path, "r:") as outer:
        members = [m for m in outer.getmembers() if m.isfile()]
        if len(members) != 1 or members[0].name != "./filesystem.tar.bz2":
            raise ValueError("BE OTA must have the official ./filesystem.tar.bz2 wrapper")
        payload = outer.extractfile(members[0])
        if payload is None:
            raise ValueError("BE OTA has no filesystem payload")
        with payload, tarfile.open(fileobj=payload, mode="r|bz2") as inner:
            return inspect_tar(inner, require_skill_owner=True, retain=retain)


def unresolved_mains(records: dict[str, tuple[str, str]], packages: dict[str, dict]) -> list[str]:
    available = set(records)
    errors: list[str] = []
    for manifest, package in packages.items():
        main = package.get("main")
        if not isinstance(main, str) or not main or manifest in KNOWN_BAD_FIXTURES:
            continue
        target = posixpath.normpath(posixpath.join(posixpath.dirname(manifest), main))
        if target == ".." or target.startswith("../"):
            errors.append(f"{manifest}: main escapes skill root ({main})")
            continue
        candidates = (target, target + ".js", target + ".json", target + ".node",
                      target + "/index.js", target + "/index.json", target + "/package.json")
        if not any(name in available for name in candidates):
            errors.append(f"{manifest}: main {main} is missing")
    return errors


def verify_be_ota(official: Path, candidate: Path, version: str) -> dict:
    reference, _, _ = inspect_official(official)
    actual, packages, _ = inspect_ota(candidate)
    if len(reference) != 21590:
        raise ValueError(f"unexpected official BE file count: {len(reference)}")
    missing = sorted(set(reference) - set(actual))
    if missing:
        sample = ", ".join(missing[:12])
        raise ValueError(f"BE OTA omits {len(missing)} official runtime files: {sample}")
    root = packages.get("package.json", {})
    if (root.get("name"), root.get("version")) != ("@be/be", version):
        raise ValueError(f"BE OTA identity is not @be/be {version}")
    for anchor in ("index.js", "index.html", "node_modules/@be/nimbus/index.js",
                   "node_modules/@be/surprises/lib/surprises.js"):
        if anchor not in actual:
            raise ValueError(f"BE OTA is missing critical entry point: {anchor}")
    bad_mains = unresolved_mains(actual, packages)
    if bad_mains:
        raise ValueError("BE OTA has unresolved package main fields: " + "; ".join(bad_mains[:12]))
    return {"officialFiles": len(reference), "candidateFiles": len(actual),
            "addedFiles": len(set(actual) - set(reference)), "unresolvedMains": 0,
            "sha256": file_sha256(candidate)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--official-base", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    print(json.dumps(verify_be_ota(args.official_base, args.candidate, args.version), indent=2))


if __name__ == "__main__":
    main()
