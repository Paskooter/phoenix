#!/usr/bin/env python3
"""Build a jibo.io-native legacy Release-13 image without Phoenix intercepts.

The native Buildroot source/toolchain is not available as a reproducible checkout
in this worktree, so this builder applies fixed-width patches to the already
built native service shared objects and rewrites installed configuration files.
It never mounts an image, contacts a robot, uploads, publishes, or flashes.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any

BASE_RELEASE = "Release-13.0.0-20190225"
# OTA eligibility is derived from these two binaries, not the package filename.
# A Phoenix OTA is a real version step even though it starts from the Last Dance
# filesystem, so the marker embedded in each replaced partition must match the
# catalog `toVersion`.  Leaving the stock marker here makes the server offer the
# same wildcard package again after a successful install.
DEFAULT_OTA_VERSION = "13.0.5"
RELEASE_DATE = "20190225"
RELEASE_MARKER = BASE_RELEASE.encode("ascii")
RELEASE_MARKER_PATHS = {
    "rootfs": {
        "path": "/usr/bin/jibo-version",
        "original_sha256": "10e5e3fc26d378ddd62d1d507ce90a257c489dba15e8e22228b79a143e43a2a5",
    },
    "services": {
        "path": "/usr/local/bin/jibo-service-version",
        "original_sha256": "1030a13a7df30d24638902dbeaf9558865cc7f8f27335e44544d06263515f59d",
    },
}
DEFAULT_PUBLIC_URL = "https://api.jibo.io"
# Empty by default: bake NO HubClient.override, so each robot resolves the hub for
# its own region from region-settings. Pass --hub-host to pin one explicitly.
DEFAULT_HUB_HOST = ""
DEFAULT_ENTRYPOINT_HOST = ""
DEFAULT_HUB_PORT = 443
CLIENT_SHA256 = "29686ca0aec6b93b8b716b94fca443ce25e6e7e55e01e798be56bce920c66bac"
REGION_CONFIG_PATHS = [
    "/usr/lib/node_modules/@jibo/jibo-server-client/lib/region_config.json",
    # Nested copies of the same client, shipped inside other node packages in the
    # rootfs. Node resolves THESE when jibo-log-client or jibo-ota-updater requires
    # the client, so the top-level copy above does not shadow them — leaving them
    # pointing at jibo.com keeps the hosts intercept load-bearing.
    "/usr/lib/node_modules/@jibo/jibo-log-client/node_modules/@jibo/jibo-server-client/lib/region_config.json",
    "/usr/lib/node_modules/@jibo/jibo-ota-updater/node_modules/@jibo/jibo-server-client/lib/region_config.json",
]
BE_REGION_CONFIG = "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/region_config.json"
BE_CLIENT_PATH = "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/http/node.js"
BE_CLIENT_HTTP_DIR = "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/http"
CLIENT_HTTP_DIR = "/usr/lib/node_modules/@jibo/jibo-server-client/lib/http"
# A robot carries SEVERAL copies of this client, one per consumer (the log client, the OTA
# updater, the system manager, each skill). Fixing only the top-level copy leaves the others
# unable to verify TLS -- and the OTA updater is one of the others, so the robot could never
# fetch the very update that would fix it. Patch every copy that exists.
CLIENT_HTTP_DIRS_ROOTFS = [
    "/usr/lib/node_modules/@jibo/jibo-server-client/lib/http",
    "/usr/lib/node_modules/@jibo/jibo-log-client/node_modules/@jibo/jibo-server-client/lib/http",
    "/usr/lib/node_modules/@jibo/jibo-ota-updater/node_modules/@jibo/jibo-server-client/lib/http",
]
CLIENT_HTTP_DIRS_SERVICES = [
    "/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/http",
]
CLIENT_HTTP_DIRS_SKILLS = [
    "/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/lib/http",
]
BE_CA_PATH = "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/lib/http/phoenix-ca.pem"
# jibo-ssm lives in the services image and requires its own nested copy of the
# client at runtime; the rootfs paths above do not reach into it.
SERVICES_REGION_CONFIG_PATHS = [
    "/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/lib/region_config.json",
]
# The oobe-config skill ships and requires its own nested copy too.
SKILLS_REGION_CONFIG_PATHS = [
    BE_REGION_CONFIG,
    "/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/lib/region_config.json",
]
# Hardcoded hostnames in installed JavaScript that no region_config rewrite can
# reach.
#
# `.com` is one byte longer than `.io`, so a bare hostname substitution would
# shorten the file and shift every following byte — which would desynchronise the
# sourcemaps these files ship with. Each match therefore includes the closing
# quote and the replacement re-emits the freed byte as a space *after* the quote,
# where JavaScript ignores it:
#
#     API: 'api.jibo.com',   ->   API: 'api.jibo.io' ,
#
# Same length, same offsets, same meaning.
#
#   skills-service-manager.js  PingService.DOMAIN_LIST.API — the connectivity ping
#                              target. Its DOMAIN_LIST siblings (DNS 8.8.8.8,
#                              ASR speech.googleapis.com) are real third-party
#                              endpoints and are deliberately left alone.
#   analytics-node/lib/index.js  the default analytics host (and the doc comment
#                              above it). Patching it points telemetry at
#                              jibo.io; it will simply fail to connect, which is
#                              the same outcome as today.
TEXT_LITERAL_PATCHES = [
    ("/bin/jibo-ssm/lib/skills-service-manager.js", "api.jibo.com'", "api.jibo.io' "),
    ("/bin/jibo-ssm/node_modules/@jibo/analytics-node/lib/index.js", "segment.jibo.com'", "segment.jibo.io' "),
]
# Robot-resident files that embed jibo.com endpoints and are not reached by any
# config rewrite.
#
#   dist/aws-sdk-all.js  a full copy of the client's endpoint config —
#       "{service}.{region}.api.jibo.com", "https://{region}.jibo.com",
#       "wss://{region}-socket.jibo.com", the :8080 REST/WS pair — plus package
#       metadata (npm registry, support address, author emails, repo URL). Nothing
#       on the client's main path requires dist/: the package `main` is lib/aws.js,
#       which loads lib/* and references dist/ zero times. Rewritten anyway so a
#       stray require cannot resolve a jibo.com endpoint out of the embedded copy.
#
#   bin/on-robot/install-node-inspector.sh  fetches a tarball from
#       http://repository.jibo.com. A developer script, not a boot path.
#
#   share/jibo-platform-test/platform-resolvConfTest  resolves and wgets
#       repository.jibo.com. A platform test.
#
# All three are rewritten so that no robot-resident file can point at a jibo.com
# endpoint — the point is that an audit for jibo.com comes back with nothing that
# could be mistaken for a live endpoint.
#
# These may change file length, unlike TEXT_LITERAL_PATCHES: the bundles ship no
# sourcemap (verified: no .map in dist/, no sourceMappingURL in the file) and
# Browserify keys modules by index, not byte offset; the two scripts are plain
# text. aws-sdk.js and aws-sdk.min.js contain no jibo.com at all and are
# deliberately not touched.
RESIDUAL_REWRITE_PATHS = {
    "rootfs": [
        "/usr/lib/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
        "/usr/lib/node_modules/@jibo/jibo-log-client/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
        "/usr/lib/node_modules/@jibo/jibo-ota-updater/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
    ],
    "services": [
        "/bin/jibo-ssm/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
        "/bin/jibo-ssm/bin/on-robot/install-node-inspector.sh",
        "/share/jibo-platform-test/platform-resolvConfTest",
    ],
    "skills": [
        "/jibo/Jibo/Skills/phoenix-be-11-0-1-parity/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
        "/jibo/Jibo/Skills/oobe-config/node_modules/@jibo/jibo-server-client/dist/aws-sdk-all.js",
    ],
}
DEFAULT_REGIONS = [
    "api",
    "stg-entrypoint",
    "stg2-entrypoint",
    "alpha-entrypoint",
    "dev-entrypoint",
    "preprod-entrypoint",
]


def fail(message: str) -> None:
    raise RuntimeError(f"bake-jibo-io-native-image: {message}")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()
        fail(f"command failed ({result.returncode}): {' '.join(cmd)}: {detail}")
    return result


def require_file(path: Path, label: str) -> None:
    if not path.is_file():
        fail(f"{label} is not a regular file: {path}")


def require_dir(path: Path, label: str) -> None:
    if not path.is_dir():
        fail(f"{label} is not a directory: {path}")


def debugfs(image: Path, command: str, *, write: bool = False, check: bool = True) -> str:
    args = ["debugfs"]
    if write:
        args.append("-w")
    args.extend(["-R", command, str(image)])
    result = run(args, check=check)
    return (result.stdout or "") + (result.stderr or "")


def debugfs_exists(image: Path, path: str) -> bool:
    text = debugfs(image, f"stat {path}", check=False)
    return "File not found" not in text and "not found" not in text.lower()


def debugfs_dump(image: Path, path: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    text = debugfs(image, f"dump {path} {destination}", check=False)
    if not destination.is_file() or "error" in text.lower() or "not found" in text.lower():
        fail(f"could not dump {path} from {image}: {text.strip()}")


INODE_TYPE_BITS = {
    "regular": 0o100000,
    "directory": 0o040000,
    "symlink": 0o120000,
    "character special": 0o020000,
    "block special": 0o060000,
    "fifo": 0o010000,
    "socket": 0o140000,
}


def inode_metadata(image: Path, path: str) -> tuple[int, int, int]:
    text = debugfs(image, f"stat {path}")
    mode_match = re.search(r"Mode:\s+([0-7]+)", text)
    type_match = re.search(r"Type:\s+([a-z]+(?: [a-z]+)?)", text)
    owner_match = re.search(r"User:\s+(\d+)\s+Group:\s+(\d+)", text)
    if not mode_match or not owner_match:
        fail(f"cannot parse inode metadata for {image}:{path}")
    mode = int(mode_match.group(1), 8)
    if mode < 0o10000:
        # debugfs 'stat' prints only the permission bits; the S_IFMT type bits
        # must be restored from the separately printed Type: field, otherwise
        # the rewritten inode is left with an invalid mode (e2fsck error 4).
        if not type_match or type_match.group(1) not in INODE_TYPE_BITS:
            fail(f"cannot map inode type for {image}:{path}")
        mode |= INODE_TYPE_BITS[type_match.group(1)]
    return mode, int(owner_match.group(1)), int(owner_match.group(2))


def debugfs_batch(image: Path, commands: list[str]) -> None:
    fd, name = tempfile.mkstemp(prefix="jibo-io-debugfs-", suffix=".cmd")
    os.close(fd)
    command_file = Path(name)
    try:
        command_file.write_text("\n".join(commands) + "\n", encoding="utf-8")
        result = subprocess.run(
            ["debugfs", "-w", "-f", str(command_file), str(image)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        combined = (result.stdout or "") + (result.stderr or "")
        meaningful = [
            line for line in combined.splitlines()
            if line.strip() and not line.startswith("debugfs ") and "debugfs:" not in line
        ]
        if result.returncode != 0 or any("error" in line.lower() for line in meaningful):
            fail(f"debugfs batch failed for {image}: {' | '.join(meaningful[:12])}")
    finally:
        command_file.unlink(missing_ok=True)


def replace_file(image: Path, local: Path, remote: str, *, mode: int | None = None, uid: int | None = None, gid: int | None = None) -> None:
    commands = [f"rm {remote}" if debugfs_exists(image, remote) else "", f"write {local} {remote}"]
    commands = [command for command in commands if command]
    if mode is not None:
        commands.append(f"set_inode_field {remote} mode 0{mode:o}")
    if uid is not None:
        commands.append(f"set_inode_field {remote} uid {uid}")
    if gid is not None:
        commands.append(f"set_inode_field {remote} gid {gid}")
    debugfs_batch(image, commands)


def replace_preserving_inode(image: Path, remote: str, local: Path, *, mode: int | None = None) -> None:
    original_mode, uid, gid = inode_metadata(image, remote)
    replace_file(image, local, remote, mode=mode if mode is not None else original_mode, uid=uid, gid=gid)


def remove_file(image: Path, remote: str) -> bool:
    if not debugfs_exists(image, remote):
        return False
    debugfs_batch(image, [f"rm {remote}"])
    return True


def write_symlink(image: Path, remote: str, target: str) -> None:
    if debugfs_exists(image, remote):
        debugfs_batch(image, [f"rm {remote}"])
    debugfs_batch(image, [f"symlink {remote} {target}"])


def transform_strings(value: Any) -> Any:
    if isinstance(value, str):
        return value.replace("jibo.com", "jibo.io")
    if isinstance(value, list):
        return [transform_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: transform_strings(item) for key, item in value.items()}
    return value


def patch_json(image: Path, remote: str, transform, *, mode: int | None = None) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="jibo-io-json-") as td:
        source = Path(td) / "source.json"
        debugfs_dump(image, remote, source)
        original = json.loads(source.read_text(encoding="utf-8"))
        changed = transform(copy.deepcopy(original))
        output = Path(td) / "patched.json"
        output.write_text(json.dumps(changed, indent=4, ensure_ascii=False) + "\n", encoding="utf-8")
        replace_preserving_inode(image, remote, output, mode=mode)
        return changed


# Readable by everyone, because the behaviour engine and the skills run as the
# unprivileged skill user (uid 2000) while these files are owned by root. A copy at
# mode 0600 is unreadable to its own consumer: on a real robot that made the BE
# unable to read its client config, so every skill that reads it failed to
# construct and tapping Settings opened a blank screen ("cannot find skill:
# @be/settings"). Preserving whatever mode the stock image shipped is therefore the
# wrong default for these files.
CLIENT_READABLE = 0o100644  # S_IFREG | 0644: this code stores FULL modes, type bits included
CLIENT_EXECUTABLE = 0o100755  # OTA CLI scripts are exec'd directly by SystemManager.


def release_marker(version: str) -> bytes:
    """Return a fixed-width marker suitable for patching the shipped ELF files."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail("OTA version must be dotted numeric major.minor.patch")
    marker = f"Release-{version}-{RELEASE_DATE}".encode("ascii")
    if len(marker) != len(RELEASE_MARKER):
        fail(
            f"OTA version {version!r} cannot replace {BASE_RELEASE!r} without "
            "changing the binary layout"
        )
    return marker


