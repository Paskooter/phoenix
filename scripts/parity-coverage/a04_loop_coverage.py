#!/usr/bin/env python3
"""Root verification of A-04 criterion 1: all 23 Loop wire operations covered.

Trap: the loop API file's `key` and `wireName` differ for ten operations —
`Create` ships as `CreateLoop`, `List` as `ListLoops`, `Remove` as `RemoveLoop`,
`InviteMember` as `InviteLoopMember`, and so on. Comparing `key` against the
operation map produces ten phantom "missing" operations and ten phantom
"unexpected" ones. Only `wireName` is what a client puts on x-amz-target, so
that is what this compares.

A-04's acceptance names the coverage areas explicitly, so each operation is also
assigned to one, and every area must be non-empty:

  creation/update/removal, invitations/membership, robot association,
  enrollment, names/photos, legal guardian/agreement, suspension

Checks per operation: present in the A-01 map, implemented in Phoenix's Loop
dispatch, and referenced by a focused test.

Run with --falsify to prove each check detects its own failure.
"""
import argparse
import json
import re
import sys
from pathlib import Path

MAP = Path("docs/parity/candidates/A-01-operation-map.json")
INVENTORY = Path("docs/parity/evidence/2026-09-05/classic-api-inventory.json")
ROBOTFACE_SRC = Path("packages/account/src/robotFace.js")
LOOP_SRC = Path("packages/account/src/loopHttp.js")
TEST_DIR = Path("packages/account/test")

LOOP_API = "apis/loop-2016-03-24.normal.json"
TARGET_PREFIX = "Loop_20160324"
EXPECTED_COUNT = 23

# A-04 acceptance criterion 1, named areas.
AREAS = {
    "creation/update/removal": ["CreateLoop", "UpdateLoop", "RemoveLoop"],
    "invitations/membership": ["AcceptLoopInvitation", "DeclineLoopInvitation",
                               "InviteLoopMember", "ListLoopMembers", "RemoveLoopMember",
                               "UpdateLoopMember"],
    "robot association": ["ClearRobot", "GetRobot", "ListOwnerRobots", "FindOwner"],
    "enrollment": ["SetEnrollment"],
    "names/photos": ["UpdateNickname", "UpdatePhoneticName",
                     "UpdateMemberPhoto", "RemoveMemberPhoto"],
    "legal guardian/agreement": ["SetLegalGuardian", "UpdateAgreementStatus"],
    "suspension": ["SuspendLoop", "SuspendRobotLoop", "List"],
}


def inventory_wire_names(data, api_file):
    """Wire names declared by one API file."""
    found = {}

    def walk(node):
        if isinstance(node, dict):
            if node.get("path") == api_file:
                for op in node.get("operations") or []:
                    found[op["wireName"]] = op
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(data)
    return found


def phoenix_loop_ops():
    """Loop operations Phoenix's dispatch actually serves.

    Static scanning does not work here: Loop dispatch is spread across
    robotFace.js, loopMembership.js, loopMemberPhotos.js, loopAgreements.js and
    loopRecord.js, and each compares the LOWERCASED op (`o === 'listloops'`)
    rather than naming a literal target. Grepping for wire names reports 22 of
    23 as missing and is simply wrong.

    The authoritative answer is runtime, so this reads the JSON manifest written
    by .parity/reviews/a04-loop-probe-20260910/probe.mjs, which drives every
    wire operation at a live service and records whether it was served
    (2xx/3xx) or rejected as unimplemented (400 UnknownOperationException).
    """
    manifest = Path(".parity/reviews/a04-loop-probe-20260910/loop-probe.json")
    if not manifest.exists():
        return set()
    data = json.loads(manifest.read_text())
    return {r["target"] for r in data["results"]
            if r.get("served") and not r.get("unknownOp")}


