#!/usr/bin/env python3
"""Prepare an isolated original checkout. Never edits the source repository.

Only registry locations/configuration change; the original lock's versions and
tarball hashes remain intact. Package lifecycle scripts are run separately, if
needed, after review. Runtime fixtures must provide their own configuration.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PINS = json.loads((ROOT / "docs/parity/evidence/2026-09-05/compatibility-pins.json").read_text())
CACHE = ROOT / ".parity"
REVISION = PINS["originalCommit"]
YARN_URL = "https://registry.npmjs.org/yarn/-/yarn-1.5.1.tgz"
YARN_SHA1 = "e8680360e832ac89521eb80dad3a7bc27a40bab4"
EXCLUDED_WORKSPACES = {"hub-client-cli", "integration-tests-int", "integration-tests-ext"}


def relocate_lock(original):
    def relocate(match):
        name, filename = match.groups()
        archived = name.startswith(("jibo-", "@jibo/", "@jibo-tools/", "@jiborobot/", "@converseai/", "@milashenko/", "@perez/", "@types/jibo-"))
        registry = "https://pvindex.org/npm" if archived else "https://registry.npmjs.org"
        return registry + "/" + name + "/-/" + filename
    relocated, count = re.subn(
        r"http://10\.0\.0\.106:8080/[^/]+/(.+?)/_attachments/([^\"\s]+)",
        relocate, original,
    )
    if count != 1443 or "10.0.0.106" in relocated:
        raise RuntimeError("Unexpected original registry URL inventory")
    return relocated, count


def digest(path, algorithm="sha256"):
    h = hashlib.new(algorithm)
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def download(url, target, expected, algorithm="sha256"):
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        partial = target.with_suffix(".partial")
        with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as output:
            for block in iter(lambda: response.read(1024 * 1024), b""):
                output.write(block)
        if digest(partial, algorithm) != expected:
            raise RuntimeError("Integrity mismatch for " + url)
        partial.rename(target)
    if digest(target, algorithm) != expected:
        raise RuntimeError("Integrity mismatch for " + str(target))
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "pegasus")
    args = parser.parse_args()
    source = args.source.resolve()
    resolved = subprocess.check_output(["git", "-C", str(source), "rev-parse", REVISION], text=True).strip()
    if resolved != REVISION:
        raise RuntimeError("Source revision does not match the frozen manifest")

    CACHE.mkdir(exist_ok=True)
    target = CACHE / "reference" / REVISION
    marker = target / "parity-prepared.json"
    if not marker.exists():
        if target.exists():
            raise RuntimeError("Unrecognized reference directory; refusing to overwrite " + str(target))
        target.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
            archive = subprocess.check_output(["git", "-C", str(source), "archive", "--format=tar", REVISION])
            # Git-generated archive from the exact local source object.
            with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
                tar.extractall(tmp, filter="data")
            checkout = Path(tmp)
            lock = checkout / "yarn.lock"
            if digest(lock) != PINS["sourceFiles"]["yarn.lock"]:
                raise RuntimeError("Original lock hash mismatch")
            original_lock = lock.read_text()
            relocated, count = relocate_lock(original_lock)
            lock.write_text(relocated)
            # Jibo has unscoped archived dependencies too. Command line registry
            # selection and this file prevent inherited workstation config use.
            (checkout / ".npmrc").write_text("registry=https://pvindex.org/npm/\n")
            metadata = {
                "referenceRevision": REVISION,
                "originalLockSha256": PINS["sourceFiles"]["yarn.lock"],
                "relocatedLockSha256": digest(lock),
                "relocatedUrls": count,
                "sourceArchiveSha256": hashlib.sha256(archive).hexdigest(),
                "adaptations": ["Relocate 1443 registry URLs, preserving versions and original SHA-1 fragments", "Use a fixture-only archive registry .npmrc"],
            }
            (checkout / marker.name).write_text(json.dumps(metadata, indent=2) + "\n")
            checkout.rename(target)
    else:
        metadata = json.loads(marker.read_text())
        if metadata["referenceRevision"] != REVISION or digest(target / "yarn.lock") != metadata["relocatedLockSha256"]:
            raise RuntimeError("Prepared reference metadata/lock changed")
        # Provisioning revisions may improve archive/public routing, while the
        # source object and every version/hash remain the same.
        original_lock = subprocess.check_output(["git", "-C", str(source), "show", REVISION + ":yarn.lock"], text=True)
        relocated, _ = relocate_lock(original_lock)
        (target / "yarn.lock").write_text(relocated)
        metadata["relocatedLockSha256"] = digest(target / "yarn.lock")
        marker.write_text(json.dumps(metadata, indent=2) + "\n")

    # The full development graph includes robot animation/video/build tools.
    # Install only server runtime dependencies in this isolated checkout. The
    # original service package manifests/source remain byte-identical.
    original_manifest = json.loads(subprocess.check_output(["git", "-C", str(source), "show", REVISION + ":package.json"]))
    original_manifest["workspaces"] = [
        "packages/" + package.parent.name for package in sorted((target / "packages").glob("*/package.json"))
        if package.parent.name not in EXCLUDED_WORKSPACES
    ]
    (target / "package.json").write_text(json.dumps(original_manifest, indent=2) + "\n")
    metadata = json.loads(marker.read_text())
    metadata["excludedWorkspaces"] = sorted(EXCLUDED_WORKSPACES)
    metadata["installProfile"] = "Production dependencies for 15 server/client/library workspaces; no lifecycle scripts or development dependencies"
    metadata["rootManifestSha256"] = digest(target / "package.json")
    marker.write_text(json.dumps(metadata, indent=2) + "\n")

    yarn_tar = download(YARN_URL, CACHE / "downloads/yarn-1.5.1.tgz", YARN_SHA1, "sha1")
    yarn_dir = CACHE / "tools/yarn-1.5.1"
    if not yarn_dir.exists():
        yarn_dir.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=yarn_dir.parent) as tmp:
            with tarfile.open(yarn_tar) as tar:
                tar.extractall(tmp, filter="data")
            (Path(tmp) / "yarn-v1.5.1").rename(yarn_dir)

    ts_tar = download("https://registry.npmjs.org/typescript/-/typescript-2.5.3.tgz", CACHE / "downloads/typescript-2.5.3.tgz", "df3dcdc38f3beb800d4bc322646b04a3f6ca7f0d", "sha1")
    ts_dir = CACHE / "tools/typescript-2.5.3"
    if not ts_dir.exists():
        with tempfile.TemporaryDirectory(dir=ts_dir.parent) as tmp:
            with tarfile.open(ts_tar) as tar:
                tar.extractall(tmp, filter="data")
            (Path(tmp) / "package").rename(ts_dir)

    nlu = PINS["nlu"]
    nlu_zip = download(nlu["requestedArtifact"], CACHE / "downloads/jibo-nlu-v2.8.3-linux-x64.zip", nlu["requestedSha256"])
    nlu_root = target / "packages/parser/robust-parser"
    if not (nlu_root / "build").exists():
        with zipfile.ZipFile(nlu_zip) as archive:
            for member in archive.infolist():
                destination = (nlu_root / member.filename).resolve()
                if not destination.is_relative_to(nlu_root.resolve()):
                    raise RuntimeError("Unexpected NLU archive path")
                archive.extract(member, nlu_root)
                mode = member.external_attr >> 16
                if mode and destination.is_file():
                    destination.chmod(mode & 0o777)

    print(json.dumps({"reference": str(target), "revision": REVISION, "yarn": str(yarn_dir / "bin/yarn.js"), "typescript": str(ts_dir), "nluSha256": digest(nlu_zip)}, indent=2))


if __name__ == "__main__":
    main()