def patch_release_marker(image: Path, image_name: str, version: str) -> dict[str, Any]:
    """Make the installed version reporter agree with this OTA artifact's version.

    The system manager asks these binaries for `fromVersion` on every future OTA
    check.  This deliberately changes only a single, source-pinned, same-length
    ASCII literal in each stock ELF and retains its inode metadata.
    """
    spec = RELEASE_MARKER_PATHS[image_name]
    remote = spec["path"]
    target = release_marker(version)
    with tempfile.TemporaryDirectory(prefix=f"jibo-io-version-{image_name}-") as td:
        local = Path(td) / Path(remote).name
        debugfs_dump(image, remote, local)
        original = local.read_bytes()
        original_hash = sha256_bytes(original)
        if original_hash != spec["original_sha256"]:
            fail(f"unexpected release reporter hash for {remote}: {original_hash}")
        occurrences = original.count(RELEASE_MARKER)
        if occurrences != 1:
            fail(f"release marker found {occurrences} times in {remote}")
        patched = original.replace(RELEASE_MARKER, target)
        local.write_bytes(patched)
        replace_preserving_inode(image, remote, local)
        return {
            "path": remote,
            "from": BASE_RELEASE,
            "to": target.decode("ascii"),
            "original_sha256": original_hash,
            "patched_sha256": sha256_bytes(patched),
        }


