"""Concurrency, isolation and backpressure checks; no CUDA/model download."""
import asyncio
import io
import struct
import sys
import threading
import time
import wave
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import server
from app.inference import InferenceScheduler, ServiceBusy
from app.recognizer import AudioInput, NemoRecognizer, StubRecognizer, Transcript


def pcm(marker, frames=1600):
    return struct.pack("<h", marker) * frames


def wav(marker):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(pcm(marker))
    return buffer.getvalue()


class BatchRecognizer:
    def __init__(self):
        self.batches = []
        self.active = 0
        self.peak_active = 0

    def transcribe_batch(self, inputs):
        self.active += 1
        self.peak_active = max(self.peak_active, self.active)
        markers = [struct.unpack("<h", item.data[:2])[0] for item in inputs]
        self.batches.append(markers)
        time.sleep(0.01)
        self.active -= 1
        return [Transcript(text=str(marker)) for marker in markers]


def test_simultaneous_jobs_use_bounded_batches_with_one_model_owner():
    async def run():
        recognizer = BatchRecognizer()
        scheduler = InferenceScheduler(recognizer, batch_size=4, batch_wait_ms=10)
        scheduler.start()
        try:
            results = await asyncio.gather(*[
                scheduler.submit(AudioInput(pcm(index), 16000)) for index in range(10)])
            assert [result.text for result in results] == [str(index) for index in range(10)]
            assert [len(batch) for batch in recognizer.batches] == [4, 4, 2]
            assert recognizer.peak_active == 1
            assert scheduler.stats()["completed"] == 10
        finally:
            await scheduler.close()
    asyncio.run(run())


def test_final_outranks_interims_and_cancelled_work_is_never_decoded():
    entered, release = threading.Event(), threading.Event()

    class Gated(BatchRecognizer):
        def transcribe_batch(self, inputs):
            if not self.batches:
                entered.set()
                assert release.wait(3)
            return super().transcribe_batch(inputs)

    async def run():
        recognizer = Gated()
        scheduler = InferenceScheduler(recognizer, batch_size=4, batch_wait_ms=0)
        scheduler.start()
        try:
            first = asyncio.create_task(scheduler.submit(AudioInput(pcm(0), 16000), final=False))
            assert await asyncio.to_thread(entered.wait, 1)
            stale = asyncio.create_task(scheduler.submit(AudioInput(pcm(1), 16000), final=False))
            partial = asyncio.create_task(scheduler.submit(AudioInput(pcm(2), 16000), final=False))
            final = asyncio.create_task(scheduler.submit(AudioInput(pcm(3), 16000)))
            await asyncio.sleep(0)
            stale.cancel()
            await asyncio.gather(stale, return_exceptions=True)
            assert scheduler.stats()["queued_interims"] == 1
            release.set()
            await asyncio.gather(first, partial, final)
            assert recognizer.batches == [[0], [3, 2]]
        finally:
            release.set()
            await scheduler.close()
    asyncio.run(run())


def test_queue_limit_includes_running_jobs_and_cancellation_frees_a_slot():
    entered, release = threading.Event(), threading.Event()

    class Gated(BatchRecognizer):
        def transcribe_batch(self, inputs):
            entered.set()
            assert release.wait(3)
            return super().transcribe_batch(inputs)

    async def run():
        recognizer = Gated()
        scheduler = InferenceScheduler(recognizer, batch_size=1, batch_wait_ms=0, max_pending=2)
        scheduler.start()
        try:
            running = asyncio.create_task(scheduler.submit(AudioInput(pcm(0), 16000)))
            assert await asyncio.to_thread(entered.wait, 1)
            cancelled = asyncio.create_task(scheduler.submit(AudioInput(pcm(1), 16000)))
            await asyncio.sleep(0)
            with pytest.raises(ServiceBusy):
                await scheduler.submit(AudioInput(pcm(2), 16000))
            cancelled.cancel()
            await asyncio.gather(cancelled, return_exceptions=True)
            replacement = asyncio.create_task(scheduler.submit(AudioInput(pcm(3), 16000)))
            await asyncio.sleep(0)
            assert scheduler.stats()["queued_finals"] == 1
            assert scheduler.stats()["overloads"] == 1
            release.set()
            await asyncio.gather(running, replacement)
            assert recognizer.batches == [[0], [3]]
        finally:
            release.set()
            await scheduler.close()
    asyncio.run(run())


