#!/usr/bin/env python3
"""Provision, execute and record the isolated original Pegasus reference.

Requires local Git source objects, Python 3.10+, Node for Yarn, Docker, and
archive access on first use. Execution itself has no external network.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / ".parity"
PINS = json.loads((ROOT / "docs/parity/evidence/2026-09-05/compatibility-pins.json").read_text())
REVISION = PINS["originalCommit"]
IMAGE = PINS["nodeDockerImage"]["resolved"]


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT.parent / "pegasus")
    parser.add_argument("--out", type=Path, default=CACHE / "runs/reference")
    parser.add_argument("--skip-install", action="store_true", help="Use the already installed pinned dependency closure")
    parser.add_argument("--docker-host", default="unix:///var/run/docker.sock")
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = args.source.resolve()
    ref = CACHE / "reference" / REVISION
    docker = ["docker", "-H", args.docker_host]
    commands = []
    record = {"date": datetime.now(timezone.utc).isoformat(), "referenceRevision": REVISION,
              "image": IMAGE, "source": str(source), "commands": commands, "result": "fail"}

    def step(name, argv, timeout=180):
        commands.append({"name": name, "argv": [str(a) for a in argv], "shellDisplay": shlex.join(map(str, argv))})
        print(name, flush=True)
        with (output / (name + ".log")).open("w") as log:
            result = subprocess.run(argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
        commands[-1]["exitCode"] = result.returncode
        if result.returncode:
            raise RuntimeError(name + " failed; see " + str(output / (name + ".log")))

    def container(name, argv):
        container_name = "phoenix-parity-" + uuid.uuid4().hex[:12]
        command = docker + ["run", "--rm", "--name", container_name, "--network", "none",
                           "--mount", "type=bind,source=" + str(CACHE) + ",target=/parity",
                           "--mount", "type=bind,source=" + str(ROOT / "scripts/parity-reference") + ",target=/harness,readonly",
                           "--mount", "type=bind,source=" + str(output) + ",target=/evidence", IMAGE] + argv
        try:
            step(name, command, timeout=90)
        except subprocess.TimeoutExpired:
            # Only the uniquely named container created by this invocation.
            subprocess.run(docker + ["rm", "--force", container_name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
            raise

    try:
        step("prepare", [sys.executable, ROOT / "scripts/parity-reference/prepare.py", "--source", source])
        if not args.skip_install:
            step("install", ["node", CACHE / "tools/yarn-1.5.1/bin/yarn.js", "--cwd", ref, "install", "--production",
                             "--frozen-lockfile", "--ignore-scripts", "--ignore-engines", "--non-interactive",
                             "--registry", "https://pvindex.org/npm/", "--cache-folder", CACHE / "yarn-cache", "--network-concurrency", "8"], timeout=300)
        else:
            if not (ref / "node_modules/.yarn-integrity").exists():
                raise RuntimeError("Pinned dependency installation is missing; omit --skip-install")
            record["installation"] = "Existing production dependency closure; see installation.json"
        step("image", docker + ["image", "inspect", IMAGE, "--format", "{{.Id}}"])
        record["imageId"] = (output / "image.log").read_text().strip()
        container("compile", ["node", "/harness/compile.cjs", "/parity/reference/" + REVISION, "/parity/tools/typescript-2.5.3"])
        compiled = json.loads((ref / "parity-compiled.json").read_text())
        # Check emitted inputs against immutable Git objects before accepting an
        # oracle result. Reference code edits cannot silently change the golden.
        for file, expected in compiled["inputs"].items():
            original = subprocess.check_output(["git", "-C", str(source), "show", REVISION + ":" + file])
            if hashlib.sha256(original).hexdigest() != expected:
                raise RuntimeError("Compiled input differs from original source: " + file)
        workspaces = json.loads((ref / "package.json").read_text())["workspaces"]
        for workspace in workspaces:
            file = workspace + "/package.json"
            original = subprocess.check_output(["git", "-C", str(source), "show", REVISION + ":" + file])
            if original != (ref / file).read_bytes():
                raise RuntimeError("Original service manifest changed: " + file)
        record["sourceIntegrity"] = {"compiledInputsVerified": len(compiled["inputs"]), "workspaceManifestsVerified": len(workspaces)}
        shutil.copyfile(ref / "parity-compiled.json", output / "compiled.json")
        shutil.copyfile(ref / "parity-prepared.json", output / "prepared.json")
        shutil.copyfile(ref / "node_modules/.yarn-integrity", output / "installation.json")
        container("capture", ["node", "/harness/capture.cjs", "/parity/reference/" + REVISION, "/evidence/transactions.json"])
        capture = json.loads((output / "transactions.json").read_text())
        if capture["result"] != "pass":
            raise RuntimeError("Reference fixture checks failed")
        for file, expected in compiled["outputs"].items():
            if sha(ref / file) != expected:
                raise RuntimeError("Emitted reference module changed during capture: " + file)
        record["result"] = "pass"
        record["transactions"] = len(capture["transactions"])
        record["fixtureChecks"] = len(capture["checks"])
        record["limitations"] = capture["exclusions"]
    except Exception as error:
        record["failure"] = str(error)
    record["artifacts"] = {p.name: sha(p) for p in sorted(output.iterdir()) if p.is_file() and p.name != "run.json"}
    (output / "run.json").write_text(json.dumps(record, indent=2) + "\n")
    print(json.dumps({k: record[k] for k in ["result", "transactions", "fixtureChecks", "failure"] if k in record}), flush=True)
    return 0 if record["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