def patch_region_config(image: Path, remote: str) -> dict[str, Any]:
    return patch_json(image, remote, transform_strings, mode=CLIENT_READABLE)


def patch_server_service_config(image: Path) -> dict[str, Any]:
    def transform(value: Any) -> Any:
        result = transform_strings(value)
        if not isinstance(result, dict):
            fail("server-service config is not an object")
        notification = result.get("NotificationSubsystem")
        if not isinstance(notification, dict):
            fail("server-service config has no NotificationSubsystem object")
        notification["serverURLSuffix"] = "-socket.jibo.io"
        return result

    return patch_json(image, "/etc/jibo-server-service.json", transform)


def patch_jetstream_config(image: Path, hub_host: str, hub_port: int, entrypoint_host: str) -> dict[str, Any]:
    def transform(value: Any) -> Any:
        result = transform_strings(value)
        if not isinstance(result, dict):
            fail("Jetstream config is not an object")
        hub = result.get("HubClient")
        if not isinstance(hub, dict):
            fail("Jetstream config has no HubClient object")
        # HubClient.override WINS over region-settings for every robot, whatever its
        # region. Baking one here forces every robot onto a single host, and the stock
        # default (api.jibo.io) is the CLASSIC entrypoint, not a hub -- so a robot on
        # region `stg-entrypoint` streams its audio at Classic and every turn comes back
        # as "the hub reported an error".
        #
        # region-settings is already rewritten to jibo.io by transform_strings above and
        # carries the right hub per region (stg-entrypoint -> stg-hub.jibo.io, api ->
        # neo-hub.jibo.io), so the correct baked state is NO override: let each robot
        # resolve its own region. An operator who genuinely wants to pin one host can
        # still pass --hub-host explicitly.
        if hub_host:
            hub["override"] = {
                "hub_port": hub_port,
                "hub_hostname": hub_host,
                "entrypoint_hostname": entrypoint_host,
            }
        else:
            hub.pop("override", None)
        return result

    return patch_json(image, "/etc/jibo-jetstream-service.json", transform)


def patch_asr_config(image: Path) -> dict[str, Any]:
    def transform(value: Any) -> Any:
        result = transform_strings(value)
        if not isinstance(result, dict):
            fail("ASR config is not an object")
        return result

    return patch_json(image, "/etc/jibo-asr-service.json", transform)


