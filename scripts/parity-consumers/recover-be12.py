#!/usr/bin/env python3
"""Recover selected unmodified client sources embedded in the BE 12 release.

No package installation, build scripts, simulator, or robot access is involved.
The archive hash is from Hermes BE's SOURCE.md and independently checked here.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ARCHIVE_URL = "https://pvindex.org/repository/skills/jibo-be/jibo-be-12.0.0.tar.gz"
ARCHIVE_SHA256 = "e29f476c75e35e9bbd07c0211c75e2385772e4dfb3dd079a1d832e3832450657"
ARCHIVE_BYTES = 192233932
PACKAGES = {
    "be": ("", "index.js.map"),
    "nimbus": ("node_modules/@be/nimbus/", "index.js.map"),
    "be-framework": ("node_modules/@be/be-framework/", "lib/be-framework.js.map"),
    "jetstream-client": ("node_modules/@jibo/jetstream-client/", "lib/jetstream-client.js.map"),
    "jibo-command-protocol": ("node_modules/jibo-command-protocol/", "lib/jibo-command-protocol.js.map"),
    "jibo-service-clients": ("node_modules/jibo-service-clients/", "lib/jibo-service-clients.js.map"),
    "jibo": ("node_modules/jibo/", "lib/jibo.js.map"),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def preserve(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() != data:
        raise ValueError(f"Refusing to overwrite different reference bytes: {path}")
    path.write_bytes(data)


def recover(archive, out):
    if archive.stat().st_size != ARCHIVE_BYTES:
        raise ValueError("Unexpected release archive size")
    hasher = hashlib.sha256()
    with archive.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    digest = hasher.hexdigest()
    if digest != ARCHIVE_SHA256:
        raise ValueError("Release archive SHA-256 mismatch")

    wanted = {root + name for root, mapping in PACKAGES.values()
              for name in ("package.json", mapping, mapping[:-4])}
    members = {}
    with tarfile.open(archive, "r:gz") as release:
        for member in release:
            name = member.name.removeprefix("./")
            if name not in wanted:
                continue
            if not member.isfile() or name in members:
                raise ValueError(f"Nonregular or duplicate release member: {name}")
            members[name] = release.extractfile(member).read()
    if set(members) != wanted:
        raise ValueError(f"Missing release members: {sorted(wanted - set(members))}")

    report = {
        "schemaVersion": 1, "profile": "be-12.0.0-archive-consumer",
        "basis": "Embedded release source inspection; no client, simulator or hardware runtime claim",
        "archive": {"url": ARCHIVE_URL, "sha256": digest, "bytes": ARCHIVE_BYTES},
        "toolSha256": sha(Path(__file__).read_bytes()), "packages": [],
    }
    for key, (root, mapping) in PACKAGES.items():
        package = json.loads(members[root + "package.json"])
        source_map = json.loads(members[root + mapping])
        sources, contents = source_map["sources"], source_map["sourcesContent"]
        if source_map.get("version") != 3 or len(sources) != len(contents):
            raise ValueError(f"Invalid embedded source map: {mapping}")
        entry = {"key": key, "name": package["name"], "version": package["version"],
                 "sourceRoot": source_map.get("sourceRoot"),
                 "artifacts": [], "sources": [], "excludedSources": []}
        for name in ("package.json", mapping, mapping[:-4]):
            data = members[root + name]
            relative = f"{key}/release/{name}"
            preserve(out / relative, data)
            entry["artifacts"].append({"archiveMember": root + name,
                "path": relative, "sha256": sha(data), "bytes": len(data)})
        seen = set()
        for index, (name, content) in enumerate(zip(sources, contents)):
            if not name.startswith("src/"):
                entry["excludedSources"].append({"index": index, "name": name,
                    "reason": "Outside this package's src/ tree"})
                continue
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or "\\" in name or str(path) != name:
                raise ValueError(f"Unsafe source-map path: {name}")
            if name in seen or not isinstance(content, str):
                raise ValueError(f"Duplicate or absent source-map content: {name}")
            seen.add(name)
            data = content.encode("utf-8")
            relative = f"{key}/{name}"
            preserve(out / relative, data)
            entry["sources"].append({"index": index, "name": name, "path": relative,
                                     "sha256": sha(data), "bytes": len(data)})
        if not entry["sources"]:
            raise ValueError(f"No package sources recovered: {key}")
        report["packages"].append(entry)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=Path(".parity/consumers/downloads/jibo-be-12.0.0.tar.gz"))
    parser.add_argument("--download", action="store_true", help="Download the pinned release if absent")
    parser.add_argument("--out", type=Path, default=Path(".parity/consumers/be-12.0.0"))
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if not args.archive.exists() and args.download:
        args.archive.parent.mkdir(parents=True, exist_ok=True)
        partial = args.archive.with_suffix(".part")
        with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as response, partial.open("wb") as target:
            while chunk := response.read(1024 * 1024):
                target.write(chunk)
        # Validation in recover precedes any source writes; retain a bad download for diagnosis.
        partial.rename(args.archive)
    report = recover(args.archive, args.out)
    preserve(args.manifest, (json.dumps(report, indent=2) + "\n").encode())
    print(json.dumps({"archiveVerified": True, "packages": [
        {"name": p["name"], "version": p["version"], "sources": len(p["sources"])}
        for p in report["packages"]], "manifest": str(args.manifest)}))


if __name__ == "__main__":
    main()
