"""Contract tests for the Parakeet ASR service.

Everything here runs without a model or a GPU: the recognizer is injected. The
point is the wire contract -- backward compatibility with the deployed 0.1.0
server, real confidence, and interim results -- not model accuracy.
"""
import io
import json
import struct
import sys
import threading
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import server  # noqa: E402
from app.recognizer import NemoRecognizer, StubRecognizer, Transcript, mean_confidence  # noqa: E402
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
        # A 300 ms first window must yield an interim while the stream is still
        # open, so earlyEOS can interrupt an in-progress utterance.
        frame = make_wav(0.1)[44:]
        for _ in range(3):
            ws.send_bytes(frame)
        first = json.loads(ws.receive_text())
        assert first["type"] == "interim"
        for _ in range(7):
            ws.send_bytes(frame)
        ws.send_text(json.dumps({"type": "eos"}))

        while True:
            msg = json.loads(ws.receive_text())
            if msg["type"] == "final":
                assert msg["text"] == "live long and prosper"
                assert msg["confidence"] == 0.9
                break


def test_stream_does_not_repeat_an_unchanged_hypothesis():
    # The hub matches earlyEOS against each interim; repeats would make one
    # trigger word look like several.
    stub = StubRecognizer("live", word_confidence=[0.9])
    c = client(stub)
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        frame = make_wav(0.1)[44:]
        for _ in range(3):
            ws.send_bytes(frame)
        assert json.loads(ws.receive_text())["type"] == "interim"
        for _ in range(7):
            ws.send_bytes(frame)
        ws.send_text(json.dumps({"type": "eos"}))
        interims = 1
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


def test_trailing_silence_does_not_trigger_a_redundant_interim():
    stub = StubRecognizer("hello")
    c = client(stub)
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        speech = make_wav(0.1)[44:]
        for _ in range(2):
            ws.send_bytes(speech)
        for _ in range(3):
            ws.send_bytes(b"\x00\x00" * 1600)
        ws.send_text(json.dumps({"type": "eos"}))
        assert json.loads(ws.receive_text())["type"] == "final"
        assert stub.calls == 1, "only the full-buffer final should be decoded"