def patch_fixed_literal(data: bytes, old: bytes, new: bytes, *, label: str, require_nul_after: bool = True) -> tuple[bytes, dict[str, Any]]:
    count = data.count(old)
    if count != 1:
        fail(f"{label}: expected exactly one source literal, found {count}")
    offset = data.find(old)
    assert offset >= 0
    after = offset + len(old)
    if require_nul_after and (after >= len(data) or data[after] != 0):
        fail(f"{label}: literal is not NUL-terminated")
    if len(new) > len(old):
        fail(f"{label}: replacement is longer than the in-place slot")
    replacement = new + b"\0" * (len(old) - len(new))
    result = data[:offset] + replacement + data[after:]
    if len(result) != len(data):
        fail(f"{label}: fixed-width replacement changed file length")
    return result, {
        "label": label,
        "offset_hex": hex(offset),
        "old": old.decode("ascii", "replace"),
        "new": new.decode("ascii", "replace"),
        "old_length": len(old),
        "slot_length": len(old),
    }


def patch_native_library(image: Path, remote: str) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="jibo-io-native-") as td:
        source = Path(td) / "native.so"
        debugfs_dump(image, remote, source)
        original = source.read_bytes()
        original_hash = sha256_bytes(original)
        patched = original
        patches: list[dict[str, Any]] = []
        patched, detail = patch_fixed_literal(
            patched,
            b"-socket.jibo.com",
            b"-socket.jibo.io",
            label="NotificationSubsystem socket suffix",
        )
        patches.append(detail)
        patched, detail = patch_fixed_literal(
            patched,
            b".jibo.com",
            b".jibo.io",
            label="NotificationSubsystem token suffix",
        )
        patches.append(detail)
        output = Path(td) / "patched.so"
        output.write_bytes(patched)
        replace_preserving_inode(image, remote, output)
        return {
            "path": remote,
            "original_sha256": original_hash,
            "patched_sha256": sha256_bytes(patched),
            "bytes_before": len(original),
            "bytes_after": len(patched),
            "patches": patches,
        }


def patch_asr_fallback(image: Path, remote: str) -> dict[str, Any]:
    """Patch the standalone default URL without changing the ELF file length.

    The configured ASR URL is patched separately.  The binary's fallback is a
    complete NUL-terminated URL, so replacing only jibo.com would shorten the
    slot and leave the path byte in the wrong position.  An empty query marker
    keeps the slot width while preserving the HTTP resource path; normal config
    always uses the exact no-query URL.
    """
    old = b"https://speech-logging.jibo.com/logdrop/logdrop.py"
    new = b"https://speech-logging.jibo.io/logdrop/logdrop.py?"
    with tempfile.TemporaryDirectory(prefix="jibo-io-asr-") as td:
        source = Path(td) / "asr"
        debugfs_dump(image, remote, source)
        original = source.read_bytes()
        original_hash = sha256_bytes(original)
        patched, detail = patch_fixed_literal(original, old, new, label="ASR default log URL")
        output = Path(td) / "patched-asr"
        output.write_bytes(patched)
        replace_preserving_inode(image, remote, output)
        detail["semantic_note"] = "empty query marker preserves the /logdrop/logdrop.py resource path; installed config uses the exact URL without ?."
        return {
            "path": remote,
            "original_sha256": original_hash,
            "patched_sha256": sha256_bytes(patched),
            "bytes_before": len(original),
            "bytes_after": len(patched),
            "patches": [detail],
        }


def add_trust_root(rootfs: Path, root_cert: Path) -> dict[str, Any]:
    cert_bytes = root_cert.read_bytes()
    with tempfile.TemporaryDirectory(prefix="jibo-io-trust-") as td:
        bundle = Path(td) / "ca-certificates.crt"
        debugfs_dump(rootfs, "/etc/ssl/certs/ca-certificates.crt", bundle)
        bundle_bytes = bundle.read_bytes()
        cert_text = cert_bytes.decode("ascii")
        marker = cert_text.strip().encode("ascii")
        already_present = marker in bundle_bytes
        if not already_present:
            bundle.write_bytes(bundle_bytes.rstrip(b"\n") + b"\n" + marker + b"\n")
            replace_preserving_inode(rootfs, "/etc/ssl/certs/ca-certificates.crt", bundle, mode=CLIENT_READABLE)
        cert_target = Path(td) / "isrg-root-x1.pem"
        cert_target.write_bytes(cert_bytes)
        cert_path = "/etc/ssl/certs/isrg-root-x1.pem"
        if not debugfs_exists(rootfs, cert_path):
            replace_file(rootfs, cert_target, cert_path, mode=0o100644, uid=0, gid=0)
        write_symlink(rootfs, "/etc/ssl/certs/6187b673.0", "isrg-root-x1.pem")
        # OpenSSL's DEFAULT CAfile is OPENSSLDIR/cert.pem, and OPENSSLDIR is compiled
        # in as /etc/ssl. The stock image never shipped /etc/ssl/cert.pem, so every
        # consumer that relies on the default trust store -- rather than being handed
        # an explicit CA -- finds no roots at all and fails with "certificate verify
        # failed". That is not a theoretical gap: the native Poco client inside
        # jibo-jetstream-service, which streams every audio turn to the hub, is such a
        # consumer. Without this link a robot talks to Classic perfectly and cannot
        # open a single hub socket, which presents as a robot that hears its wake word
        # and then answers nothing.
        cert_pem_link = "/etc/ssl/cert.pem"
        cert_pem_created = not debugfs_exists(rootfs, cert_pem_link)
        if cert_pem_created:
            write_symlink(rootfs, cert_pem_link, "certs/ca-certificates.crt")
        fingerprint = (run(["openssl", "x509", "-in", str(root_cert), "-noout", "-fingerprint", "-sha256"]).stdout or "").strip().split("=", 1)[-1]
        return {
            "root_subject": "C=US, O=Internet Security Research Group, CN=ISRG Root X1",
            "root_sha256": sha256_file(root_cert),
            "root_fingerprint_sha256": fingerprint,
            "subject_hash_old": "6187b673",
            "bundle_path": "/etc/ssl/certs/ca-certificates.crt",
            "directory_path": cert_path,
            "directory_link": "/etc/ssl/certs/6187b673.0",
            "openssl_default_cafile": cert_pem_link,
            "openssl_default_cafile_created": cert_pem_created,
            "already_in_bundle_before_build": already_present,
        }


