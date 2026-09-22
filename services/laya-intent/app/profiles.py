"""Load and validate the server-owned Laya intent profiles.

The HTTP API intentionally accepts a profile *name* only.  Criteria and model
configuration live in this file/configuration, so an untrusted caller cannot
turn the service into an arbitrary prompt or model-selection endpoint.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_.:-]{0,63}$")
MAX_PROFILES = 64
MAX_CANDIDATES = 32
MAX_INSTRUCTIONS = 512
MAX_CANDIDATE_DESCRIPTION = 512


@dataclass(frozen=True)
class Candidate:
    id: str
    description: str


@dataclass(frozen=True)
class Profile:
    name: str
    instructions: str
    candidates: tuple[Candidate, ...]
    min_confidence: float
    min_margin: float
    children: dict[str, str]

    @property
    def criteria(self) -> dict[str, str]:
        return {candidate.id: candidate.description for candidate in self.candidates}


def _bounded_float(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a number")
    value = float(value)
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"{field} must be between 0 and 1")
    return value


def _string(value: Any, field: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    value = value.strip()
    if len(value) > limit:
        raise ValueError(f"{field} exceeds {limit} characters")
    return value


def _profile(name: str, raw: Any) -> Profile:
    if not isinstance(raw, dict):
        raise ValueError(f"profile {name!r} must be an object")
    if not IDENTIFIER.fullmatch(name):
        raise ValueError(f"invalid profile name {name!r}")
    instructions = _string(raw.get("instructions"), f"profile {name!r} instructions", MAX_INSTRUCTIONS)
    raw_candidates = raw.get("candidates")
    if not isinstance(raw_candidates, list) or not raw_candidates:
        raise ValueError(f"profile {name!r} candidates must be a non-empty list")
    if len(raw_candidates) > MAX_CANDIDATES:
        raise ValueError(f"profile {name!r} has more than {MAX_CANDIDATES} candidates")
    candidates: list[Candidate] = []
    seen: set[str] = set()
    for index, raw_candidate in enumerate(raw_candidates):
        if not isinstance(raw_candidate, dict):
            raise ValueError(f"profile {name!r} candidate {index} must be an object")
        candidate_id = _string(raw_candidate.get("id"), f"profile {name!r} candidate id", 64)
        if not IDENTIFIER.fullmatch(candidate_id):
            raise ValueError(f"invalid candidate id {candidate_id!r} in profile {name!r}")
        if candidate_id in seen:
            raise ValueError(f"duplicate candidate id {candidate_id!r} in profile {name!r}")
        seen.add(candidate_id)
        candidates.append(Candidate(
            id=candidate_id,
            description=_string(
                raw_candidate.get("description"),
                f"profile {name!r} candidate {candidate_id!r} description",
                MAX_CANDIDATE_DESCRIPTION,
            ),
        ))
    if "unknown" not in seen:
        raise ValueError(f"profile {name!r} must include the reserved 'unknown' candidate")
    raw_children = raw.get("children", {})
    if not isinstance(raw_children, dict):
        raise ValueError(f"profile {name!r} children must be an object")
    children: dict[str, str] = {}
    for candidate_id, child_name in raw_children.items():
        if not isinstance(candidate_id, str) or candidate_id not in seen or candidate_id == "unknown":
            raise ValueError(f"profile {name!r} child key must name a non-unknown candidate")
        if not isinstance(child_name, str) or not IDENTIFIER.fullmatch(child_name):
            raise ValueError(f"profile {name!r} child target is invalid")
        children[candidate_id] = child_name
    return Profile(
        name=name,
        instructions=instructions,
        candidates=tuple(candidates),
        min_confidence=_bounded_float(raw.get("min_confidence", 0.55), f"profile {name!r} min_confidence"),
        min_margin=_bounded_float(raw.get("min_margin", 0.08), f"profile {name!r} min_margin"),
        children=children,
    )


def load_profiles(path: str | os.PathLike[str] | None = None) -> dict[str, Profile]:
    """Load the immutable, operator-owned profile allowlist."""
    if path is None:
        path = os.environ.get(
            "LAYA_PROFILE_FILE",
            str(Path(__file__).resolve().parents[1] / "profiles" / "phoenix.json"),
        )
    profile_path = Path(path)
    with profile_path.open("r", encoding="utf-8") as stream:
        document = json.load(stream)
    raw_profiles = document.get("profiles") if isinstance(document, dict) else None
    if not isinstance(raw_profiles, dict) or not raw_profiles:
        raise ValueError("Laya profile file must contain a non-empty 'profiles' object")
    if len(raw_profiles) > MAX_PROFILES:
        raise ValueError(f"profile file has more than {MAX_PROFILES} profiles")
    profiles = {name: _profile(name, raw) for name, raw in raw_profiles.items()}
    for profile in profiles.values():
        for child_name in profile.children.values():
            if child_name not in profiles:
                raise ValueError(f"profile {profile.name!r} references unknown child {child_name!r}")

    # A bounded hierarchy is the service's primary prompt-size safety control.
    # Reject cycles before serving traffic; without this an operator typo could
    # turn one bounded request into an unbounded inference loop.
    def walk(name: str, ancestors: set[str]) -> None:
        if name in ancestors:
            raise ValueError(f"profile hierarchy contains a cycle at {name!r}")
        for child in profiles[name].children.values():
            walk(child, ancestors | {name})

    for name in profiles:
        walk(name, set())
    return profiles
