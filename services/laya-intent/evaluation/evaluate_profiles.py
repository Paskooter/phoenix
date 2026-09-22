"""Run Phoenix's source-derived Laya corpus through candidate profile trees.

This is an offline tuning tool, not a serving endpoint. It reports abstention,
exact-intent accuracy, and false-positive rates over thresholds applied to
the same raw decisions so a threshold sweep does not repeat model inference.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from dataclasses import replace
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parents[1]))

from app.classifier import LayaClassifier
from app.profiles import load_profiles


DEFAULT_CASES = Path(__file__).with_name("phoenix-intents.json")
DEFAULT_PROFILES = Path(__file__).parents[1] / "profiles" / "phoenix.json"
ROOT_THRESHOLDS = (0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50)
LEAF_THRESHOLDS = (0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50)
MARGINS = (0.03, 0.06, 0.09, 0.12)


def _root_names(profiles: dict[str, Any]) -> list[str]:
    children = {child for profile in profiles.values() for child in profile.children.values()}
    roots = sorted(set(profiles) - children)
    if len(roots) != 1:
        raise ValueError(f"evaluation expects exactly one root profile, found {roots}")
    return roots


def _top(probabilities: dict[str, float]) -> tuple[str, float, float]:
    ranked = sorted(probabilities.items(), key=lambda pair: pair[1], reverse=True)
    return ranked[0][0], ranked[0][1], ranked[0][1] - ranked[1][1]


def collect_predictions(classifier: LayaClassifier, profiles: dict[str, Any], cases: list[dict[str, str]]) -> list[dict[str, Any]]:
    root_name = _root_names(profiles)[0]
    observed: list[dict[str, Any]] = []
    for case in cases:
        case_started = time.perf_counter()
        root = profiles[root_name]
        root_decision = classifier.classify(case["text"], replace(root, min_confidence=0.0, min_margin=0.0))
        root_choice, root_probability, root_margin = _top(root_decision.probabilities)
        row: dict[str, Any] = {
            "text": case["text"],
            "expected": case["expected"],
            "source": case.get("source", ""),
            "root_choice": root_choice,
            "root_probability": root_probability,
            "root_margin": root_margin,
            "leaf_choice": None,
            "leaf_probability": None,
            "leaf_margin": None,
        }
        child_name = root.children.get(root_choice)
        if child_name:
            leaf = profiles[child_name]
            leaf_decision = classifier.classify(case["text"], replace(leaf, min_confidence=0.0, min_margin=0.0))
            leaf_choice, leaf_probability, leaf_margin = _top(leaf_decision.probabilities)
            row.update({
                "leaf_profile": child_name,
                "leaf_choice": leaf_choice,
                "leaf_probability": leaf_probability,
                "leaf_margin": leaf_margin,
            })
        row["latency_ms"] = round((time.perf_counter() - case_started) * 1_000, 2)
        observed.append(row)
    return observed


def apply_thresholds(row: dict[str, Any], root_threshold: float, leaf_threshold: float, min_margin: float) -> str:
    if row["root_choice"] == "unknown":
        return "unknown"
    if row["root_probability"] < root_threshold or row["root_margin"] < min_margin:
        return "unknown"
    if row["leaf_choice"] is None:
        return row["root_choice"]
    if row["leaf_choice"] == "unknown":
        return "unknown"
    if row["leaf_probability"] < leaf_threshold or row["leaf_margin"] < min_margin:
        return "unknown"
    return row["leaf_choice"]


def metrics(rows: list[dict[str, Any]], root_threshold: float, leaf_threshold: float, min_margin: float) -> dict[str, Any]:
    predicted = [apply_thresholds(row, root_threshold, leaf_threshold, min_margin) for row in rows]
    positives = sum(row["expected"] != "unknown" for row in rows)
    negatives = len(rows) - positives
    correct = sum(pred == row["expected"] for pred, row in zip(predicted, rows))
    true_positive = sum(pred == row["expected"] and pred != "unknown" for pred, row in zip(predicted, rows))
    false_positive = sum(pred != "unknown" and row["expected"] == "unknown" for pred, row in zip(predicted, rows))
    false_negative = sum(pred == "unknown" and row["expected"] != "unknown" for pred, row in zip(predicted, rows))
    wrong_intent = sum(pred not in ("unknown", row["expected"]) for pred, row in zip(predicted, rows))
    accepted = len(rows) - predicted.count("unknown")
    return {
        "root_threshold": root_threshold,
        "leaf_threshold": leaf_threshold,
        "min_margin": min_margin,
        "correct": correct,
        "accuracy": round(correct / len(rows), 4),
        "true_positive": true_positive,
        "positive_recall": round(true_positive / positives, 4) if positives else 0.0,
        "false_positive": false_positive,
        "false_positive_rate": round(false_positive / negatives, 4) if negatives else 0.0,
        "false_negative": false_negative,
        "wrong_intent": wrong_intent,
        "accepted": accepted,
        "precision": round(true_positive / accepted, 4) if accepted else 0.0,
    }


def percentile(values: list[float], percent: float) -> float:
    """Return a linearly interpolated percentile for a non-empty list."""
    ordered = sorted(values)
    position = (len(ordered) - 1) * percent
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def per_intent_outcomes(rows: list[dict[str, Any]], configuration: dict[str, Any]) -> dict[str, Any]:
    grouped: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for row in rows:
        prediction = apply_thresholds(
            row,
            configuration["root_threshold"],
            configuration["leaf_threshold"],
            configuration["min_margin"],
        )
        grouped.setdefault(row["expected"], []).append((row, prediction))

    outcomes = {}
    for expected, cases in sorted(grouped.items()):
        correct = sum(prediction == expected for _, prediction in cases)
        abstained = sum(expected != "unknown" and prediction == "unknown" for _, prediction in cases)
        outcomes[expected] = {
            "cases": len(cases),
            "correct": correct,
            "abstained": abstained,
            "wrong_or_false_accept": sum(prediction != expected and prediction != "unknown" for _, prediction in cases),
            "predicted": dict(sorted(Counter(prediction for _, prediction in cases).items())),
        }
    return outcomes


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default=os.environ.get("LAYA_MODEL_PATH", "/models/laya"))
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILES)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--top", type=int, default=12, help="number of leading threshold configurations to print")
    parser.add_argument("--root-threshold", type=float, help="evaluate one frozen configuration; provide all three threshold flags")
    parser.add_argument("--leaf-threshold", type=float, help="evaluate one frozen configuration; provide all three threshold flags")
    parser.add_argument("--margin", type=float, help="evaluate one frozen configuration; provide all three threshold flags")
    args = parser.parse_args()
    fixed_thresholds = (args.root_threshold, args.leaf_threshold, args.margin)
    if any(value is not None for value in fixed_thresholds) and not all(value is not None for value in fixed_thresholds):
        parser.error("--root-threshold, --leaf-threshold, and --margin must be provided together")
    if all(value is not None for value in fixed_thresholds) and any(not 0 <= value <= 1 for value in fixed_thresholds):
        parser.error("all threshold values must be between zero and one")

    profiles = load_profiles(args.profiles)
    cases_document = json.loads(args.cases.read_text(encoding="utf-8"))
    cases = cases_document["cases"]
    classifier = LayaClassifier(args.model, None, os.environ.get("LAYA_DEVICE", "cpu"), False)
    started = time.perf_counter()
    classifier.load()
    load_seconds = time.perf_counter() - started
    started = time.perf_counter()
    rows = collect_predictions(classifier, profiles, cases)
    elapsed = time.perf_counter() - started

    root_names = _root_names(profiles)
    child_names = sorted({child for name in root_names for child in profiles[name].children.values()})
    if all(value is not None for value in fixed_thresholds):
        configurations = [metrics(rows, *fixed_thresholds)]
        selection_mode = "fixed"
    else:
        configurations = [
            metrics(rows, root_threshold, leaf_threshold, margin)
            for root_threshold in ROOT_THRESHOLDS
            for leaf_threshold in LEAF_THRESHOLDS
            for margin in MARGINS
        ]
        # Prefer a zero-false-positive operating point; among ties maximize exact
        # correct matches, then select the strictest threshold.
        configurations.sort(key=lambda item: (
            item["false_positive"],
            -item["true_positive"],
            -item["accuracy"],
            -item["precision"],
            -item["min_margin"],
            -item["root_threshold"],
            -item["leaf_threshold"],
        ))
        selection_mode = "development_sweep"

    selected = configurations[0]
    predictions = [apply_thresholds(row, selected["root_threshold"], selected["leaf_threshold"], selected["min_margin"]) for row in rows]
    confusion = Counter((row["expected"], prediction) for row, prediction in zip(rows, predictions))
    latencies = [row["latency_ms"] for row in rows]
    incorrect = [
        {key: row[key] for key in ("text", "expected", "root_choice", "root_probability", "root_margin",
                                   "leaf_profile", "leaf_choice", "leaf_probability", "leaf_margin", "latency_ms") if key in row}
        | {"prediction": prediction}
        for row, prediction in zip(rows, predictions)
        if prediction != row["expected"]
    ]

    print(json.dumps({
        "corpus": str(args.cases),
        "case_count": len(cases),
        "positive_count": sum(case["expected"] != "unknown" for case in cases),
        "negative_count": sum(case["expected"] == "unknown" for case in cases),
        "device": classifier.device,
        "selection_mode": selection_mode,
        "model_load_seconds": round(load_seconds, 2),
        "inference_seconds": round(elapsed, 2),
        "latency_ms": {
            "mean": round(sum(latencies) / len(latencies), 2),
            "p50": round(percentile(latencies, 0.50), 2),
            "p95": round(percentile(latencies, 0.95), 2),
        },
        "profiles": {name: {"candidates": [item.id for item in profile.candidates], "children": profile.children}
                     for name, profile in profiles.items()},
        "selected_thresholds": selected,
        "threshold_configurations": configurations[:args.top],
        "per_intent_outcomes": per_intent_outcomes(rows, selected),
        "confusion": [
            {"expected": expected, "predicted": predicted, "count": count}
            for (expected, predicted), count in sorted(confusion.items())
        ],
        "incorrect_examples": incorrect,
    }, indent=2))


if __name__ == "__main__":
    main()