OTA_DOWNLOADER_PATH = "/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js"
OTA_DOWNLOADER_ANCHOR = "let req = http.get(argv.url, function(res) {"
OTA_DOWNLOADER_PATCH = '''// This runs on Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (added in 7.3) and
// ignores the system trust store entirely -- /etc/ssl/cert.pem does not help it.
// Against a publicly-trusted server certificate a bare https.get therefore fails
// with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the update download dies at 0 bytes,
// which the system manager reports only as "Failed to download update". Hand https
// an explicit CA, the same way the patched jibo-server-client does.
let _getOpts = argv.url;
if (argv.url.startsWith("https:")) {
    let _caPath = process.env.JIBO_EXTRA_CA_CERTS || "/etc/ssl/certs/ca-certificates.crt";
    try {
        let _url = require("url").parse(argv.url);
        _getOpts = { protocol: _url.protocol, hostname: _url.hostname, port: _url.port,
                     path: _url.path, ca: fs.readFileSync(_caPath) };
    } catch (e) { /* no CA available: fall back to the default roots */ }
}

let req = http.get(_getOpts, function(res) {'''


def patch_ota_downloader(rootfs: Path) -> dict[str, Any]:
    """Give the OTA downloader an explicit CA.

    Without this a freshly flashed robot reaches the server, is correctly offered an
    update, and then cannot fetch it: the downloader is a separate Node 6 script from
    the jibo-server-client, so the CA-accepting client patch does not cover it, and
    Node 6 ignores both NODE_EXTRA_CA_CERTS and the system trust store.
    """
    with tempfile.TemporaryDirectory(prefix="jibo-io-ota-dl-") as td:
        local = Path(td) / "download-update.js"
        debugfs_dump(rootfs, OTA_DOWNLOADER_PATH, local)
        text = local.read_text(encoding="utf-8")
        if "JIBO_EXTRA_CA_CERTS" in text:
            # A prior builder revision accidentally used CLIENT_READABLE here.
            # SystemManager execs this file through /usr/bin/jibo-download-update;
            # mode 0644 makes every OTA download fail before opening the URL.
            replace_preserving_inode(rootfs, OTA_DOWNLOADER_PATH, local, mode=CLIENT_EXECUTABLE)
            return {"path": OTA_DOWNLOADER_PATH, "patched": False, "reason": "already patched", "mode": "0755"}
        if text.count(OTA_DOWNLOADER_ANCHOR) != 1:
            fail(f"OTA downloader anchor found {text.count(OTA_DOWNLOADER_ANCHOR)} times in {OTA_DOWNLOADER_PATH}")
        patched = text.replace(OTA_DOWNLOADER_ANCHOR, OTA_DOWNLOADER_PATCH)
        local.write_text(patched, encoding="utf-8")
        replace_preserving_inode(rootfs, OTA_DOWNLOADER_PATH, local, mode=CLIENT_EXECUTABLE)
        return {
            "path": OTA_DOWNLOADER_PATH,
            "patched": True,
            "mode": "0755",
            "bytes_before": len(text.encode("utf-8")),
            "bytes_after": len(patched.encode("utf-8")),
        }


# These two helpers are shipped by system-manager on the services partition
# (`/usr/local/bin` on the running robot). They use raw request/https transfers,
# not @jibo/jibo-server-client, so the client CA patch and the OTA downloader
# patch cannot cover them. Pin the known source hashes: a different installed
# helper must halt the image build rather than receive an unreviewed edit.
SYSTEM_BACKUP_TLS_PATCHES = {
    "/bin/jibo-system-backup": {
        "original_sha256": "d17fbf4150dee58a988fe5ee72071d4515ef74f29876215bf66de2601e33e522",
        "require_anchor": "var request = require('request');\n",
        "transfer_anchor": "            method: 'PUT',\n            headers: {",
        "transfer_replacement": "            method: 'PUT',\n            ca: phoenixTlsCA,\n            headers: {",
    },
    "/bin/jibo-system-restore": {
        "original_sha256": "b5e7ec06c4ea72b641b8738b789a389575e250b152b3b6ecddd952d593e05ee6",
        "require_anchor": "var https = require('https');\n",
        "transfer_anchor": "        https.get(downloadUrl, callbackDownload)",
        "transfer_replacement": "        var phoenixDownloadOptions = url.parse(downloadUrl);\n        phoenixDownloadOptions.ca = phoenixTlsCA;\n        https.get(phoenixDownloadOptions, callbackDownload)",
        "extra_require": "var url = require('url');\n",
    },
}
SYSTEM_BACKUP_TLS_MARK_BEGIN = "// >>> phoenix-system-backup-tls >>>"
SYSTEM_BACKUP_TLS_MARK_END = "// <<< phoenix-system-backup-tls <<<"


def patch_system_backup_tls(services: Path) -> list[dict[str, Any]]:
    """Bake explicit, verified public CA handling into backup *and* restore.

    Node 6.9 ignores the OS CA store. The image installs a maintained public
    bundle in that store, then both system-manager helpers pass that exact bundle
    to their respective network clients. There is intentionally no catch/fallback:
    inability to read the configured CA is a safe failure, not a reason to make a
    TLS request with an obsolete embedded root set.
    """
    ca_prelude = "\n".join([
        SYSTEM_BACKUP_TLS_MARK_BEGIN,
        "// Node 6 does not load the system CA bundle for request/https automatically.",
        "// Read the maintained public bundle explicitly; a missing configured path is",
        "// fatal rather than silently disabling or bypassing certificate verification.",
        "var phoenixTlsCA = fs.readFileSync(process.env.JIBO_EXTRA_CA_CERTS || '/etc/ssl/certs/ca-certificates.crt');",
        SYSTEM_BACKUP_TLS_MARK_END,
        "",
    ])
    results: list[dict[str, Any]] = []
    for remote, spec in SYSTEM_BACKUP_TLS_PATCHES.items():
        with tempfile.TemporaryDirectory(prefix="jibo-io-system-backup-tls-") as td:
            local = Path(td) / Path(remote).name
            debugfs_dump(services, remote, local)
            source = local.read_text(encoding="utf-8")
            source_hash = sha256_bytes(source.encode("utf-8"))
            if source_hash != spec["original_sha256"]:
                fail(f"unexpected system-manager helper source hash for {remote}: {source_hash}")
            if source.count(spec["require_anchor"]) != 1 or source.count(spec["transfer_anchor"]) != 1:
                fail(f"system-manager TLS anchors not found exactly once in {remote}")
            replacement = spec["require_anchor"] + spec.get("extra_require", "") + ca_prelude
            patched = source.replace(spec["require_anchor"], replacement).replace(
                spec["transfer_anchor"], spec["transfer_replacement"]
            )
            local.write_text(patched, encoding="utf-8")
            replace_preserving_inode(services, remote, local, mode=CLIENT_READABLE)
            results.append({
                "path": remote,
                "original_sha256": source_hash,
                "patched_sha256": sha256_bytes(patched.encode("utf-8")),
                "ca_bundle": "/etc/ssl/certs/ca-certificates.crt",
            })
    return results


