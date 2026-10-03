"""Bounded, priority-aware dynamic batching for one resident ASR model.

NeMo's transcribe() changes shared model state. One worker owns it; concurrency
comes from passing several independent recordings to a single model call.
"""
from __future__ import annotations

import asyncio
import tempfile
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .recognizer import AudioInput, Recognizer, Transcript


class ServiceBusy(RuntimeError):
    pass


@dataclass
class _Job:
    audio: AudioInput
    result: asyncio.Future


class InferenceScheduler:
    def __init__(self, recognizer: Recognizer, *, batch_size: int = 4,
                 batch_wait_ms: int = 10, max_pending: int = 64,
                 max_streams: int = 32) -> None:
        if min(batch_size, max_pending, max_streams) < 1 or batch_wait_ms < 0:
            raise ValueError("ASR concurrency limits must be positive; batch wait must be nonnegative")
        self.recognizer = recognizer
        self.batching = callable(getattr(recognizer, "transcribe_batch", None))
        self.batch_size = batch_size if self.batching else 1
        self.batch_wait_ms = batch_wait_ms if self.batching else 0
        self.max_pending = max_pending
        self.max_streams = max_streams
        self.active_streams = 0
        self.in_flight = 0
        self.completed = 0
        self.failed = 0
        self.batches = 0
        self.largest_batch = 0
        self.overloads = 0
        self._finals: deque[_Job] = deque()
        self._interims: deque[_Job] = deque()
        self._wake = asyncio.Event()
        self._closed = False
        self._runner = None
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="parakeet-infer")

    def start(self) -> None:
        self._runner = asyncio.create_task(self._run())

    def _prune(self) -> None:
        # A cancelled socket or superseded interim must free its queue slot
        # immediately, even while a previous GPU batch is still running.
        self._finals = deque(job for job in self._finals if not job.result.done())
        self._interims = deque(job for job in self._interims if not job.result.done())

    def acquire_stream(self) -> None:
        if self._closed or self.active_streams >= self.max_streams:
            self.overloads += 1
            raise ServiceBusy("ASR stream capacity reached")
        self.active_streams += 1

    def release_stream(self) -> None:
        self.active_streams -= 1

    async def submit(self, audio: AudioInput, *, final: bool = True) -> Transcript:
        self._prune()
        if self._closed or len(self._finals) + len(self._interims) + self.in_flight >= self.max_pending:
            self.overloads += 1
            raise ServiceBusy("ASR inference queue is full")
        result = asyncio.get_running_loop().create_future()
        job = _Job(audio, result)
        (self._finals if final else self._interims).append(job)
        self._wake.set()
        return await result

    def stats(self) -> dict:
        self._prune()
        return {
            "batching": self.batching,
            "batch_size": self.batch_size,
            "batch_wait_ms": self.batch_wait_ms,
            "max_streams": self.max_streams,
            "max_pending": self.max_pending,
            "active_streams": self.active_streams,
            "queued_finals": len(self._finals),
            "queued_interims": len(self._interims),
            "in_flight": self.in_flight,
            "completed": self.completed,
            "failed": self.failed,
            "batches": self.batches,
            "largest_batch": self.largest_batch,
            "model_batch_limit": getattr(self.recognizer, "batch_limit", None),
            "overloads": self.overloads,
        }

    def _decode(self, audio: list[AudioInput]) -> list[Transcript | Exception]:
        if self.batching:
            return getattr(self.recognizer, "transcribe_batch")(audio)
        # CPU fallback and injected recognizers retain the original interface.
        results = []
        for item in audio:
            try:
                if item.sample_rate is not None:
                    result = self.recognizer.transcribe_pcm(item.data, item.sample_rate)
                else:
                    # The worker owns the file through completion, including
                    # when an HTTP caller cancels while inference is running.
                    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
                        tmp.write(item.data)
                        tmp.flush()
                        result = self.recognizer.transcribe_wav(tmp.name)
                results.append(result)
            except Exception as error:
                results.append(error)
        return results

    async def _run(self) -> None:
        while True:
            self._prune()
            if not self._finals and not self._interims:
                if self._closed:
                    return
                self._wake.clear()
                await self._wake.wait()
                # A small collection window makes simultaneously arriving jobs
                # one batch. Jobs queued during a GPU call need no extra wait.
                if self.batch_wait_ms and not self._closed:
                    await asyncio.sleep(self.batch_wait_ms / 1000)
                self._prune()
            jobs = []
            for queue in (self._finals, self._interims):
                while queue and len(jobs) < self.batch_size:
                    job = queue.popleft()
                    if not job.result.done():
                        jobs.append(job)
            if not jobs:
                continue
            self.in_flight = len(jobs)
            self.batches += 1
            self.largest_batch = max(self.largest_batch, len(jobs))
            try:
                results = await asyncio.get_running_loop().run_in_executor(
                    self._executor, self._decode, [job.audio for job in jobs])
                if len(results) != len(jobs):
                    raise RuntimeError("Recognizer returned the wrong number of batch results")
            except Exception as error:
                results = [error] * len(jobs)
            self.in_flight = 0
            for job, result in zip(jobs, results):
                if isinstance(result, Exception):
                    self.failed += 1
                    if not job.result.done():
                        job.result.set_exception(result)
                else:
                    self.completed += 1
                    if not job.result.done():
                        job.result.set_result(result)

    async def close(self) -> None:
        self._closed = True
        for job in (*self._finals, *self._interims):
            if not job.result.done():
                job.result.set_exception(ServiceBusy("ASR is shutting down"))
        self._wake.set()
        if self._runner is not None:
            await self._runner
        self._executor.shutdown(wait=True)
