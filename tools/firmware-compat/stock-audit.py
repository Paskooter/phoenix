#!/usr/bin/env python3
"""Inventory and inspect every archived production flash build, one image at a time.

No image is mounted or executed. Full compressed downloads are hashed, ext4 images
are read with debugfs, and only relevant original files survive in the external
scratch directory. Reports contain metadata/hashes, never vendor source or keys.
"""
import argparse
from contextlib import contextmanager
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
ORIGIN = "https://pvindex.org"
BUILD_BASE = "/repository/platformos/builds/"
PRODUCTION_DIRS = {"release-production", "ota-production-release"}
IMAGE_NAMES = {"rootfs.ext4": "rootfs", "services.ext4": "services",
               "skills.ext4": "skills", "var.ext4": "var"}


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def get(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()


def links(body):
    return [urllib.parse.unquote(x) for x in re.findall(r'href="([^"]+)"', body)
            if not x.startswith(("?", "/"))]


def inventory(out):
    listings = {}
    records = []
    directories = links(get(ORIGIN + BUILD_BASE).decode())
    for directory in directories:
        if not directory.endswith("/"):
            continue
        url = ORIGIN + BUILD_BASE + directory
        body = get(url)
        listings[url] = {"sha256": hashlib.sha256(body).hexdigest(), "links": links(body.decode())}
        candidates = [x for x in listings[url]["links"] if x.endswith(".tar.bz2") and
                      (directory.rstrip("/") in PRODUCTION_DIRS or
                       re.search(r'-(?:production|prod)\.tar\.bz2$', x))]
        if not candidates:
            continue
        sums = {}
        if "sha256.txt" in listings[url]["links"]:
            checksum_body = get(url + "sha256.txt")
            listings[url]["checksums_sha256"] = hashlib.sha256(checksum_body).hexdigest()
            for digest, filename in re.findall(r'^([0-9a-f]{64})\s+\*?(.+)$', checksum_body.decode(), re.M):
                sums[filename.strip()] = digest
        for filename in candidates:
            # One historical checksum names the EFT archive before it was renamed.
            expected = sums.get(filename)
            checksum_name = filename if expected else None
            if filename == "jibo-pvt-flash-build-5.4.0-production.tar.bz2" and not expected:
                checksum_name = "jibo-pvt-flash-build-EFT-production.tar.bz2"
                expected = sums.get(checksum_name)
            version = re.search(r'\d+\.\d+\.\d+', filename).group()
            label = filename.removesuffix(".tar.bz2").removeprefix("jibo-pvt-flash-build-").removeprefix("jibo-pvt-flash-")
            records.append({"label": label, "version": version, "url": url + filename,
                            "scope": "production", "expected_sha256": expected,
                            "checksum_filename": checksum_name})
    # The USB-flashed EFT build is a documented owner baseline, although the
    # stable-builds README describes that directory as development releases.
    records.append({"label": "5.4.0-EFT", "version": "5.4.0", "scope": "supplemental-owner-baseline",
                    "url": ORIGIN + BUILD_BASE + "stable-builds/jibo-pvt-flash-build-5.4.0-EFT.tar.bz2",
                    "expected_sha256": "d40989ec57721071ca819aad9a77b7b9102b48101d6d448d6ce4a869ef974864",
                    "checksum_filename": "jibo-pvt-flash-build-5.4.0-EFT.tar.bz2"})
    # These two early versions have only development flash archives. Inspect
    # them as supplemental variants, never present them as production images.
    for label, filename, version, checksum in [
        ("rtm2-dev-3.0.10", "jibo-pvt-flash-rtm2-dev-3.0.10.tar.bz2", "3.0.10",
         "e017a3c318bda420b8ff21b3d3972f00ded8b1ff193c007a9dc1dde941828ff2"),
        ("3.3.3-rtm3-dev", "jibo-pvt-flash-build-3.3.3-rtm3-dev.tar.bz2", "3.3.3",
         "2d66e1a35d8c84d4d800e961f653cb1dea49253a21886e3104e96ea4b5aab80c")]:
        records.append({"label": label, "version": version, "scope": "supplemental-development-variant",
                        "url": ORIGIN + BUILD_BASE + "release-dev/" + filename,
                        "expected_sha256": checksum, "checksum_filename": filename})
    records.sort(key=lambda x: (tuple(map(int, x["version"].split("."))), x["label"]))
    result = {"captured_at": now(), "origin": ORIGIN, "listings": listings, "archives": records}
    save(out, result)
    production_count = sum(r["scope"] == "production" for r in records)
    print(f"Inventoried {len(records)} archives ({production_count} production, {len(records)-production_count} supplemental)", flush=True)


class HashReader:
    def __init__(self, source):
        self.source = source
        self.digest = hashlib.sha256()
        self.size = 0

    def read(self, size=-1):
        data = self.source.read(size)
        self.digest.update(data)
        self.size += len(data)
        return data


@contextmanager
def uncompressed(reader, decompressor):
    if not decompressor:
        with tarfile.open(fileobj=reader, mode="r|bz2", bufsize=1024*1024) as archive:
            yield archive
        return
    # Limit the optional fast decompressor to two lower-priority workers. The
    # bounded pipes provide backpressure while each image is inspected.
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(["nice", "-n", "10", str(decompressor), "-dc", "-n", "2"],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors)
        failures = []
        def pump():
            try:
                while chunk := reader.read(1024*1024):
                    process.stdin.write(chunk)
            except Exception as error:
                failures.append(error)
            finally:
                try:
                    process.stdin.close()
                except BrokenPipeError:
                    pass
        thread = threading.Thread(target=pump, daemon=True)
        thread.start()
        try:
            with tarfile.open(fileobj=process.stdout, mode="r|", bufsize=1024*1024) as archive:
                yield archive
            while process.stdout.read(1024*1024):
                pass
            thread.join()
            if process.wait() or failures:
                errors.seek(0)
                raise RuntimeError("download/decompression failed: " + errors.read().decode() + str(failures))
        finally:
            if process.poll() is None:
                process.kill()
            process.wait()
            process.stdout.close()
            thread.join(timeout=5)


def dbg(image, command, binary=False):
    result = subprocess.run(["debugfs", "-R", command, str(image)], capture_output=True, check=True)
    return result.stdout if binary else result.stdout.decode("utf8", "replace")


def stat(image, path):
    text = dbg(image, "stat " + path)
    match = re.search(r'Type:\s+(\w+)\s+Mode:\s+(\d+)', text)
    return {"type": match[1], "mode": match[2]} if match else None


def capture(image, path, mount, objects, files):
    info = stat(image, path)
    if not info or info["type"] != "regular":
        return None
    body = dbg(image, "cat " + path, binary=True)
    digest = hashlib.sha256(body).hexdigest()
    target = objects / digest
    if not target.exists():
        target.write_bytes(body)
    item = {"path": mount + path, "sha256": digest, "bytes": len(body), **info}
    files.append(item)
    return body


def probe_image(image, part, objects, work):
    files = []
    facts = {"files": files}
    mount = {"rootfs": "", "services": "/usr/local", "skills": "/opt", "var": "/var"}[part]
    keep = {
        "rootfs": ["/etc/fstab", "/etc/ssh/sshd_config", "/usr/bin/jibo-setmode", "/usr/bin/jibo-getmode",
                   "/usr/bin/jibo-mount", "/usr/lib/node_modules/@jibo/jibo-ota-updater/src/download-update.js",
                   "/usr/lib/node_modules/@jibo/jibo-ota-updater/src/get-update.js"],
        "services": ["/bin/jibo-system-backup", "/bin/jibo-system-restore", "/etc/jibo-server-service.json",
                     "/etc/jibo-jetstream-service.json", "/etc/jibo-system-manager.json",
                     "/etc/jibo-ssm.json", "/bin/jibo-ssm/index.js", "/bin/jibo-ssm/lib/skills-service-manager.js", "/bin/jibo-ssm/package.json"],
        "skills": ["/jibo/Jibo/Skills/oobe-config/config.json", "/jibo/Jibo/Skills/oobe-config/package.json",
                   "/jibo/Jibo/Skills/oobe-config/assets/oobe/oobe.js", "/jibo/Jibo/Skills/oobe-config/oobe-config.js"],
        "var": [],
    }[part]
    for path in keep:
        capture(image, path, mount, objects, files)
    if part == "rootfs":
        for path, key, pattern in [("/usr/bin/node", "node_version", rb'\bv(\d+\.\d+\.\d+)\x00'),
                                   ("/usr/bin/jibo-version", "release", rb'Release-[0-9][0-9A-Za-z.\-]*'),
                                   ("/usr/sbin/sshd", "ssh_version", rb'OpenSSH_[0-9]+\.[0-9]+p?[0-9]*')]:
            body = dbg(image, "cat " + path, binary=True)
            found = re.search(pattern, body)
            facts[key] = found[1 if key == "node_version" else 0].decode() if found else None
        bundle = dbg(image, "cat /etc/ssl/certs/ca-certificates.crt", binary=True)
        bundle_hash = hashlib.sha256(bundle).hexdigest()
        if bundle and not (objects / bundle_hash).exists():
            (objects / bundle_hash).write_bytes(bundle)
        facts["ca_bundle"] = {"bytes": len(bundle), "certificates": bundle.count(b'BEGIN CERTIFICATE'),
                              "sha256": bundle_hash}
        facts["tools"] = {name: next((d + "/" + name for d in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
                                      if stat(image, d + "/" + name)), None)
                          for name in ["curl", "sha256sum", "find", "mktemp", "blockdev", "resize2fs", "jibo-getmode", "jibo-setmode", "jibo-version"]}
        facts["ota_executable"] = dbg(image, "stat /usr/bin/jibo-download-update").strip()
        for row in dbg(image, "ls -p /etc/init.d").splitlines():
            fields = row.split("/")
            if len(fields) > 5 and "firewall" in fields[5]:
                capture(image, "/etc/init.d/" + fields[5], mount, objects, files)
    if part == "services":
        library = dbg(image, "cat /lib/libJiboSystemManager.so", binary=True)
        facts["native_manager"] = {"bytes": len(library), "sha256": hashlib.sha256(library).hexdigest(),
                                  "update_routes": sorted(set(x.decode() for x in re.findall(rb'\^/update[^\x00]{0,70}', library))),
                                  "query_helpers": sorted(set(x.decode() for x in re.findall(rb'/usr/bin/jibo-[a-z-]+', library)))}
    scan_roots = {"rootfs": ["/usr/lib/node_modules", "/bin/jibo-ssm"], "services": ["/bin/jibo-ssm"],
                  "skills": ["/jibo/Jibo/Skills"], "var": []}[part]
    for base in scan_roots:
        if not stat(image, base):
            continue
        dest = work / "tree"
        dest.mkdir()
        dbg(image, f"rdump {base} {dest}")
        extracted = dest / Path(base).name
        try:
            for config in sorted(extracted.rglob("region_config.json")):
                if not str(config).endswith("/jibo-server-client/lib/region_config.json"):
                    continue
                library = config.parent
                for target in [config, library / "http/node.js", library.parent / "package.json"]:
                    if not target.is_file() or target.is_symlink():
                        continue
                    body = target.read_bytes()
                    digest = hashlib.sha256(body).hexdigest()
                    if not (objects / digest).exists():
                        (objects / digest).write_bytes(body)
                    files.append({"path": mount + base + "/" + str(target.relative_to(extracted)),
                                  "sha256": digest, "bytes": len(body), "type": "regular",
                                  "mode": format(target.stat().st_mode & 0o777, "04o")})
                # Load the replacement against the actual archived core, http,
                # utility code and module dependencies before discarding the tree.
                facts.setdefault("client_roots", []).append(str(library.parent))
            # Run archive-backed checks while the original client trees exist.
            runtime = os.environ.get("PHOENIX_AUDIT_NODE")
            if runtime and facts.get("client_roots"):
                run = subprocess.run([runtime, str(HERE / "verify-stock.cjs"), "clients", str(REPO),
                                      *facts.pop("client_roots")], capture_output=True, text=True)
                facts.setdefault("client_checks", []).append({"exit_code": run.returncode, "stdout": run.stdout.strip(), "stderr": run.stderr.strip()})
        finally:
            shutil.rmtree(dest)
    facts.pop("client_roots", None)
    return facts


def audit(record, output, scratch, node4, node6, decompressor=None):
    started = time.monotonic()
    report = {**record, "started_at": now(), "images": {}, "status": "running"}
    report_path = output / (record["label"] + ".json")
    objects = scratch / "objects"
    objects.mkdir(exist_ok=True)
    print(f"{now()} {record['label']}: downloading", flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix="image-", dir=scratch) as temporary:
            work = Path(temporary)
            with urllib.request.urlopen(record["url"], timeout=120) as source:
                reader = HashReader(source)
                expected_size = int(source.headers.get("Content-Length", "0"))
                with uncompressed(reader, decompressor) as archive:
                    for member in archive:
                        name = Path(member.name).name
                        if name not in IMAGE_NAMES or not member.isfile():
                            continue
                        part = IMAGE_NAMES[name]
                        if part in report["images"]:
                            raise RuntimeError("duplicate image: " + part)
                        if shutil.disk_usage(scratch).free < member.size + 256*1024*1024:
                            raise RuntimeError(f"insufficient free space for {part}: {member.size} bytes plus reserve")
                        print(f"{now()} {record['label']}: reading {part} ({member.size} bytes)", flush=True)
                        target = work / name
                        image_hash = hashlib.sha256()
                        incoming = archive.extractfile(member)
                        with target.open("wb") as destination:
                            while chunk := incoming.read(1024*1024):
                                image_hash.update(chunk)
                                if chunk.count(0) == len(chunk):
                                    destination.seek(len(chunk), os.SEEK_CUR)
                                else:
                                    destination.write(chunk)
                            destination.truncate(member.size)
                        if part == "rootfs":
                            node = dbg(target, "cat /usr/bin/node", binary=True)
                            os.environ["PHOENIX_AUDIT_NODE"] = str(node4 if b'v4.1.2\x00' in node else node6)
                            report["runtime"] = os.environ["PHOENIX_AUDIT_NODE"]
                        elif "runtime" not in report:
                            os.environ["PHOENIX_AUDIT_NODE"] = str(node4 if record["version"].startswith("3.") else node6)
                        report["images"][part] = {"archive_member": member.name, "bytes": member.size,
                                                   "sha256": image_hash.hexdigest(), **probe_image(target, part, objects, work)}
                        target.unlink()
                        save(report_path, report)
                # tar EOF does not imply HTTP EOF. Hash and count every compressed byte.
                while reader.read(1024*1024):
                    pass
                report["download_bytes"] = reader.size
                report["archive_sha256"] = reader.digest.hexdigest()
                if expected_size and reader.size != expected_size:
                    raise RuntimeError("truncated HTTP download")
                if record["expected_sha256"] and report["archive_sha256"] != record["expected_sha256"]:
                    raise RuntimeError("archive failed published SHA-256 check")
                report["published_checksum_verified"] = bool(record["expected_sha256"])
            missing = {"rootfs", "services", "skills"} - report["images"].keys()
            if missing:
                raise RuntimeError("missing images: " + ", ".join(sorted(missing)))
            runtime = report["runtime"]
            run = subprocess.run([runtime, str(HERE / "verify-stock.cjs"), "files", str(REPO), str(report_path), str(objects)],
                                 capture_output=True, text=True)
            report["file_checks"] = {"exit_code": run.returncode, "stdout": run.stdout.strip(), "stderr": run.stderr.strip()}
            report["status"] = "passed" if run.returncode == 0 and all(check["exit_code"] == 0
                for info in report["images"].values() for check in info.get("client_checks", [])) else "failed-checks"
    except Exception as error:
        report["status"] = "error"
        report["error"] = str(error)
    report["finished_at"] = now()
    report["seconds"] = round(time.monotonic() - started, 1)
    save(report_path, report)
    print(f"{now()} {record['label']}: {report['status']} ({report['seconds']}s) {report.get('error', '')}", flush=True)
    return report["status"] == "passed"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--refresh-inventory", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--scratch", type=Path)
    parser.add_argument("--node4", type=Path)
    parser.add_argument("--node6", type=Path)
    parser.add_argument("--decompressor", type=Path, help="optional lbzip2 binary (two low-priority workers)")
    parser.add_argument("--label", action="append")
    parser.add_argument("--recheck", action="store_true", help="rerun checks using retained originals without downloading")
    parser.add_argument("--force-download", action="store_true", help="download selected archives again even if a complete report exists")
    args = parser.parse_args()
    if args.node6:
        os.environ["PHOENIX_AUDIT_NODE6"] = str(args.node6)
    if args.refresh_inventory:
        inventory(args.inventory)
    if not args.output:
        return
    if not args.scratch or not args.node4 or not args.node6:
        parser.error("auditing requires --scratch, --node4 and --node6")
    args.output.mkdir(parents=True, exist_ok=True)
    args.scratch.mkdir(parents=True, exist_ok=True)
    records = json.loads(args.inventory.read_text())["archives"]
    unknown = set(args.label or []) - {record["label"] for record in records}
    if unknown:
        parser.error("unknown archive labels: " + ", ".join(sorted(unknown)))
    failures = 0
    for record in records:
        if args.label and record["label"] not in args.label:
            continue
        prior = args.output / (record["label"] + ".json")
        if args.recheck:
            if not prior.exists():
                print(record["label"], "missing report; download it first", flush=True)
                failures += 1
                continue
            report = json.loads(prior.read_text())
            runtime = args.node4 if report["images"].get("rootfs", {}).get("node_version") == "4.1.2" else args.node6
            run = subprocess.run([str(runtime), str(HERE / "verify-stock.cjs"), "files", str(REPO), str(prior), str(args.scratch / "objects")],
                                 capture_output=True, text=True)
            report["file_checks"] = {"exit_code": run.returncode, "stdout": run.stdout.strip(), "stderr": run.stderr.strip()}
            if "archive_sha256" in report and report["status"] in ("passed", "failed-checks"):
                clients_ok = all(check["exit_code"] == 0 for image in report["images"].values()
                                 for check in image.get("client_checks", []))
                report["status"] = "passed" if run.returncode == 0 and clients_ok else "failed-checks"
            save(prior, report)
            failures += report["status"] != "passed"
            print(record["label"], report["status"], flush=True)
        elif not args.force_download and prior.exists() and json.loads(prior.read_text()).get("status") in ("passed", "failed-checks"):
            failures += json.loads(prior.read_text())["status"] != "passed"
            print(record["label"], "already downloaded; use --recheck to rerun", flush=True)
        else:
            failures += not audit(record, args.output, args.scratch, args.node4, args.node6, args.decompressor)
    raise SystemExit(1 if failures else 0)


if __name__ == "__main__":
    main()
