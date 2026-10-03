#!/usr/bin/env python3
"""Run repoint dry-runs and optional OOBE applies through a local SSH adapter.

SSH/login, mounts, mode and available /opt space are fixtures. File discovery,
source hashes, configuration reads, uploads and Node preflights use the original
archive files. No network connection, server adoption, OTA or reboot is allowed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def ssh_adapter():
    args = sys.argv[2:]
    root = Path(os.environ["PHOENIX_AUDIT_ROOT"])
    control = next((x.split("=", 1)[1] for x in args if x.startswith("ControlPath=")), None)
    if args and args[0] == "-G":
        print("hostname 192.0.2.15\nport 22")
        return 0
    if "-O" in args:
        if control:
            Path(control).unlink(missing_ok=True)
        return 0
    if "ControlMaster=yes" in args:
        connection = socket.socket(socket.AF_UNIX)
        connection.bind(control)
        return 0
    if not control or not Path(control).is_socket():
        raise RuntimeError("command without a local control socket")
    command = args[-1]
    denied = ["reboot", "curl ", "wget "]
    if os.environ.get("PHOENIX_AUDIT_APPLY") != "1":
        denied.extend(["mount -o", "jibo-setmode"])
    if any(x in command for x in denied):
        raise RuntimeError("dry-run attempted a prohibited command: " + command)
    original_command = command
    def redirect(match):
        # Mount-output selectors match robot mountpoints, not host paths.
        if original_command[max(0, match.start() - 4):match.start()] == " on ":
            return match.group()
        return str(root) + match.group()
    command = re.sub(r'(?<![\w])/(usr|etc|var|opt|tmp)(?=/|[\s\'\"]|$)', redirect, command)
    result = subprocess.run(["bash", "-c", command], input=sys.stdin.buffer.read(), capture_output=True)
    sys.stdout.buffer.write(result.stdout.replace(str(root).encode(), b""))
    sys.stderr.buffer.write(result.stderr.replace(str(root).encode(), b""))
    return result.returncode


PRELOAD = r"""
'use strict';
var fs = require('fs');
var root = process.env.PHOENIX_AUDIT_ROOT;
function redirect(value) {
  if (typeof value !== 'string' || value === root || value.indexOf(root + '/') === 0 || root.indexOf(value + '/') === 0) return value;
  return /^\/(usr|etc|var|opt|tmp)(\/|$)/.test(value) ? root + value : value;
}
Object.keys(fs).forEach(function(key) {
  if (typeof fs[key] !== 'function') return;
  var original = fs[key];
  fs[key] = function() {
    var args = Array.prototype.slice.call(arguments);
    args[0] = redirect(args[0]);
    if (key === 'renameSync' || key === 'linkSync') args[1] = redirect(args[1]);
    return original.apply(fs, args);
  };
});
"""


def executable(path, body):
    path.write_text(body)
    path.chmod(0o755)


def snapshot(root):
    return {str(p.relative_to(root)): (hashlib.sha256(p.read_bytes()).hexdigest(), p.stat().st_mode & 0o777)
            for p in root.rglob("*") if p.is_file() and not str(p.relative_to(root)).startswith("tmp/")}


def audit(report, objects, node4, node6, apply_oobe=False):
    rootfs = report["images"]["rootfs"]
    runtime = node4 if rootfs["node_version"] == "4.1.2" else node6
    results = {}
    for paired in [False, True]:
        with tempfile.TemporaryDirectory(prefix="shell-", dir=objects.parent) as temporary:
            root = Path(temporary)
            shim = root / "shim"
            shim.mkdir()
            (root / "tmp").mkdir()
            bundle = root / "etc/ssl/certs/ca-certificates.crt"
            bundle.parent.mkdir(parents=True)
            ca_original = objects / rootfs["ca_bundle"]["sha256"]
            if apply_oobe and not ca_original.exists():
                raise RuntimeError("original CA bundle was not retained; redownload one image with this bundle hash")
            if ca_original.exists():
                bundle.write_bytes(ca_original.read_bytes())
            for part in report["images"].values():
                for item in part["files"]:
                    dest = root / item["path"].lstrip("/")
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    dest.write_bytes((objects / item["sha256"]).read_bytes())
                    dest.chmod(int(item["mode"], 8))
            credentials = root / "var/jibo/credentials.json"
            credentials.parent.mkdir(parents=True, exist_ok=True)
            mode_file = root / "var/jibo/mode.json"
            mode_file.write_text('{"mode":"int-developer"}')
            if paired:
                credentials.write_text(json.dumps({"accessKeyId": "A" * 20, "secretAccessKey": "B" * 40, "region": "api"}))
                credentials.chmod(0o600)
            preload = root / "preload.cjs"
            preload.write_text(PRELOAD)
            executable(shim / "node", "#!/bin/bash\nexec " + shlex.quote(str(runtime)) + " --require " + shlex.quote(str(preload)) + ' "$@"\n')
            executable(shim / "ssh", "#!/bin/bash\nexec " + shlex.quote(sys.executable) + " " + shlex.quote(str(HERE / "shell-audit.py")) + ' --ssh "$@"\n')
            executable(shim / "hostname", "#!/bin/bash\nprintf '%s\\n' Stock-Firmware-Audit\n")
            executable(shim / "jibo-getmode", "#!" + sys.executable + "\nimport json,os\nfrom pathlib import Path\nprint(json.loads((Path(os.environ['PHOENIX_AUDIT_ROOT'])/'var/jibo/mode.json').read_text())['mode'])\n")
            executable(shim / "jibo-setmode", "#!" + sys.executable + "\nimport json,os,sys\nfrom pathlib import Path\n(Path(os.environ['PHOENIX_AUDIT_ROOT'])/'var/jibo/mode.json').write_text(json.dumps({'mode':sys.argv[1]}))\n")
            executable(shim / "jibo-version", "#!/bin/bash\nprintf '%s\\n' " + shlex.quote(rootfs["release"]) + "\n")
            # Runtime mount/free-space facts cannot come from an offline ext4
            # archive. Both fixtures are explicit in each result below.
            fstab = root / "etc/fstab"
            local_ro = any('/usr/local' in line and 'ro' in line.split()[3].split(',')
                           for line in fstab.read_text().splitlines() if line.startswith('/dev/') and len(line.split()) >= 4)
            mount_state = root / "tmp/mount-state.json"
            initial_mounts = {"/": "ro", "/usr/local": "ro" if local_ro else "rw"}
            mount_state.write_text(json.dumps(initial_mounts))
            executable(shim / "mount", "#!" + sys.executable + "\n" + '''import json,os,sys
from pathlib import Path
root=Path(os.environ['PHOENIX_AUDIT_ROOT']); file=root/'tmp/mount-state.json'; state=json.loads(file.read_text())
if len(sys.argv)>1:
    dest=sys.argv[-1].removeprefix(str(root)) or '/'
    if len(sys.argv)!=4 or sys.argv[1]!='-o' or dest not in state or sys.argv[2] not in ['remount,ro','remount,rw']:
        raise SystemExit('unsupported fixture mount command')
    state[dest]=sys.argv[2].split(',')[1]; file.write_text(json.dumps(state))
else:
    print('/dev/root on / type ext4 ('+state['/']+',relatime)')
    print('/dev/mmcblk0p4 on /usr/local type ext4 ('+state['/usr/local']+',relatime)')
    print('/dev/mmcblk0p6 on /opt type ext4 (rw,relatime)')
''')
            executable(shim / "df", "#!/bin/bash\nprintf '%s\\n' 'Filesystem 1K-blocks Used Available Use% Mounted on' '/dev/mmcblk0p6 5000000 1000000 4000000 20% /opt'\n")
            before = snapshot(root)
            run = subprocess.run(["bash", str(REPO / "scripts/robot-ota-repoint.sh"), "--robot", "root@192.0.2.15",
                                  "--auto", "--claim-code", "A" * 43, "--dry-run"], capture_output=True, text=True,
                                 timeout=90, env={**os.environ, "PATH": str(shim) + os.pathsep + os.environ["PATH"],
                                                  "PHOENIX_AUDIT_ROOT": str(root)})
            unchanged = before == snapshot(root)
            results["paired" if paired else "oobe"] = {"exit_code": run.returncode,
                "files_unchanged": unchanged, "runtime": rootfs["node_version"],
                "fixtures": {"ssh": "local authenticated adapter", "mode": "int-developer", "opt_free_kib": 4000000},
                "stdout": run.stdout, "stderr": run.stderr,
                "passed": run.returncode == 0 and unchanged and "dry run — nothing was changed" in run.stdout}
            if apply_oobe and not paired:
                key = root / "var/jibo/keys/audit-key"
                key.parent.mkdir(mode=0o700)
                key.write_text("synthetic key material; never a robot identity")
                key.chmod(0o600)
                key_hash = hashlib.sha256(key.read_bytes()).hexdigest()
                apply_results = []
                for repeat in range(2):
                    applied = subprocess.run(["bash", str(REPO / "scripts/robot-ota-repoint.sh"), "--robot", "root@192.0.2.15",
                                              "--auto", "--yes", "--no-reboot"], capture_output=True, text=True, timeout=120,
                        env={**os.environ, "PATH": str(shim) + os.pathsep + os.environ["PATH"],
                             "PHOENIX_AUDIT_ROOT": str(root), "PHOENIX_AUDIT_APPLY": "1"})
                    mounts_restored = json.loads(mount_state.read_text()) == initial_mounts
                    keys_preserved = hashlib.sha256(key.read_bytes()).hexdigest() == key_hash and key.parent.stat().st_mode & 0o777 == 0o700
                    expected_bundle = ca_original.read_bytes() + (REPO / "scripts/robot-client/isrg-root-x1.pem").read_bytes()
                    trust_matches = bundle.read_bytes() == expected_bundle and (root / "etc/ssl/cert.pem").resolve() == bundle
                    completed = "OOBE mode and absent credentials verified" in applied.stdout
                    apply_results.append({"exit_code": applied.returncode, "mounts_restored": mounts_restored,
                        "keys_preserved": keys_preserved, "trust_matches": trust_matches, "stdout": applied.stdout,
                        "stderr": applied.stderr, "passed": applied.returncode == 0 and mounts_restored and keys_preserved and trust_matches and completed})
                results["oobe_apply"] = {"fixtures": {"mounts": "simulated remounts; no host filesystem mounted", "reboot": "disabled", "mode": "isolated JSON file"},
                                          "runs": apply_results, "passed": all(x["passed"] for x in apply_results)}
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports", type=Path, required=True)
    parser.add_argument("--objects", type=Path, required=True)
    parser.add_argument("--node4", type=Path, required=True)
    parser.add_argument("--node6", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--label", action="append")
    parser.add_argument("--apply-oobe", action="store_true", help="also apply twice without adoption, OTA or reboot in the isolated tree")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sources = sorted(args.reports.glob("*.json"))
    unknown = set(args.label or []) - {source.stem for source in sources}
    if unknown:
        parser.error("unknown archive labels: " + ", ".join(sorted(unknown)))
    failed = False
    for source in sources:
        report = json.loads(source.read_text())
        if report["status"] not in ("passed", "failed-checks") or (args.label and report["label"] not in args.label):
            continue
        dest = args.output / source.name
        if dest.exists():
            prior = json.loads(dest.read_text())
            if prior["passed"] and (not args.apply_oobe or "oobe_apply" in prior["results"]):
                continue
        try:
            results = audit(report, args.objects, args.node4, args.node6, args.apply_oobe)
        except RuntimeError as error:
            print(report["label"], "pending:", error, flush=True)
            failed = True
            continue
        passed = all(x["passed"] for x in results.values())
        dest.write_text(json.dumps({"label": report["label"], "passed": passed, "results": results}, indent=2) + "\n")
        print(report["label"], "passed" if passed else "FAILED", flush=True)
        failed = failed or not passed
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(ssh_adapter() if len(sys.argv) > 1 and sys.argv[1] == "--ssh" else main())
