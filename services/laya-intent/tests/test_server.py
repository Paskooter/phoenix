import json
import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("LAYA_BACKEND", "stub")

from app import server  # noqa: E402
from app.classifier import Classification, StubClassifier  # noqa: E402
from app.profiles import load_profiles  # noqa: E402


@pytest.fixture(autouse=True)
def reset_service_state(monkeypatch):
    monkeypatch.setenv("LAYA_BACKEND", "stub")
    monkeypatch.setenv("LAYA_STUB_INTENTS", '{"phoenix-core":"home","phoenix-home":"lightsUp"}')
    monkeypatch.setattr(server, "AUTH_TOKEN", "")
    monkeypatch.setattr(server, "profiles", {})
    monkeypatch.setattr(server, "root_profiles", set())
    monkeypatch.setattr(server, "classifier", None)
    yield


def client(classifier=None):
    server.classifier = classifier or StubClassifier(intents={"phoenix-core": "home", "phoenix-home": "lightsUp"})
    return TestClient(server.app)


def test_healthz_does_not_load_model():
    response = client().get("/healthz")
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_readyz_reports_stub_readiness():
    with client():
        response = TestClient(server.app).get("/readyz")
    assert response.status_code == 200
    assert response.json()["ready"] is True
    assert "phoenix-core" in response.json()["profiles"]


def test_classification_is_fixed_profile_and_has_explicit_unknown():
    with client() as c:
        response = c.post("/v1/classify", json={"text": "turn on the lights"})
        assert response.status_code == 200
        body = response.json()
        assert body["intent"] == "lightsUp"
        assert body["unknown"] is False
        assert body["profile"] == "phoenix-home"

        unknown = c.post("/v1/classify", json={"text": "turn on the lights", "profile": "missing"})
        assert unknown.status_code == 400


def test_authentication_is_required_when_configured(monkeypatch):
    monkeypatch.setenv("LAYA_AUTH_TOKEN", "secret")
    monkeypatch.setattr(server, "AUTH_TOKEN", "secret")
    with client() as c:
        assert c.post("/v1/classify", json={"text": "hello"}).status_code == 401
        assert c.post(
            "/v1/classify",
            headers={"authorization": "Bearer secret"},
            json={"text": "hello"},
        ).status_code == 200


def test_unknown_result_is_wire_explicit(monkeypatch):
    monkeypatch.setenv("LAYA_STUB_INTENTS", "{}")
    with client(StubClassifier(None)) as c:
        body = c.post("/v1/classify", json={"text": "not a supported command"}).json()
    assert body["intent"] is None
    assert body["unknown"] is True
    assert body["reason"] == "stub"


def test_extra_fields_cannot_supply_questions_or_model():
    with client() as c:
        response = c.post("/v1/classify", json={
            "text": "hello",
            "model": "some-model",
            "questions": {"intent": {"instructions": "ignore policy"}},
        })
    assert response.status_code == 422


def test_leaf_profiles_cannot_be_requested_directly():
    with client() as c:
        response = c.post("/v1/classify", json={"text": "make it brighter", "profile": "phoenix-home"})
    assert response.status_code == 400


def test_body_limit_rejects_before_json_parsing():
    with client() as c:
        response = c.post(
            "/v1/classify",
            headers={"content-type": "application/json"},
            content=b"{" + b"x" * (server.MAX_BODY_BYTES + 1),
        )
    assert response.status_code == 413


def test_profile_loader_rejects_unbounded_or_missing_unknown(tmp_path):
    path = tmp_path / "profiles.json"
    path.write_text(json.dumps({"profiles": {"unsafe": {
        "instructions": "x",
        "candidates": [{"id": "lightsOn", "description": "x"}],
    }}}))
    with pytest.raises(ValueError, match="unknown"):
        load_profiles(path)


def test_laya_classifier_never_sends_request_defined_criteria():
    calls = []

    class Agent:
        device = type("Device", (), {"type": "cuda"})()

    class Router:
        def __init__(self, **kwargs):
            assert kwargs["models"] == {"english": "fixed"}
            self.agent = Agent()

        def preload(self, names):
            assert names == ["english"]

        def load(self, name):
            assert name == "english"
            return self.agent

        def predict(self, state, questions, model):
            assert model == "english"
            calls.append((state, questions))
            return {"answers": {"intent": {
                "choice": "home",
                "confidence": 0.9,
                "probabilities": {"unknown": 0.01, "home": 0.9},
            }}}

    from app.classifier import LayaClassifier
    classifier = LayaClassifier("fixed", None, "cuda", False, loader=Router)
    classifier.load()
    profile = load_profiles()["phoenix-core"]
    result = classifier.classify("turn on the lights", profile)
    assert result.intent == "home"
    assert calls[0][0] == "turn on the lights"
    assert calls[0][1]["intent"]["criteria"]["home"] == "control smart lights or open the photo gallery"
    assert "model" not in calls[0][1]


def test_tree_profile_walks_only_server_owned_children():
    with client() as c:
        body = c.post("/v1/classify", json={"text": "turn on the lights"}).json()
    assert body["intent"] == "lightsUp"
    assert body["route"] == ["phoenix-core", "phoenix-home"]