def test_batch_failure_does_not_stop_the_worker():
    class FailsOnce(BatchRecognizer):
        failed = False

        def transcribe_batch(self, inputs):
            if not self.failed:
                self.failed = True
                raise RuntimeError("test decoder failure")
            return super().transcribe_batch(inputs)

    async def run():
        scheduler = InferenceScheduler(FailsOnce(), batch_wait_ms=0)
        scheduler.start()
        try:
            with pytest.raises(RuntimeError, match="decoder failure"):
                await scheduler.submit(AudioInput(pcm(1), 16000))
            assert (await scheduler.submit(AudioInput(pcm(2), 16000))).text == "2"
            assert scheduler.stats()["failed"] == 1
        finally:
            await scheduler.close()
    asyncio.run(run())


def test_sixteen_live_sockets_keep_audio_results_and_confidence_separate(monkeypatch):
    class Model:
        def __init__(self):
            self.batches = []
            self.paths = []
            self.active = 0
            self.peak_active = 0

        def transcribe(self, paths, *, batch_size, num_workers, return_hypotheses, verbose):
            assert batch_size == len(paths) <= 4
            assert num_workers == 0 and return_hypotheses is True
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)
            markers = []
            for path in paths:
                with wave.open(path, "rb") as audio:
                    markers.append(struct.unpack("<h", audio.readframes(1))[0])
            self.paths.extend(paths)
            self.batches.append(markers)
            time.sleep(0.01)
            self.active -= 1
            return [SimpleNamespace(text=f"robot {marker}", word_confidence=[marker / 32768])
                    for marker in markers]

    model = Model()
    recognizer = NemoRecognizer()
    recognizer._model = model
    server.set_recognizer(recognizer)
    monkeypatch.setattr(server, "BATCH_WAIT_MS", 40)
    try:
        with TestClient(server.app) as client:
            with ExitStack() as stack:
                sockets = [stack.enter_context(client.websocket_connect("/stream")) for _ in range(16)]
                assert client.get("/healthz").json()["concurrency"]["active_streams"] == 16
                for index, ws in enumerate(sockets):
                    ws.send_json({"type": "start", "sampleRate": 16000})
                    ws.send_bytes(pcm(8000 + index))
                for ws in sockets:
                    ws.send_json({"type": "eos"})
                for index, ws in enumerate(sockets):
                    result = ws.receive_json()
                    assert result["type"] == "final"
                    assert result["text"] == f"robot {8000 + index}"
                    assert result["confidence"] == (8000 + index) / 32768
                stats = client.get("/healthz").json()["concurrency"]
                assert stats["largest_batch"] == 4
                assert stats["completed"] == 16
            assert client.get("/healthz").json()["concurrency"]["active_streams"] == 0
        assert sorted(marker for batch in model.batches for marker in batch) == list(range(8000, 8016))
        assert model.peak_active == 1
        assert all(not Path(path).exists() for path in model.paths)
    finally:
        server.set_recognizer(None)


def test_http_and_pcm_inputs_share_a_model_batch_and_bad_upload_is_isolated():
    class Model:
        def transcribe(self, paths, *, batch_size, **kwargs):
            assert batch_size == 2
            hypotheses = []
            for path in paths:
                with wave.open(path, "rb") as audio:
                    marker = struct.unpack("<h", audio.readframes(1))[0]
                    hypotheses.append(SimpleNamespace(text=str(marker)))
            return hypotheses

    recognizer = NemoRecognizer()
    recognizer._model = Model()
    recognizer.resample = lambda path: (_ for _ in ()).throw(RuntimeError("bad WAV"))
    results = recognizer.transcribe_batch([
        AudioInput(b"invalid WAV"), AudioInput(wav(9)), AudioInput(pcm(12), 16000)])
    assert isinstance(results[0], RuntimeError)
    assert [result.text for result in results[1:]] == ["9", "12"]


def test_cuda_oom_retries_a_smaller_microbatch_and_remembers_the_limit(monkeypatch):
    class OOM(RuntimeError):
        pass

    cache_clears = []
    monkeypatch.setitem(sys.modules, "torch", SimpleNamespace(cuda=SimpleNamespace(
        OutOfMemoryError=OOM, empty_cache=lambda: cache_clears.append(True))))

    class Model:
        sizes = []

        def transcribe(self, paths, *, batch_size, **kwargs):
            self.sizes.append(batch_size)
            if batch_size > 2:
                raise OOM("test CUDA memory pressure")
            return [SimpleNamespace(text=str(index)) for index, _ in enumerate(paths)]

    recognizer = NemoRecognizer()
    recognizer._model = Model()
    inputs = [AudioInput(pcm(index), 16000) for index in range(4)]
    for _ in range(2):
        assert [result.text for result in recognizer.transcribe_batch(inputs)] == ["0", "1", "2", "3"]
    assert recognizer._model.sizes == [4, 2, 2]
    assert recognizer.batch_limit == 2
    assert len(cache_clears) == 1


