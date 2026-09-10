#!/usr/bin/env python3
"""Normalize and diff the pinned-original and Phoenix H-04 skill-handoff receipts."""
import json, re, sys, os, collections

here = os.path.dirname(os.path.abspath(__file__))
src = json.load(open(os.path.join(here, 'source-skill-handoff.json')))
phx = json.load(open(os.path.join(here, 'phoenix-skill-handoff.json')))

URLPORT = re.compile(r'http://127\.0\.0\.1:\d+/v1/main')

def norm(v):
    if isinstance(v, str): return URLPORT.sub('http://127.0.0.1:PORT/v1/main', v)
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v, dict): return {k: norm(x) for k, x in v.items()}
    return v

def frames_sig(frames):
    out = []
    for f in frames:
        g = {'type': f.get('type'), 'final': f.get('final')}
        if f.get('type') in ('SKILL_ACTION',):
            # Timing values are wall-clock; only presence/shape is comparable, plus a
            # coarse ordering check that a redirect turn reports the second leg.
            g['timingsKeys'] = sorted((f.get('timings') or {}).keys())
            g['skill'] = (f.get('timings') or {}).get('skill')
            g['data'] = f.get('data')
        elif f.get('type') in ('SKILL_REDIRECT', 'ERROR', 'LISTEN'):
            g['data'] = norm(f.get('data'))
        out.append(g)
    return out

diffs = []
cases = [c for c in src['cases'] if c != 'timeoutSamples']
for case in cases:
    s, p = src['cases'][case], phx['cases'][case]
    sr = s['requests'] if isinstance(s['requests'], list) else [None] * s['requests']
    pr = p['requests'] if isinstance(p['requests'], list) else [None] * p['requests']
    if len(sr) != len(pr):
        diffs.append((case, 'requestCount', len(sr), len(pr)))
    for i, (rs, rp) in enumerate(zip(sr, pr)):
        if rs is None or rp is None:
            continue
        if rs != rp:
            for k in sorted(set(rs) | set(rp)):
                if rs.get(k) != rp.get(k):
                    diffs.append((case, f'request[{i}].{k}', rs.get(k), rp.get(k)))
    fs, fp = frames_sig(s['frames']), frames_sig(p['frames'])
    if len(fs) != len(fp):
        diffs.append((case, 'frameCount', len(fs), len(fp)))
    for i, (a, b) in enumerate(zip(fs, fp)):
        # timings.skill is wall-clock; compare its presence/shape (checked
        # structurally below), never its exact value.
        a = {k: v for k, v in a.items() if k != 'skill'}
        b = {k: v for k, v in b.items() if k != 'skill'}
        if a != b:
            for k in sorted(set(a) | set(b)):
                if a.get(k) != b.get(k):
                    diffs.append((case, f'frame[{i}].{k}', a.get(k), b.get(k)))

# timing-shape check: reference redirect SKILL_ACTION timings.skill ~ one leg, Phoenix ~ two legs
# Timing structure: the reference times the initial launch and then OVERWRITES
# timings.skill with the redirect leg alone, so a redirected turn reports roughly
# one leg, not the sum.
timing_diffs = []
for case in ('launch', 'redirect'):
    s = [f for f in src['cases'][case]['frames'] if f['type'] == 'SKILL_ACTION'][-1]['timings']
    p = [f for f in phx['cases'][case]['frames'] if f['type'] == 'SKILL_ACTION'][-1]['timings']
    s_summed = s.get('skill') > 0.75 * s.get('total')
    p_summed = p.get('skill') > 0.75 * p.get('total')
    print(f'timings[{case}] original total={s.get("total")} skill={s.get("skill")} (summed={s_summed})'
          f' | phoenix total={p.get("total")} skill={p.get("skill")} (summed={p_summed})')
    if case == 'redirect' and (s_summed or p_summed):
        timing_diffs.append((case, s, p))
diffs.extend(('timings', d[0], d[1], d[2]) for d in timing_diffs)

print('\ntimeoutSamples')
for k in ('launch', 'redirect'):
    cs = collections.Counter((x['frame'] or {}).get('message') for x in src['cases']['timeoutSamples'][k])
    cp = collections.Counter((x['frame'] or {}).get('message') for x in phx['cases']['timeoutSamples'][k])
    print(f'  {k} original: {dict(cs)}')
    print(f'  {k} phoenix : {dict(cp)}')

print(f'\nDIFFS ({len(diffs)}):')
for d in diffs:
    print('  ', d[0], d[1])
    print('     original:', json.dumps(d[2])[:300])
    print('     phoenix :', json.dumps(d[3])[:300])
sys.exit(1 if diffs else 0)
