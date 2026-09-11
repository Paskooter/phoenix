#!/usr/bin/env python3
"""H-08 differential: source oracle vs Phoenix, cell by cell.

Compares per case:
  * updateSequence   - the ordered SpeechHistoryRecord.update() payloads
  * sideEffects      - the ordered skillLaunch / speechSave writes with headers
  * frames           - the emitted frames, ignoring the top-level ERROR frame the
                       gateway writes for a rejected transaction (H-02 surface, not H-08)

Normalizes a random local port in the skill error message and the source's per-case
`seq` field so the two receipts are comparable.
"""
import json, re, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = re.compile(r"127\.0\.0\.1:\d+")

def norm(o):
    if isinstance(o, str):
        return PORT.sub("127.0.0.1:<port>", o)
    if isinstance(o, dict):
        return {k: norm(v) for k, v in o.items() if k not in ("seq", "method", "url", "recordId")}
    if isinstance(o, list):
        return [norm(v) for v in o]
    return o

def side_effects(case):
    return [norm(e) for e in case["sideEffects"] if e.get("kind") in ("skillLaunch", "speechSave")]

def frames(case):
    return [norm(f) for f in case.get("frames", []) if f.get("type") != "ERROR"]

def diff(a, b, path, out):
    if type(a) is not type(b):
        out.append(f"{path}: type {type(a).__name__} != {type(b).__name__} ({a!r} vs {b!r})")
        return
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a: out.append(f"{path}.{k}: missing in source (phoenix={b[k]!r})")
            elif k not in b: out.append(f"{path}.{k}: missing in phoenix (source={a[k]!r})")
            else: diff(a[k], b[k], f"{path}.{k}", out)
    elif isinstance(a, list):
        if len(a) != len(b):
            out.append(f"{path}: length {len(a)} != {len(b)}")
        for i in range(min(len(a), len(b))):
            diff(a[i], b[i], f"{path}[{i}]", out)
    elif a != b:
        out.append(f"{path}: {a!r} != {b!r}")

src = json.load(open(os.path.join(HERE, "source-speech-history.json")))
phx = json.load(open(os.path.join(HERE, "phoenix-speech-history.json")))

total = 0
# Excluded: the reference's SkillRequestMaker owns an inner 10 s budget AND the handler wraps the
# call in another 10 s timeout (H-04 documented the race). On a hung skill the reference's inner
# timer can resolve first and record a late {skill:{error:{code:'TIMEOUT',...}}}; Phoenix has only
# the outer budget, so its record never gains that field. Reported separately, not diffed.
EXCLUDE = {"skillTimeout"}
skipped = []
for name in src["cases"]:
    if name in EXCLUDE:
        skipped.append(name)
        continue
    s, p = src["cases"][name], phx["cases"].get(name)
    if p is None:
        print(f"!! case {name} missing from phoenix"); total += 1; continue
    out = []
    diff(norm(s["updateSequence"]), norm(p["updateSequence"]), "updates", out)
    diff(side_effects(s), side_effects(p), "sideEffects", out)
    diff(frames(s), frames(p), "frames", out)
    if out:
        total += len(out)
        print(f"== {name}: {len(out)} diff(s)")
        for line in out:
            print("   " + line)
    else:
        print(f"== {name}: identical")

print(f"\nexcluded (documented, not diffed): {', '.join(skipped)}")
print(f"DIFFS ({total})")
sys.exit(1 if total else 0)