def tested_ops():
    """Loop operations referenced by focused tests.

    Two spellings occur. Most tests inline the full target, but
    loopPhotoHttp.test.js builds it from a template literal
    (`x-amz-target: `Loop_20160324.${op}``) and calls post('RemoveMemberPhoto'),
    so a literal-string scan reports that operation untested. Both forms are
    collected: literal targets, and bare op names passed to a helper that
    interpolates the Loop prefix.
    """
    names = set()
    for path in TEST_DIR.glob("*.test.js"):
        text = path.read_text()
        for match in re.finditer(rf"{TARGET_PREFIX}\.([A-Za-z][A-Za-z0-9]*)", text):
            names.add(match.group(1))
        # `Loop_20160324.${op}` style: capture the bare op names in scope.
        if f"{TARGET_PREFIX}.${{op}}" in text or f"{TARGET_PREFIX}.${{" in text:
            for match in re.finditer(r"post\(\s*'([A-Za-z][A-Za-z0-9]*)'", text):
                names.add(match.group(1))
    return names


def build():
    inv = json.loads(INVENTORY.read_text())
    return {
        "wire": inventory_wire_names(inv, LOOP_API),
        "map": json.loads(MAP.read_text()),
        "phoenix": phoenix_loop_ops(),
        "tested": tested_ops(),
    }


def check(data, drop_map=None, drop_phx=None, drop_test=None):
    problems = []
    mapped = {o["operation"] for o in data["map"]["operations"]
              if o["targetPrefix"] == TARGET_PREFIX} - (drop_map or set())
    phx = data["phoenix"] - (drop_phx or set())
    tested = data["tested"] - (drop_test or set())
    wire = set(data["wire"])

    if len(data["wire"]) != EXPECTED_COUNT:
        problems.append(f"inventory declares {len(data['wire'])} loop operations, expected {EXPECTED_COUNT}")

    for name in sorted(wire):
        if name not in mapped:
            problems.append(f"{name}: not in the A-01 operation map")
        if name not in phx:
            problems.append(f"{name}: not implemented in Phoenix's Loop dispatch")
        if name not in tested:
            problems.append(f"{name}: no focused test references it")

    # Every named acceptance area must be non-empty and fully covered.
    for area, ops in AREAS.items():
        known = [o for o in ops if o in wire]
        if not known:
            problems.append(f"acceptance area '{area}' matches no inventory operation")
        for o in known:
            if o not in mapped:
                problems.append(f"acceptance area '{area}': {o} is not mapped")
            if o not in phx:
                problems.append(f"acceptance area '{area}': {o} is not implemented")
            if o not in tested:
                problems.append(f"acceptance area '{area}': {o} has no test")

    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--falsify", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    data = build()

    if args.falsify:
        cases = {
            "a wire operation vanishes from the map":
                lambda: check(data, drop_map={"SetEnrollment"}),
            "a wire operation is no longer implemented":
                lambda: check(data, drop_phx={"SuspendRobotLoop"}),
            "a wire operation loses its test coverage":
                lambda: check(data, drop_test={"UpdatePhoneticName"}),
        }
        for label, fn in cases.items():
            caught = len(fn()) > 0
            print(f"  falsify [{'caught' if caught else 'MISSED'}] {label}")
            if not caught:
                print(f"    check failed to detect: {label}", file=sys.stderr)
                return 2
        print(f"falsification: all {len(cases)} gaps detected")
        return 0

    problems = check(data)
    wire = set(data["wire"])
    mapped = {o["operation"] for o in data["map"]["operations"]
              if o["targetPrefix"] == TARGET_PREFIX}
    implemented = sorted(wire & data["phoenix"])
    summary = {
        "task": "A-04",
        "criterion": 1,
        "wireOperations": len(wire),
        "expected": EXPECTED_COUNT,
        "mapped": len(wire & mapped),
        "implemented": len(implemented),
        "tested": len(wire & data["tested"]),
        "problems": len(problems),
        "result": "pass" if not problems else "fail",
    }

    if args.json:
        print(json.dumps({**summary, "problemList": problems[:60]}, indent=2))
    else:
        print(f"A-04 criterion 1: {summary['implemented']}/{summary['wireOperations']} "
              "wire Loop operations implemented; "
              f"{summary['tested']} tested, {summary['mapped']} mapped")
        if problems:
            print(f"{len(problems)} problem(s):")
            for p in problems[:40]:
                print("  -", p)
        else:
            print("  no problems: every wire operation is mapped, implemented and covered")
            print("  acceptance areas all populated:")
            for area, ops in AREAS.items():
                print(f"    {area:<28} {len([o for o in ops if o in wire])}")
    return 0 if summary["result"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
