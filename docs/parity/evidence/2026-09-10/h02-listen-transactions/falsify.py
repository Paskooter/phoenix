#!/usr/bin/env python3
"""H-02 falsification: corrupt the implementation on a FULL CODE LINE, prove the
relevant test fails, restore, prove green again. Prints a transcript.

The corruption is anchored on a complete source line (not a bare substring) and
the script refuses to run unless that exact line occurs once. Restoration happens
in a try/finally so a failed assertion can never leave the tree corrupted.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path('/home/shell/work/phoenix/.parity/worktrees/w3-h02')
TX = ROOT / 'packages/gateway/src/listenTransaction.js'
GATEWAY_TEST = 'packages/gateway/test/listen.e2e.failure.test.js'
CANCEL_TEST = 'packages/gateway/test/listenTransaction.cancelFailure.test.js'

CASES = [
    {
        'name': 'F1 parser failure keeps HubErrorCode.PARSER',
        'file': TX,
        'anchor': "      throw new HubError(HubErrorCode.PARSER, errMsg(err));",
        'replace': "      throw err; // CORRUPTED: parser code lost",
        'proof': 'CORRUPTED: parser code lost',
        'test': GATEWAY_TEST,
        'expect_fail': ['a parser failure keeps the reference PARSER code',
                        'a parser timeout also reaches the robot as PARSER'],
    },
    {
        'name': 'F2 CLIENT_ASR cancels the running ASR session',
        'file': TX,
        'anchor': "  _cancelASR() {\n    this.asrCancelled = true;\n    this._stopASR();\n  }",
        'replace': "  _cancelASR() {\n    // CORRUPTED: cancellation becomes a no-op\n  }",
        'proof': 'CORRUPTED: cancellation becomes a no-op',
        'test': CANCEL_TEST,
        'expect_fail': ['CLIENT_ASR cancels the in-flight server ASR phase and keeps the client transcript'],
    },
]


def run_test(path):
    proc = subprocess.run(['node', '--test', path], cwd=ROOT, capture_output=True, text=True, timeout=600)
    output = proc.stdout + proc.stderr
    failed = [line.strip() for line in output.splitlines() if line.startswith('not ok')]
    counts = [line.strip() for line in output.splitlines()
              if line.startswith('# tests') or line.startswith('# pass') or line.startswith('# fail')]
    return proc.returncode, failed, counts


for case in CASES:
    path = case['file']
    original = path.read_text()
    hits = original.count(case['anchor'])
    assert hits == 1, f"{case['name']}: anchor matched {hits} times, refusing to corrupt"
    print('=' * 100, flush=True)
    print(f"CASE {case['name']}")
    print(f"  file          {path.relative_to(ROOT)}")
    print(f"  exact anchor  {case['anchor']!r}")
    print(f"  matches       {hits} (a complete line / block, not a substring)")
    try:
        corrupted = original.replace(case['anchor'], case['replace'], 1)
        assert case['anchor'] not in corrupted
        path.write_text(corrupted)
        proof = [line for line in corrupted.splitlines() if case['proof'] in line]
        assert proof, 'corruption not visible in the file'
        print(f"  after edit    {proof[0].strip()}")
        print(f"  line number   {corrupted.splitlines().index(proof[0]) + 1}")

        code, failed, counts = run_test(case['test'])
        print(f"  test run      exit={code}")
        for line in counts:
            print(f"                {line}")
        print('  failures:')
        for line in failed:
            print(f"                {line}")
        caught = all(any(name in line for line in failed) for name in case['expect_fail'])
        print(f"  caught        {caught}")
        assert code != 0, f"{case['name']}: corrupted tree still exited 0"
        assert caught, f"{case['name']}: expected failures did not appear"
    finally:
        path.write_text(original)

    code2, failed2, counts2 = run_test(case['test'])
    print(f"  restored run  exit={code2}")
    for line in counts2:
        print(f"                {line}")
    print(f"  restored ok   {code2 == 0 and not failed2}")
    if not (code2 == 0 and not failed2):
        sys.exit(1)

print('=' * 100)
print('falsification complete: both corruptions were caught and both files restored')
