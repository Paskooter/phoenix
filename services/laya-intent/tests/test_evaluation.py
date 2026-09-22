from evaluation.evaluate_profiles import per_intent_outcomes


def test_per_intent_report_separates_abstentions_from_false_accepts():
    rows = [
        {
            "expected": "unknown",
            "root_choice": "home",
            "root_probability": 0.9,
            "root_margin": 0.8,
            "leaf_choice": "galleryOpen",
            "leaf_probability": 0.9,
            "leaf_margin": 0.8,
        },
        {
            "expected": "unknown",
            "root_choice": "unknown",
            "root_probability": 0.9,
            "root_margin": 0.8,
            "leaf_choice": None,
            "leaf_probability": None,
            "leaf_margin": None,
        },
        {
            "expected": "galleryOpen",
            "root_choice": "home",
            "root_probability": 0.9,
            "root_margin": 0.8,
            "leaf_choice": "galleryOpen",
            "leaf_probability": 0.9,
            "leaf_margin": 0.8,
        },
        {
            "expected": "galleryOpen",
            "root_choice": "unknown",
            "root_probability": 0.9,
            "root_margin": 0.8,
            "leaf_choice": None,
            "leaf_probability": None,
            "leaf_margin": None,
        },
    ]
    configuration = {"root_threshold": 0.4, "leaf_threshold": 0.45, "min_margin": 0.03}

    outcomes = per_intent_outcomes(rows, configuration)

    assert outcomes["unknown"] == {
        "cases": 2,
        "correct": 1,
        "abstained": 0,
        "wrong_or_false_accept": 1,
        "predicted": {"galleryOpen": 1, "unknown": 1},
    }
    assert outcomes["galleryOpen"] == {
        "cases": 2,
        "correct": 1,
        "abstained": 1,
        "wrong_or_false_accept": 0,
        "predicted": {"galleryOpen": 1, "unknown": 1},
    }