SHIM_REMOTE_PATH = "/lib/libjibosslshim.so"
SHIM_SERVICE_EXECUTABLE = "/usr/local/bin/jibo-server-service"
SYSTEM_MANAGER_CONFIG = "/etc/jibo-system-manager.json"


def install_ssl_shim(services: Path, shim_source: Path) -> dict[str, Any]:
    """Bake the TLS shim and preload it into jibo-server-service.

    jibo-server-service cannot talk to a modern server on its own. It builds its Poco
    SSL context in code with no CA and ignores openSSL.client.* config, so every
    certificate is rejected ("Unacceptable certificate") before any verify callback
    runs; and it emits a stray NUL byte inside its request headers, which nginx rejects
    with a hard 400 ("Could not receive robot token: Bad Request"). Neither is fixable
    from configuration and the source is not available to rebuild.

    The shim attaches the system trust store to every SSL_CTX, bypasses the Poco peer
    check, and strips NULs from outgoing request heads. It is preloaded into ONLY this
    one service, via the system manager's own per-mode `environment` map -- the
    supervisor passes exactly what that map lists, so no wrapper script is involved.

    Note the services image root is /usr/local on the robot, so the in-image /lib is the
    robot's /usr/local/lib.
    """
    if not shim_source.is_file():
        fail(f"SSL shim not found: {shim_source}")

    replace_file(services, shim_source, SHIM_REMOTE_PATH, mode=0o100644, uid=0, gid=10)

    preloaded: list[str] = []

    def transform(value: Any) -> Any:
        result = transform_strings(value)
        if not isinstance(result, dict):
            fail("System manager config is not an object")

        def walk(node: Any) -> None:
            if isinstance(node, list):
                for item in node:
                    walk(item)
                return
            if not isinstance(node, dict):
                return
            if node.get("executable") == SHIM_SERVICE_EXECUTABLE:
                modes = node.get("modes")
                if isinstance(modes, dict):
                    for mode_name, mode_cfg in modes.items():
                        if not isinstance(mode_cfg, dict):
                            continue
                        env = mode_cfg.get("environment")
                        if not isinstance(env, dict):
                            env = {}
                            mode_cfg["environment"] = env
                        env["LD_PRELOAD"] = "/usr/local/lib/libjibosslshim.so"
                        preloaded.append(mode_name)
            for item in node.values():
                walk(item)

        walk(result)
        return result

    config = patch_json(services, SYSTEM_MANAGER_CONFIG, transform, mode=CLIENT_READABLE)
    if not preloaded:
        fail(f"no {SHIM_SERVICE_EXECUTABLE} entry found in {SYSTEM_MANAGER_CONFIG}")

    return {
        "shim": SHIM_REMOTE_PATH,
        "robot_path": "/usr/local/lib/libjibosslshim.so",
        "bytes": shim_source.stat().st_size,
        "preloaded_modes": preloaded,
        "config": config.get("path", SYSTEM_MANAGER_CONFIG) if isinstance(config, dict) else SYSTEM_MANAGER_CONFIG,
    }


def copy_reference_images(reference_images: Path, output_images: Path) -> None:
    output_images.mkdir(parents=True, exist_ok=False)
    for item in sorted(reference_images.iterdir()):
        if item.is_file():
            shutil.copy2(item, output_images / item.name)
        elif item.is_symlink():
            fail(f"reference image tree contains unexpected symlink: {item}")


def image_geometry(image: Path) -> dict[str, Any]:
    values: dict[str, str] = {}
    for line in (run(["tune2fs", "-l", str(image)]).stdout or "").splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            values[key.strip()] = value.strip()
    return {
        "bytes": image.stat().st_size,
        "block_size": int(values.get("Block size", "0")),
        "block_count": int(values.get("Block count", "0")),
        "free_blocks": int(values.get("Free blocks", "0")),
        "features": values.get("Filesystem features", "").split(),
        "state": values.get("Filesystem state", ""),
        "inode_count": int(values.get("Inode count", "0")),
    }


def install_client_ca(image: Path, http_dir: str, root_cert: Path) -> None:
    """Place the deployment CA beside a client copy, where that client loads it from.

    The shipped client is the CA-accepting build: it reads
    ``process.env.JIBO_EXTRA_CA_CERTS || __dirname + '/phoenix-ca.pem'`` and hands the result
    to its https.Agent.  This is the only way to make the robot trust a modern certificate.
    The robot runs Node 6.9.2, which predates NODE_EXTRA_CA_CERTS (7.3) and ignores the system
    store entirely, so installing a root into /etc/ssl/certs does nothing for the client --
    without this file every TLS request dies with UNABLE_TO_GET_ISSUER_CERT_LOCALLY and the
    robot cannot reach the server at all.
    """
    replace_file(image, root_cert, f"{http_dir}/phoenix-ca.pem", mode=CLIENT_READABLE, uid=0, gid=0)