def test_stream_limit_rejects_extra_socket_and_releases_finished_slots(monkeypatch):
    monkeypatch.setattr(server, "MAX_STREAMS", 2)
    server.set_recognizer(StubRecognizer("hello"))
    try:
        with TestClient(server.app) as client:
            with client.websocket_connect("/stream") as first, client.websocket_connect("/stream"):
                with client.websocket_connect("/stream") as extra:
                    with pytest.raises(WebSocketDisconnect) as closed:
                        extra.receive_json()
                    assert closed.value.code == 1013
                first.send_json({"type": "eos"})
                assert first.receive_json()["type"] == "final"
                with client.websocket_connect("/stream") as replacement:
                    replacement.send_json({"type": "eos"})
                    assert replacement.receive_json()["type"] == "final"
            assert client.get("/healthz").json()["concurrency"]["active_streams"] == 0
    finally:
        server.set_recognizer(None)


def test_stream_audio_and_upload_limits_bound_memory(monkeypatch):
    monkeypatch.setattr(server, "MAX_AUDIO_SECONDS", 1)
    monkeypatch.setattr(server, "MAX_UPLOAD_BYTES", 1000)
    recognizer = StubRecognizer("hello")
    server.set_recognizer(recognizer)
    try:
        with TestClient(server.app) as client:
            assert client.post("/transcribe", files={"file": ("a.wav", wav(3))}).status_code == 413
            with client.websocket_connect("/stream") as ws:
                ws.send_bytes(pcm(3, 16001))
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 1009
            with client.websocket_connect("/stream") as ws:
                ws.send_json({"type": "start", "sampleRate": -1})
                with pytest.raises(WebSocketDisconnect) as closed:
                    ws.receive_json()
                assert closed.value.code == 1008
            assert client.get("/healthz").json()["concurrency"]["active_streams"] == 0
            assert recognizer.calls == 0
    finally:
        server.set_recognizer(None)


def test_disconnect_discards_queued_interim_and_releases_socket():
    entered, release = threading.Event(), threading.Event()

    class Gated(BatchRecognizer):
        def transcribe_batch(self, inputs):
            if not self.batches:
                entered.set()
                assert release.wait(3)
            return super().transcribe_batch(inputs)

    recognizer = Gated()
    server.set_recognizer(recognizer)

    def wait_for(client, condition):
        deadline = time.monotonic() + 1
        while time.monotonic() < deadline:
            if condition(client.get("/healthz").json()["concurrency"]):
                return
            time.sleep(0.005)
        raise AssertionError("stream lifecycle did not update the scheduler")

    try:
        with TestClient(server.app) as client:
            with client.websocket_connect("/stream") as first:
                first.send_bytes(pcm(8000, 4800))
                assert entered.wait(1)
                try:
                    with client.websocket_connect("/stream") as abandoned:
                        abandoned.send_bytes(pcm(9000, 4800))
                        wait_for(client, lambda stats: stats["queued_interims"] == 1)
                    wait_for(client, lambda stats: stats["active_streams"] == 1
                             and stats["queued_interims"] == 0)
                    first.send_json({"type": "eos"})
                finally:
                    release.set()
                result = first.receive_json()
                while result["type"] == "interim":
                    result = first.receive_json()
                assert result["type"] == "final"
            wait_for(client, lambda stats: stats["active_streams"] == 0)
        assert all(9000 not in batch for batch in recognizer.batches)
    finally:
        release.set()
        server.set_recognizer(None)


def test_busy_http_returns_retry_after_without_running_the_model(monkeypatch):
    class BusyScheduler:
        async def submit(self, audio):
            raise ServiceBusy("ASR inference queue is full")

    recognizer = StubRecognizer("hello")
    server.set_recognizer(recognizer)
    monkeypatch.setattr(server, "get_scheduler", lambda: BusyScheduler())
    try:
        with TestClient(server.app) as client:
            response = client.post("/transcribe", files={"file": ("a.wav", wav(4))})
            assert response.status_code == 503
            assert response.headers["Retry-After"] == "1"
            assert recognizer.calls == 0
    finally:
        server.set_recognizer(None)
