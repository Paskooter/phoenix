#!/usr/bin/env python3
"""Verify pinned Pegasus / jibo-nlu-data sources through the Jibo archive MCP.

Emits the report consumed by docs/parity/evidence/2026-09-11/n03-clock-settings-menu/archive-verification.json
Run: python3 archive-verify.py > archive-verification.json

The portal prepends a `# <repo>:<path>` attribution line and a blank line to
every gitea_read_file body and adds one trailing newline; both are removed before
comparison (the same normalisation N-02/N-05 used).
"""
import hashlib
import json
import subprocess
import sys

MCP = "https://pvindex.org/mcp"
REF = "5c0a7390539663ba749d360de348a428c088505c"
FILES = [
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/clock/alarm_timer_ampm.rule",
     "packages/nlu/resources/rules-src/clock/alarm_timer_ampm.rule"),
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/clock/alarm_set_value.rule",
     "packages/nlu/resources/rules-src/clock/alarm_set_value.rule"),
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/clock/alarm_timer_change.rule",
     "packages/nlu/resources/rules-src/clock/alarm_timer_change.rule"),
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/clock/timer_set_value.rule",
     "packages/nlu/resources/rules-src/clock/timer_set_value.rule"),
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/settings/volume_control.rule",
     "packages/nlu/resources/rules-src/settings/volume_control.rule"),
    ("jiboV2/pegasus", REF, "packages/parser/robust-parser/rules_src/main-menu/execute_main_menu.rule",
     "packages/nlu/resources/rules-src/main-menu/execute_main_menu.rule"),
    ("ConvTech/jibo-nlu-data", "master", "en-us/factory_rules/time.grm",
     "packages/nlu/resources/factory-sources/time.grm"),
]


def call(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}})
    out = subprocess.run(
        ["curl", "-sS", "-m", "60", "-X", "POST", MCP,
         "-H", "content-type: application/json",
         "-H", "accept: application/json, text/event-stream", "-d", body],
        capture_output=True, text=True, check=True).stdout
    if out.lstrip().startswith(("event:", "data:")):
        for line in out.splitlines():
            if line.startswith("data:"):
                out = line[5:].strip()
                break
    data = json.loads(out)
    if "error" in data:
        raise RuntimeError(data["error"])
    return "".join(c.get("text", "") for c in data["result"]["content"])


report = {"schema": "phoenix.nlu.n03-archive-verification", "mcp": MCP,
          "referenceRevision": REF, "files": []}
for repo, ref, path, local in FILES:
    raw = call("gitea_read_file", {"repo": repo, "path": path, "ref": ref})
    lines = raw.split("\n")
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    archived = "\n".join(lines).lstrip("\n")
    if archived.endswith("\n"):
        archived = archived[:-1]
    vendored = open(local, encoding="utf-8").read().rstrip("\n")
    entry = {
        "repo": repo, "ref": ref, "path": path, "vendored": local,
        "identical": archived == vendored,
        "archivedBytes": len(archived.encode()),
        "vendoredBytes": len(vendored.encode()),
        "vendoredSha256": hashlib.sha256(vendored.encode()).hexdigest(),
    }
    report["files"].append(entry)

report["identicalCount"] = sum(1 for f in report["files"] if f["identical"])
json.dump(report, sys.stdout, indent=1)
sys.stdout.write("\n")
