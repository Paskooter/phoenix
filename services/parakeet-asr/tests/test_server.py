"""Contract tests for the Parakeet ASR service.

Everything here runs without a model or a GPU: the recognizer is injected. The
point is the wire contract -- backward compatibility with the deployed 0.1.0
server, real confidence, and interim results -- not model accuracy.
"""
import io
import json
import struct
import sys
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import server  # noqa: E402
from app.recognizer import StubRecognizer, mean_confidence  # noqa: E402
from app.normalize import normalize_text  # noqa: E402


def make_wav(seconds=0.5, sample_rate=16000, amplitude=8000):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        frames = b"".join(struct.pack("<h", amplitude if (i // 80) % 2 else -amplitude)
                          for i in range(int(seconds * sample_rate)))
        w.writeframes(frames)
    return buf.getvalue()


def client(stub):
    server.set_recognizer(stub)
    return TestClient(server.app)


# --- backward compatibility ------------------------------------------------

def test_transcribe_keeps_the_shape_both_existing_clients_parse():
    # pegasus ParakeetASRSession.ts:236-246 and phoenix parakeetSession.js:542-545
    # both read json.transcript and accept a string or an object with .text.
    c = client(StubRecognizer("hello there", word_confidence=[0.9, 0.8]))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()

    assert "transcript" in body
    assert isinstance(body["transcript"], dict)
    assert body["transcript"]["text"] == "hello there"
    assert body["filename"] == "a.wav"


def test_added_fields_do_not_disturb_the_old_parse_path():
    c = client(StubRecognizer("hello", word_confidence=[0.5]))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    # An old client reaches transcript.text and ignores the rest; simulate it.
    transcript = body["transcript"]
    if isinstance(transcript, dict):
        transcript = transcript["text"]
    assert isinstance(transcript, str) and transcript == "hello"


# --- H07c: real confidence -------------------------------------------------

def test_confidence_is_the_model_value_not_a_constant():
    c = client(StubRecognizer("hi", word_confidence=[0.6, 0.8]))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["confidence"] == mean_confidence([0.6, 0.8])
    assert abs(body["confidence"] - 0.7) < 1e-9
    assert body["transcript"]["word_confidence"] == [0.6, 0.8]


def test_absent_confidence_is_null_not_invented():
    # The failure this guards: the 0.1.0 client reported 1.0 whether or not the
    # model said anything, and that constant reached the robot (H07c).
    c = client(StubRecognizer("hi"))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["confidence"] is None


# --- normalisation is opt-in ----------------------------------------------

def test_numbers_are_left_alone_by_default():
    c = client(StubRecognizer("testing testing one two three"))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["text"] == "testing testing one two three"


def test_normalisation_on_request_matches_the_original_transcript():
    c = client(StubRecognizer("testing testing one two three"))
    body = c.post("/transcribe?normalize=true",
                  files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["text"] == "testing testing 1 2 3"       # what Google returned
    assert body["transcript"]["text_raw"] == "testing testing one two three"


def test_pronoun_one_survives_normalisation():
    assert normalize_text("the big one") == "the big one"
    assert normalize_text("one of them") == "one of them"
    assert normalize_text("twenty three") == "23"


# --- H07b: interim results -------------------------------------------------

def test_stream_emits_interim_results_before_the_end():
    stub = StubRecognizer("live long and prosper", word_confidence=[0.9])
    c = client(stub)
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        # 1s of loud audio in 100ms frames: more than one interim window.
        frame = make_wav(0.1)[44:]
        for _ in range(10):
            ws.send_bytes(frame)
        ws.send_text(json.dumps({"type": "eos"}))

        kinds = []
        while True:
            msg = json.loads(ws.receive_text())
            kinds.append(msg["type"])
            if msg["type"] == "final":
                assert msg["text"] == "live long and prosper"
                assert msg["confidence"] == 0.9
                break
        assert "interim" in kinds, f"no interim result was sent: {kinds}"


def test_stream_does_not_repeat_an_unchanged_hypothesis():
    # The hub matches earlyEOS against each interim; repeats would make one
    # trigger word look like several.
    stub = StubRecognizer("live", word_confidence=[0.9])
    c = client(stub)
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        frame = make_wav(0.1)[44:]
        for _ in range(10):
            ws.send_bytes(frame)
        ws.send_text(json.dumps({"type": "eos"}))
        interims = 0
        while True:
            msg = json.loads(ws.receive_text())
            if msg["type"] == "interim":
                interims += 1
            else:
                break
        assert interims == 1, f"same hypothesis sent {interims} times"


def test_silence_is_not_decoded():
    stub = StubRecognizer("should not be called")
    c = client(stub)
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        ws.send_bytes(b"\x00\x00" * 16000)   # 1s of digital silence
        before = stub.calls
        ws.send_text(json.dumps({"type": "eos"}))
        json.loads(ws.receive_text())
        assert before == 0, "silence triggered an interim decode"


def test_healthz_does_not_need_a_model():
    server.set_recognizer(None)
    c = TestClient(server.app)
    body = c.get("/healthz").json()
    assert body["ok"] is True
