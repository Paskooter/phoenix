#!/usr/bin/env python3
"""S-14 structural diff: pinned original (node 8, one oracle JSON per fresh process) vs
Phoenix (one harness JSON).

  python3 compare.py <source-example.json> <source-template.json> <source-host.json> <phoenix.json>

Compares exampleSkill, templateSkill and hostProbes structurally. Generated ids and
timings are already reduced to their type by both harnesses; msgID/ts are dropped here.
"""
import json, sys

def canon(obj):
    if isinstance(obj, dict):
        return {k: canon(v) for k, v in sorted(obj.items()) if k not in ('msgID', 'ts')}
    if isinstance(obj, list):
        return [canon(v) for v in obj]
    return obj

def normalize_session_ids(obj):
    """Rewrite node ids to their offset from the session's first trace node id.

    The pinned original allocates node ids from a process-wide GraphManager singleton, so
    absolute ids depend on how many graphs the process built before (documented in
    docs/parity/evidence/2026-09-11/s01-graph-sessions/README.md). Phoenix isolates graphs
    per skill, so a standalone replacement starts at 0. The stable contract is the relative
    shape of a session trace, which is what is compared here.
    """
    if isinstance(obj, dict):
        if 'nodeID' in obj and isinstance(obj.get('trace'), list):
            trace = obj['trace']
            base = trace[0]['nodeID'] if trace else obj['nodeID']
            out = {k: normalize_session_ids(v) for k, v in obj.items()}
            out['nodeID'] = obj['nodeID'] - base
            out['trace'] = [{**t, 'nodeID': t['nodeID'] - base} for t in trace]
            return out
        return {k: normalize_session_ids(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [normalize_session_ids(v) for v in obj]
    return obj

def diff(path, a, b, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            diff(f"{path}.{k}", a.get(k, '<missing>'), b.get(k, '<missing>'), out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append((path, f"length {len(a)}", f"length {len(b)}"))
        for i, (x, y) in enumerate(zip(a, b)):
            diff(f"{path}[{i}]", x, y, out)
    elif a != b:
        out.append((path, a, b))

def main():
    src_example_path, src_template_path, src_host_path, phoenix_path = sys.argv[1:5]
    phx_all = json.load(open(phoenix_path))
    pairs = [
        ('exampleSkill', json.load(open(src_example_path)), phx_all, True),
        ('templateSkill', json.load(open(src_template_path)), phx_all, True),
        ('hostProbes', json.load(open(src_host_path)), phx_all, False),
    ]
    out = []
    for section, src, phx, sessions in pairs:
        a, b = src.get(section, {}), phx.get(section, {})
        if sessions:
            a, b = normalize_session_ids(a), normalize_session_ids(b)
        if section == 'hostProbes':
            a, b = canon(a), canon(b)
        diff(section, a, b, out)
    print(f"compared sections: {len(pairs)}")
    print(f"DIFFS ({len(out)})")
    for d in out:
        print("  -", d[0])
        print("      source :", json.dumps(d[1])[:300])
        print("      phoenix:", json.dumps(d[2])[:300])
    return 1 if out else 0

if __name__ == '__main__':
    sys.exit(main())
