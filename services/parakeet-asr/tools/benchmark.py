"""Measure simultaneous, real-time robot-style streams against a private ASR URL.

Use a 16 kHz mono PCM16 WAV containing speech. Reports final latency, errors,
interim coverage, queue pressure and, where nvidia-smi is available, GPU usage.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import math
import shutil
import time
import wave
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
import websockets


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, math.ceil(len(ordered) * fraction) - 1)], 1)


def number(value):
    try:
        return float(value.strip())
    except ValueError:  # WSL may return N/A for individual NVML fields
        return None


async def one_stream(ws, pcm, rate, frame_ms, start_at, expected):
    eos_at = None
    first_interim = None
    interims = 0
    final = None

    async def send():
        nonlocal eos_at
        await asyncio.sleep(max(0, start_at - time.monotonic()))
        await ws.send(json.dumps({"type": "start", "sampleRate": rate}))
        size = max(2, int(rate * 2 * frame_ms / 1000))
        size -= size % 2
        for offset in range(0, len(pcm), size):
            await asyncio.sleep(max(0, start_at + offset / (rate * 2) - time.monotonic()))
            await ws.send(pcm[offset:offset + size])
        await asyncio.sleep(max(0, start_at + len(pcm) / (rate * 2) - time.monotonic()))
        eos_at = time.monotonic()
        await ws.send(json.dumps({"type": "eos"}))

    async def receive():
        nonlocal first_interim, interims, final
        async for raw in ws:
            message = json.loads(raw)
            if message.get("type") == "interim":
                interims += 1
                if first_interim is None:
                    first_interim = (time.monotonic() - start_at) * 1000
            elif message.get("type") == "final":
                if eos_at is None:
                    raise RuntimeError("final arrived before EOS")
                final = {"final_ms": (time.monotonic() - eos_at) * 1000,
                         "first_interim_ms": first_interim, "interims": interims,
                         "text": message.get("text", "")}
                if not final["text"]:
                    raise RuntimeError("empty final transcript for speech")
                if expected and final["text"] != expected:
                    raise RuntimeError(f"unexpected transcript: {final['text']!r}")
                return
        raise RuntimeError("socket closed without a final transcript")

    tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
    try:
        await asyncio.wait_for(asyncio.gather(*tasks), len(pcm) / (rate * 2) + 35)
        return final
    except Exception as error:
        return {"error": str(error)}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def sample_usage(http, url, stop, records, gpu_exe):
    while not stop.is_set():
        record = {}
        try:
            response = await http.get(url + "/healthz")
            response.raise_for_status()
            record["concurrency"] = response.json().get("concurrency")
        except Exception as error:
            record["health_error"] = str(error)
        if gpu_exe:
            process = None
            try:
                process = await asyncio.create_subprocess_exec(
                    gpu_exe, "--query-gpu=memory.used,memory.total,utilization.gpu",
                    "--format=csv,noheader,nounits", stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE)
                output, _ = await asyncio.wait_for(process.communicate(), 3)
                if process.returncode == 0:
                    # Per GPU: total usage includes other applications on the PC.
                    record["gpus"] = [[number(value) for value in row.split(",")]
                                      for row in output.decode().strip().splitlines()]
            except Exception:
                if process and process.returncode is None:
                    process.kill()
                    await process.wait()
        records.append(record)
        try:
            await asyncio.wait_for(stop.wait(), 0.5)
        except asyncio.TimeoutError:
            pass


async def benchmark(args, pcm, rate):
    url = args.url.rstrip("/")
    parsed = urlsplit(url)
    ws_url = urlunsplit(("wss" if parsed.scheme == "https" else "ws", parsed.netloc,
                        parsed.path.rstrip("/") + "/stream", "", ""))
    gpu_exe = shutil.which("nvidia-smi")
    if not gpu_exe and Path("/usr/lib/wsl/lib/nvidia-smi").is_file():
        gpu_exe = "/usr/lib/wsl/lib/nvidia-smi"
    async with httpx.AsyncClient(timeout=5) as http:
        health = await http.get(url + "/healthz")
        health.raise_for_status()
        print(json.dumps({"health": health.json(), "audio_seconds": len(pcm) / (rate * 2),
                          "gpu_sampling": bool(gpu_exe)}), flush=True)
        failed = False
        for count in args.streams:
            results, usage = [], []
            stop = asyncio.Event()
            sampler = asyncio.create_task(sample_usage(http, url, stop, usage, gpu_exe))
            try:
                for _ in range(args.rounds):
                    sockets = []
                    try:
                        for _ in range(count):
                            sockets.append(await websockets.connect(ws_url, open_timeout=5))
                        start_at = time.monotonic() + 0.1
                        results.extend(await asyncio.gather(*[
                            one_stream(ws, pcm, rate, args.frame_ms, start_at, args.expected_text)
                            for ws in sockets]))
                    except Exception as error:
                        results.append({"error": str(error)})
                    finally:
                        await asyncio.gather(*[ws.close() for ws in sockets], return_exceptions=True)
                    if any("error" in result for result in results):
                        break
            finally:
                stop.set()
                await sampler
            completed = [result for result in results if "error" not in result]
            latencies = [result["final_ms"] for result in completed]
            final_p95 = percentile(latencies, 0.95)
            errors = [result["error"] for result in results if "error" in result]
            concurrency = [row["concurrency"] for row in usage if row.get("concurrency")]
            gpus = [gpu for row in usage for gpu in row.get("gpus", [])]
            row = {"streams": count, "completed": len(completed), "errors": errors,
                   "final_p50_ms": percentile(latencies, 0.5), "final_p95_ms": final_p95,
                   "final_max_ms": round(max(latencies), 1) if latencies else None,
                   "streams_with_interims": sum(result["interims"] > 0 for result in completed),
                   "first_interim_p95_ms": percentile(
                       [result["first_interim_ms"] for result in completed
                        if result["first_interim_ms"] is not None], 0.95),
                   "health_errors": sum("health_error" in entry for entry in usage),
                   "max_queued": max((entry["queued_finals"] + entry["queued_interims"]
                                      for entry in concurrency), default=None),
                   "largest_batch": max((entry["largest_batch"] for entry in concurrency), default=None),
                   "gpu_peak_used_mib": max((gpu[0] for gpu in gpus if gpu[0] is not None), default=None),
                   "gpu_total_mib": max((gpu[1] for gpu in gpus if gpu[1] is not None), default=None),
                   "gpu_peak_util_percent": max((gpu[2] for gpu in gpus if gpu[2] is not None), default=None)}
            print(json.dumps(row), flush=True)
            if (errors or row["health_errors"] or final_p95 is None
                    or final_p95 > args.max_final_ms):
                failed = True
                break  # stop increasing load when it no longer meets the budget
        return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:6972")
    parser.add_argument("--wav", required=True)
    parser.add_argument("--streams", nargs="+", type=int, default=[1, 4, 8, 16, 32])
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--frame-ms", type=int, default=100)
    parser.add_argument("--max-final-ms", type=int, default=2000)
    parser.add_argument("--expected-text", help="Require this exact normalized final transcript")
    args = parser.parse_args()
    if min(*args.streams, args.rounds, args.frame_ms, args.max_final_ms) < 1:
        parser.error("stream counts, rounds, frame size and latency budget must be positive")
    with wave.open(args.wav, "rb") as audio:
        if (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) != (1, 2, 16000):
            parser.error("use a 16 kHz mono PCM16 WAV")
        pcm = audio.readframes(audio.getnframes())
        rate = audio.getframerate()
    if not pcm or len(pcm) > 30 * rate * 2:
        parser.error("use a speech recording of at most 30 seconds")
    return asyncio.run(benchmark(args, pcm, rate))


if __name__ == "__main__":
    raise SystemExit(main())
