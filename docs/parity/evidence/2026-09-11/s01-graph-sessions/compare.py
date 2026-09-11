#!/usr/bin/env python3
"""Structural diff between the pinned-original and Phoenix S-01 receipts.

Normalization only removes values that are knowingly volatile:
  * generated session ids (`id` uuid strings), `msgID`, `ts`
Nothing else is rewritten, so an error-string or shape difference is a diff.

Accepted deployment-shape divergences are listed in ACCEPTED with the reason
they cannot be compared cell-by-cell; every one of them is called out in
README.md. Any other difference is reported as a real DIFF and exits 1.
"""
import json
import re
import sys

HERE = __file__.rsplit('/', 1)[0]
SOURCE = f"{HERE}/source-graph-contract.json"
PHOENIX = f"{HERE}/phoenix-graph-contract.json"

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# probe -> reason it cannot be compared cell-by-cell. Each is an accepted,
# documented deployment-shape difference, never a hidden functional one.
ACCEPTED = {
    "manager.constructorLocked":
        "original enforces a process-wide singleton with a locked constructor; "
        "Phoenix allows explicit managers so a cohosted host can opt into one. "
        "Probe is informational, not a functional contract.",
    "manager.singletonIdentity":
        "original exposes GraphManager.instance + _resetInstance; Phoenix exports "
        "sharedGraphManager plus per-skill managers.",
    "graphskill.wireRouterShape":
        "original skills are express routers inside BaseHttpHandler; Phoenix skills "
        "are plain async handlers wrapped by skillRoute.",
}


def normalize(obj, path=()):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("msgID", "ts") and isinstance(v, (str, int)):
                out[k] = "<volatile>"
                continue
            if k == "id" and isinstance(v, str) and UUID.match(v):
                out[k] = "<session-id>"
                continue
            out[k] = normalize(v, path + (k,))
        return out
    if isinstance(obj, list):
        return [normalize(v, path + (i,)) for i, v in enumerate(obj)]
    if isinstance(obj, str) and UUID.match(obj):
        return "<session-id>"
    return obj


def flatten(obj, prefix="", out=None):
    out = {} if out is None else out
    if isinstance(obj, dict):
        for k, v in obj.items():
            flatten(v, f"{prefix}.{k}" if prefix else k, out)
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            flatten(v, f"{prefix}[{i}]", out)
    else:
        out[prefix] = obj
    return out


def main():
    src = json.load(open(SOURCE))
    phx = json.load(open(PHOENIX))
    names = sorted(set(k for k in src if k != "__meta") | set(k for k in phx if k != "__meta"))

    diffs = []
    accepted = []
    compared = 0

    for name in names:
        if name in ACCEPTED:
            accepted.append((name, ACCEPTED[name]))
            continue
        s = normalize(src.get(name))
        p = normalize(phx.get(name))
        if s is None or p is None:
            diffs.append((name, "<missing>", json.dumps(s), json.dumps(p)))
            continue
        compared += 1
        fs, fp = flatten(s), flatten(p)
        keys = sorted(set(fs) | set(fp))
        cell = []
        for k in keys:
            if fs.get(k, "<absent>") != fp.get(k, "<absent>"):
                cell.append((k, fs.get(k, "<absent>"), fp.get(k, "<absent>")))
        for k, a, b in cell:
            diffs.append((name, k, json.dumps(a), json.dumps(b)))

    print(f"compared probes: {compared}")
    print(f"accepted (deployment-shape): {len(accepted)}")
    for name, reason in accepted:
        print(f"  ~ {name}: {reason}")
    print(f"DIFFS ({len(diffs)})")
    for name, k, a, b in diffs:
        print(f"  ! {name} :: {k}\n      source : {a}\n      phoenix: {b}")
    return 1 if diffs else 0


if __name__ == "__main__":
    sys.exit(main())
