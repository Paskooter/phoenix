#!/usr/bin/env python3
"""Structural diff between the pinned-original and Phoenix S-02 receipts.

Normalization only removes values that are knowingly volatile:
  * generated session ids (`id` uuid strings) and generated JCP transaction ids
    (32 lowercase hex, jibo-command-requester UUID.generateTransactionID)
  * `msgID` / `ts`

Nothing else is rewritten -- in particular error messages are compared
byte-for-byte, including the Node 8 spelling of null/undefined property-access
errors ("Cannot read property 'x' of undefined"), which Phoenix localizes
(with no-rewrite mode the two receipts still diff to 0).
"""
import json
import re
import sys

HERE = __file__.rsplit('/', 1)[0]
SOURCE = f"{HERE}/source-s02-contract.json"
PHOENIX = f"{HERE}/phoenix-s02-contract.json"

UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
TRANSACTION_ID = re.compile(r"^[0-9a-f]{32}$")

# probe -> reason it cannot be compared cell-by-cell. Each is an accepted,
# documented deployment-shape difference, never a hidden functional one.
ACCEPTED = {}


def normalize(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k in ("msgID", "ts") and isinstance(v, (str, int)):
                out[k] = "<volatile>"
                continue
            if k == "id" and isinstance(v, str):
                if UUID.match(v):
                    out[k] = "<session-id>"
                    continue
                if TRANSACTION_ID.match(v):
                    out[k] = "<generated-jcp-id>"
                    continue
            out[k] = normalize(v)
        return out
    if isinstance(obj, list):
        return [normalize(v) for v in obj]
    if isinstance(obj, str):
        if UUID.match(obj):
            return "<session-id>"
        if TRANSACTION_ID.match(obj):
            return "<generated-jcp-id>"
        return obj
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