def patch_text_literals(image: Path, patches: list[tuple[str, str, str]]) -> list[dict[str, Any]]:
    """Rewrite hardcoded hostnames in installed text files.

    Every replacement must be the same byte length as the text it replaces. That
    keeps the file length and every following offset identical, which matters
    because these files are read by Node at runtime and ship with sourcemaps.

    A literal that is not present is a hard failure, not a silent no-op: the point
    of this list is that a specific known string stops pointing at jibo.com, and
    quietly skipping it would rebuild an image that looks patched and is not.
    """
    results: list[dict[str, Any]] = []
    for remote, old, new in patches:
        if len(old) != len(new):
            fail(f"literal patch must preserve length: {old!r} -> {new!r}")
        with tempfile.TemporaryDirectory() as scratch:
            local = Path(scratch) / Path(remote).name
            debugfs_dump(image, remote, local)
            data = local.read_bytes()
            occurrences = data.count(old.encode())
            if occurrences == 0:
                fail(f"literal not present in {image}:{remote}: {old!r}")
            patched = data.replace(old.encode(), new.encode())
            if len(patched) != len(data):
                fail(f"literal patch changed file length for {remote}")
            local.write_bytes(patched)
            replace_preserving_inode(image, remote, local, mode=CLIENT_READABLE)
        results.append({"path": remote, "from": old, "to": new, "occurrences": occurrences})
    return results