def test_stream_coalesces_backlogged_interims_and_final_has_all_audio():
    class SlowRecognizer(StubRecognizer):
        def transcribe_pcm(self, pcm, sample_rate):
            time.sleep(0.05)
            self.calls += 1
            return Transcript(text=str(len(pcm) // 2))

    stub = SlowRecognizer()
    c = client(stub)
    frame = make_wav(0.1)[44:]
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        for _ in range(3):
            ws.send_bytes(frame)
        first = json.loads(ws.receive_text())
        assert first["type"] == "interim"
        assert first["text"] == "4800"

        # An old serial handler would decode at 0.6s and 0.9s before seeing
        # EOS. The off-loop handler may do one of those interims, but skips the
        # stale queued partial and still decodes the full 1.0s final.
        for _ in range(7):
            ws.send_bytes(frame)
        ws.send_text(json.dumps({"type": "eos"}))
        final = json.loads(ws.receive_text())
        assert final["type"] == "final"
        assert final["text"] == "16000"
        assert stub.calls <= 3


def test_inference_does_not_block_readiness_or_other_sockets():
    entered = threading.Event()
    release = threading.Event()

    class GatedRecognizer(StubRecognizer):
        def transcribe_pcm(self, pcm, sample_rate):
            entered.set()
            assert release.wait(2), "test did not release the inference worker"
            return super().transcribe_pcm(pcm, sample_rate)

    c = client(GatedRecognizer("hello"))
    frame = make_wav(0.1)[44:]
    with c.websocket_connect("/stream") as ws:
        ws.send_text(json.dumps({"type": "start", "sampleRate": 16000}))
        for _ in range(3):
            ws.send_bytes(frame)
        assert entered.wait(1), "interim inference did not start"
        try:
            started = time.monotonic()
            assert c.get("/healthz").json()["ok"] is True
            assert time.monotonic() - started < 0.5, "model inference blocked the event loop"
        finally:
            release.set()
        assert json.loads(ws.receive_text())["type"] == "interim"
        ws.send_text(json.dumps({"type": "eos"}))
        assert json.loads(ws.receive_text())["type"] == "final"


def test_nemo_skips_ffmpeg_for_canonical_gateway_wav(tmp_path):
    path = tmp_path / "canonical.wav"
    path.write_bytes(make_wav())

    class FakeModel:
        paths = None

        def transcribe(self, paths, return_hypotheses):
            self.paths = paths
            return [type("Hypothesis", (), {"text": "hello", "word_confidence": [0.9]})()]

    model = FakeModel()
    recognizer = NemoRecognizer()
    recognizer._model = model
    recognizer.resample = lambda _path: (_ for _ in ()).throw(AssertionError("ffmpeg should be skipped"))
    transcript = recognizer.transcribe_wav(str(path))
    assert transcript.text == "hello"
    assert model.paths == [str(path)]
    assert path.exists(), "the caller owns the input WAV"


def test_nemo_still_resamples_noncanonical_wav(tmp_path):
    source = tmp_path / "8k.wav"
    source.write_bytes(make_wav(sample_rate=8000))
    converted = tmp_path / "16k.wav"
    converted.write_bytes(make_wav())

    class FakeModel:
        paths = None

        def transcribe(self, paths, return_hypotheses):
            self.paths = paths
            return [type("Hypothesis", (), {"text": "hello"})()]

    model = FakeModel()
    recognizer = NemoRecognizer()
    recognizer._model = model
    recognizer.resample = lambda path: str(converted)
    recognizer.transcribe_wav(str(source))
    assert model.paths == [str(converted)]
    assert source.exists(), "the caller owns the input WAV"
    assert not converted.exists(), "the recognizer cleans its conversion"


def test_healthz_does_not_need_a_model():
    server.set_recognizer(None)
    c = TestClient(server.app)
    body = c.get("/healthz").json()
    assert body["ok"] is True


# --- ASR output must be parseable by the grammars --------------------------

def test_punctuation_and_case_are_stripped():
    # Not cosmetic. Measured against jibo-nlu 2.8.3 over the pinned launch.fst:
    #   "turn on the lights"   -> lightsOn
    #   "turn on the lights."  -> NO PARSE
    # parakeet-tdt-0.6b-v2 emits punctuation and capitalisation, so without this
    # the upgraded server silently breaks intent recognition on the robot.
    c = client(StubRecognizer("Testing, testing, one, two, three."))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["text"] == "testing testing one two three"
    assert body["transcript"]["text_raw"] == "Testing, testing, one, two, three."


def test_apostrophes_and_hyphens_survive():
    # The grammars carry forms like "don't"; stripping these would break them
    # instead of fixing anything.
    c = client(StubRecognizer("Don't wake me up."))
    body = c.post("/transcribe", files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["text"] == "don't wake me up"


def test_normalisation_runs_after_punctuation_is_removed():
    c = client(StubRecognizer("Testing, testing, one, two, three."))
    body = c.post("/transcribe?normalize=true",
                  files={"file": ("a.wav", make_wav(), "audio/wav")}).json()
    assert body["text"] == "testing testing 1 2 3"


# --- parity with the original hive_mind parakeet-service -------------------

def test_non_wav_is_rejected_like_the_original():
    # app.py: raise HTTPException(400, "Only .wav files are supported.")
    c = client(StubRecognizer("hi"))
    r = c.post("/transcribe", files={"file": ("a.mp3", b"\x00\x00", "audio/mpeg")})
    assert r.status_code == 400
    assert "wav" in r.json()["detail"].lower()


def test_the_default_model_is_the_one_the_original_ran():
    # nvidia/parakeet-rnnt-0.6b, NOT parakeet-tdt-0.6b-v2. The TDT model emits
    # punctuation and capitalisation, and punctuation does not parse:
    # "turn on the lights." -> NO PARSE against jibo-nlu 2.8.3.
    from app.recognizer import NemoRecognizer
    assert NemoRecognizer().model_name == "nvidia/parakeet-rnnt-0.6b"


def test_the_model_is_loaded_at_startup_not_on_first_request():
    # The original held the model in VRAM from startup so the first request did
    # not pay the 30-90s load.
    class Loadable(StubRecognizer):
        loaded = False

        def load(self):
            Loadable.loaded = True

    server.set_recognizer(Loadable("hi"))
    with TestClient(server.app):
        assert Loadable.loaded is True