def rewrite_literals(image: Path, paths: list[str], old: str, new: str) -> list[dict[str, Any]]:
    """Rewrite every occurrence of `old` to `new` in installed files.

    Unlike patch_text_literals this does NOT require equal lengths, and that is a
    deliberate difference: the files this is used on ship no sourcemap and are
    keyed by index rather than byte offset, so a shorter substitution shifts
    nothing that is read. Use patch_text_literals where offsets matter.

    A file with no occurrence is a hard failure — the list exists because a
    specific known string must stop pointing at jibo.com, and skipping it quietly
    would produce an image that looks clean and is not.
    """
    results: list[dict[str, Any]] = []
    for remote in paths:
        with tempfile.TemporaryDirectory() as scratch:
            local = Path(scratch) / Path(remote).name
            debugfs_dump(image, remote, local)
            data = local.read_bytes()
            occurrences = data.count(old.encode())
            if occurrences == 0:
                fail(f"literal not present in {image}:{remote}: {old!r}")
            patched = data.replace(old.encode(), new.encode())
            local.write_bytes(patched)
            replace_preserving_inode(image, remote, local, mode=CLIENT_READABLE)
        results.append({
            "path": remote,
            "from": old,
            "to": new,
            "occurrences": occurrences,
            "bytes_before": len(data),
            "bytes_after": len(patched),
        })
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-images", type=Path, required=True)
    parser.add_argument("--skills-base", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--client-source", type=Path, required=True)
    parser.add_argument("--root-ca", type=Path, required=True)
    parser.add_argument("--public-url", default=DEFAULT_PUBLIC_URL)
    parser.add_argument(
        "--ota-version",
        default=DEFAULT_OTA_VERSION,
        help="version reported by the installed OS/services images (must match the OTA catalog toVersion)",
    )
    parser.add_argument(
        "--ssl-shim",
        type=Path,
        default=Path("/home/shell/work/hermes-be/tools/jibo/libjibosslshim.so"),
        help="ARM libjibosslshim.so preloaded into jibo-server-service",
    )
    parser.add_argument("--hub-host", default=DEFAULT_HUB_HOST)
    parser.add_argument("--hub-port", type=int, default=DEFAULT_HUB_PORT)
    parser.add_argument("--entrypoint-host", default=DEFAULT_ENTRYPOINT_HOST)
    parser.add_argument("--execute", action="store_true")
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    require_dir(args.legacy_images, "stock image directory")
    require_file(args.skills_base, "skills base image")
    require_file(args.client_source, "client source")
    require_file(args.root_ca, "public root certificate")
    for name in ("rootfs.ext4", "services.ext4", "skills.ext4", "var.ext4"):
        require_file(args.legacy_images / name, f"stock {name}")
    if args.hub_port < 1 or args.hub_port > 65535:
        fail("--hub-port must be 1..65535")
    if args.output.exists():
        fail(f"refusing to overwrite existing output: {args.output}")
    if args.hub_host and not re.fullmatch(r"[A-Za-z0-9.-]+", args.hub_host):
        fail("unsafe --hub-host")
    if args.entrypoint_host and not re.fullmatch(r"[A-Za-z0-9.-]+", args.entrypoint_host):
        fail("unsafe --entrypoint-host")
    if args.public_url.rstrip("/") != DEFAULT_PUBLIC_URL:
        fail("this reviewed candidate is pinned to https://api.jibo.io")
    release_marker(args.ota_version)


def main() -> int:
    args = parse_args()
    validate_args(args)
    if not args.execute:
        print("JIBO.IO NATIVE IMAGE PLAN")
        print(f"  stock images: {args.legacy_images}")
        print(f"  skills base:  {args.skills_base}")
        print(f"  output:       {args.output}")
        print(f"  OTA version:  {args.ota_version}")
        print(f"  public URL:   {args.public_url}")
        print(f"  hub override: {args.hub_host}:{args.hub_port}")
        print(f"  entrypoint:   {args.entrypoint_host}:443")
        print("  native token: https://{region}.jibo.io:443/")
        print("  native socket: wss://{region}-socket.jibo.io:443/{token}")
        print("  hosts intercept: none")
        print("  private CA: none")
        print("No files were created, mounted, uploaded, or flashed.")
        return 0

    output = args.output
    output.mkdir(parents=True, exist_ok=False)
    images = output / "images"
    copy_reference_images(args.legacy_images, images)
    shutil.copy2(args.skills_base, images / "skills.ext4")
    rootfs = images / "rootfs.ext4"
    services = images / "services.ext4"
    skills = images / "skills.ext4"
    var_image = images / "var.ext4"

    if sha256_file(args.client_source) != CLIENT_SHA256:
        fail(f"unexpected client source hash: {sha256_file(args.client_source)}")

    root_region_configs: list[str] = []
    for path in REGION_CONFIG_PATHS:
        patch_region_config(rootfs, path)
        root_region_configs.append(path)
    for http_dir in CLIENT_HTTP_DIRS_ROOTFS:
        node_js = f"{http_dir}/node.js"
        if not debugfs_exists(rootfs, node_js):
            continue
        replace_preserving_inode(rootfs, node_js, args.client_source, mode=CLIENT_READABLE)
        install_client_ca(rootfs, http_dir, args.root_ca)

    services_region_configs: list[str] = []
    for path in SERVICES_REGION_CONFIG_PATHS:
        patch_region_config(services, path)
        services_region_configs.append(path)
    for http_dir in CLIENT_HTTP_DIRS_SERVICES:
        node_js = f"{http_dir}/node.js"
        if not debugfs_exists(services, node_js):
            continue
        replace_preserving_inode(services, node_js, args.client_source, mode=CLIENT_READABLE)
        install_client_ca(services, http_dir, args.root_ca)

    skills_region_configs: list[str] = []
    for path in SKILLS_REGION_CONFIG_PATHS:
        patch_region_config(skills, path)
        skills_region_configs.append(path)
    for http_dir in CLIENT_HTTP_DIRS_SKILLS:
        node_js = f"{http_dir}/node.js"
        if not debugfs_exists(skills, node_js):
            continue
        replace_preserving_inode(skills, node_js, args.client_source, mode=CLIENT_READABLE)
        install_client_ca(skills, http_dir, args.root_ca)
    replace_preserving_inode(skills, BE_CLIENT_PATH, args.client_source, mode=CLIENT_READABLE)
    install_client_ca(skills, BE_CLIENT_HTTP_DIR, args.root_ca)
    # NOTE: this path is deliberately NOT removed. An earlier revision deleted it, because the
    # image used to ship the stock client and relied on the system trust store. The shipped
    # client now loads its deployment CA from exactly this path, and Node 6 ignores the system
    # store, so deleting it would leave every request failing with
    # UNABLE_TO_GET_ISSUER_CERT_LOCALLY. It is installed by install_client_ca() above.

    native_patch = patch_native_library(services, "/lib/libJiboServerService.so")
    asr_patch = patch_asr_fallback(services, "/bin/jibo-asr-service")
    text_patches = patch_text_literals(services, TEXT_LITERAL_PATCHES)
    residual_rewrites = {
        name: rewrite_literals(
            {"rootfs": rootfs, "services": services, "skills": skills}[name], paths, "jibo.com", "jibo.io"
        )
        for name, paths in RESIDUAL_REWRITE_PATHS.items()
    }
    server_config = patch_server_service_config(services)
    jetstream_config = patch_jetstream_config(services, args.hub_host, args.hub_port, args.entrypoint_host)
    asr_config = patch_asr_config(services)
    ssl_shim = install_ssl_shim(services, args.ssl_shim)
    trust = add_trust_root(rootfs, args.root_ca)
    ota_downloader = patch_ota_downloader(rootfs)
    system_backup_tls = patch_system_backup_tls(services)
    root_release_marker = patch_release_marker(rootfs, "rootfs", args.ota_version)
    services_release_marker = patch_release_marker(services, "services", args.ota_version)

    # The stock /etc/hosts is deliberately untouched: it remains the symlink to
    # preserved /var/etc/hosts, and no Phoenix address or marker is added.
    hosts_metadata = inode_metadata(rootfs, "/etc/hosts")
    if not debugfs_exists(var_image, "/etc/hosts"):
        fail("stock var image has no /etc/hosts target")

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "kind": "jibo-io-native-image",
        "status": "baked-no-host-intercept-no-private-ca",
        "base_release": BASE_RELEASE,
        "ota_version": args.ota_version,
        "public_url": args.public_url.rstrip("/"),
        "hub": {
            "hub_port": args.hub_port,
            "hub_hostname": args.hub_host,
            "entrypoint_hostname": args.entrypoint_host,
        },
        "native_routes": {
            "token": "https://{region}.jibo.io:443/",
            "socket": "wss://{region}-socket.jibo.io:443/{token}",
        },
        "regions": DEFAULT_REGIONS,
        "region_config_strategy": "rewrite endpoint and websocket templates from jibo.com to jibo.io in every installed copy of the client config, including the nested copies in jibo-log-client, jibo-ota-updater, jibo-ssm and oobe-config that Node resolves at runtime",
        "hosts_intercept": {"present": False, "stock_rootfs_hosts_inode": {"mode": hosts_metadata[0], "uid": hosts_metadata[1], "gid": hosts_metadata[2], "target": "../var/etc/hosts"}},
        "private_ca": {"present": False, "kept_client_ca": BE_CA_PATH, "note": "holds the public ISRG Root X1, loaded by the CA-accepting client"},
        "trust": trust,
        "ssl_shim": ssl_shim,
        "ota_downloader": ota_downloader,
        "system_backup_tls": system_backup_tls,
        "release_markers": [root_release_marker, services_release_marker],
        "native_binary_patches": [native_patch, asr_patch],
        "text_literal_patches": text_patches,
        "residual_literal_rewrites": residual_rewrites,
        "configs": {
            "server_service": "/etc/jibo-server-service.json",
            "jetstream": "/etc/jibo-jetstream-service.json",
            "asr": "/etc/jibo-asr-service.json",
            "system_region_configs": root_region_configs,
            "services_region_configs": services_region_configs,
            "skills_region_configs": skills_region_configs,
        },
        "client_source_sha256": CLIENT_SHA256,
        "inputs": {
            "stock_images_dir": str(args.legacy_images),
            "skills_base_sha256": sha256_file(args.skills_base),
            "client_source_sha256": sha256_file(args.client_source),
            "root_ca_sha256": sha256_file(args.root_ca),
        },
        "hooks": {"preinstall": False, "postinstall": False},
    }
    (output / "repoint-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    final = copy.deepcopy(manifest)
    final["images"] = {}
    for image in sorted(images.iterdir()):
        if image.is_file():
            final["images"][image.name] = {"bytes": image.stat().st_size, "sha256": sha256_file(image)}
    final["image_geometry"] = {name: image_geometry(images / name) for name in ("rootfs.ext4", "services.ext4", "skills.ext4", "var.ext4")}
    (output / "repoint-manifest.json").write_text(json.dumps(final, indent=2) + "\n", encoding="utf-8")
    (output / "SHA256SUMS").write_text(
        "".join(f"{entry['sha256']}  images/{name}\n" for name, entry in sorted(final["images"].items())),
        encoding="utf-8",
    )
    for image in (rootfs, services, skills, var_image):
        run(["e2fsck", "-fn", str(image)])
    print(json.dumps(final, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(2)
