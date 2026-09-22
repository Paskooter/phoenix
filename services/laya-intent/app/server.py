"""Bounded, authenticated HTTP wrapper around the Laya decision engine.

The service is intended for a trusted LAN/VPN hop from Phoenix.  It is not a
general Laya API: callers select one of the server-owned profiles and submit
only a bounded utterance.  No request utterance is written to logs.
"""

from __future__ import annotations

import asyncio
import hmac
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Awaitable, Callable

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from .classifier import Classification, create_classifier
from .profiles import Profile, load_profiles


SERVICE_VERSION = "0.1.0"
MAX_BODY_BYTES = int(os.environ.get("LAYA_MAX_BODY_BYTES", "16384"))
MAX_TEXT_CHARS = int(os.environ.get("LAYA_MAX_TEXT_CHARS", "2048"))
MAX_CONCURRENCY = int(os.environ.get("LAYA_MAX_CONCURRENCY", "2"))
QUEUE_TIMEOUT_MS = int(os.environ.get("LAYA_QUEUE_TIMEOUT_MS", "50"))
INFERENCE_TIMEOUT_MS = int(os.environ.get("LAYA_INFERENCE_TIMEOUT_MS", "750"))
AUTH_TOKEN = os.environ.get("LAYA_AUTH_TOKEN", "").strip()

if MAX_BODY_BYTES < 1024 or MAX_BODY_BYTES > 1_048_576:
    raise RuntimeError("LAYA_MAX_BODY_BYTES must be between 1024 and 1048576")
if MAX_TEXT_CHARS < 1 or MAX_TEXT_CHARS > 16_384:
    raise RuntimeError("LAYA_MAX_TEXT_CHARS must be between 1 and 16384")
if MAX_CONCURRENCY < 1 or MAX_CONCURRENCY > 32:
    raise RuntimeError("LAYA_MAX_CONCURRENCY must be between 1 and 32")
if QUEUE_TIMEOUT_MS < 1 or QUEUE_TIMEOUT_MS > 10_000:
    raise RuntimeError("LAYA_QUEUE_TIMEOUT_MS must be between 1 and 10000")
if INFERENCE_TIMEOUT_MS < 1 or INFERENCE_TIMEOUT_MS > 30_000:
    raise RuntimeError("LAYA_INFERENCE_TIMEOUT_MS must be between 1 and 30000")


class ClassifyRequest(BaseModel):
    # Reject unknown fields so clients cannot smuggle instructions or model
    # selection into a future-compatible request shape.
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=MAX_TEXT_CHARS)
    profile: str | None = Field(default=None, min_length=1, max_length=64)

    @field_validator("text")
    @classmethod
    def bounded_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        if "\x00" in value:
            raise ValueError("text contains a NUL byte")
        return value

    @field_validator("profile")
    @classmethod
    def bounded_profile(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("profile must not be blank")
        return value


class BodyLimitMiddleware:
    """Reject oversized bodies before Starlette's JSON parser allocates them."""

    def __init__(self, app: Callable[..., Awaitable[Any]], limit: int):
        self.app = app
        self.limit = limit

    async def __call__(self, scope: dict[str, Any], receive: Callable, send: Callable):
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        content_length = headers.get(b"content-length")
        if content_length is not None:
            try:
                if int(content_length) > self.limit:
                    await self._reject(send, 413, "request body too large")
                    return
            except ValueError:
                await self._reject(send, 400, "invalid content length")
                return

        received = 0
        messages: list[dict[str, Any]] = []
        while True:
            message = await receive()
            messages.append(message)
            received += len(message.get("body", b""))
            if received > self.limit:
                await self._reject(send, 413, "request body too large")
                return
            if not message.get("more_body", False):
                break

        iterator = iter(messages)

        async def replay_receive() -> dict[str, Any]:
            try:
                return next(iterator)
            except StopIteration:
                return {"type": "http.disconnect"}

        await self.app(scope, replay_receive, send)

    async def _reject(self, send: Callable, status: int, detail: str) -> None:
        body = (f'{{"detail":"{detail}"}}').encode("utf-8")
        await send({
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())],
        })
        await send({"type": "http.response.body", "body": body})


profiles: dict[str, Profile] = {}
root_profiles: set[str] = set()
classifier = None
semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


def _authorized(request: Request) -> bool:
    # A missing configured token is allowed only for local contract tests. The
    # production Compose file requires LAYA_AUTH_TOKEN and the lifespan refuses
    # to start a non-stub service without it.
    if not AUTH_TOKEN:
        return os.environ.get("LAYA_BACKEND", "laya").strip().lower() == "stub"
    supplied = request.headers.get("authorization", "")
    scheme, _, value = supplied.partition(" ")
    return scheme.lower() == "bearer" and hmac.compare_digest(value, AUTH_TOKEN)


def _classification_payload(
    result: Classification,
    profile: Profile,
    route: list[str],
    elapsed_ms: float,
) -> dict[str, Any]:
    ordered_probabilities = sorted((float(value) for value in result.probabilities.values()), reverse=True)
    top_probability = ordered_probabilities[0] if ordered_probabilities else 0.0
    margin = top_probability - ordered_probabilities[1] if len(ordered_probabilities) > 1 else top_probability
    return {
        "intent": result.intent,
        "unknown": result.unknown,
        # Laya's own `confidence` is entropy-derived and is not the selected
        # candidate probability. Expose probability and margin separately so
        # clients can apply a threshold with the same meaning as the server.
        "confidence": round(float(result.confidence), 4),
        "top_probability": round(top_probability, 4),
        "margin": round(margin, 4),
        "probabilities": {key: round(float(value), 4) for key, value in result.probabilities.items()},
        "profile": profile.name,
        "route": route,
        "reason": result.reason,
        "latency_ms": round(elapsed_ms, 2),
        "service_version": SERVICE_VERSION,
    }


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global profiles, root_profiles, classifier
    profiles = load_profiles()
    child_profiles = {child for profile in profiles.values() for child in profile.children.values()}
    root_profiles = set(profiles) - child_profiles
    if not root_profiles:
        raise RuntimeError("Laya profile hierarchy has no root profile")
    classifier = create_classifier()
    backend = os.environ.get("LAYA_BACKEND", "laya").strip().lower()
    if backend != "stub" and not AUTH_TOKEN:
        raise RuntimeError("LAYA_AUTH_TOKEN is required for the production backend")
    classifier.load()
    # Fail before readiness if the fixed model cannot complete a complete
    # server-owned decision.  This input is constant and never a user utterance.
    default_profile = os.environ.get("LAYA_DEFAULT_PROFILE", "phoenix-core")
    if default_profile not in root_profiles:
        raise RuntimeError("LAYA_DEFAULT_PROFILE must name a root profile")
    warm_profile = profiles[default_profile]
    _classify_tree("warmup", warm_profile)
    yield


app = FastAPI(title="Phoenix Laya Intent Service", version=SERVICE_VERSION, lifespan=lifespan)
app.add_middleware(BodyLimitMiddleware, limit=MAX_BODY_BYTES)


@app.exception_handler(Exception)
async def safe_exception_handler(_request: Request, exc: Exception):
    # Never include exception text from model/tokenizer libraries in a public
    # response; some libraries echo input text. The process logs also omit it.
    if isinstance(exc, HTTPException):
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})
    return JSONResponse(status_code=500, content={"detail": "internal classifier error"})


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    return {"ok": True, "service": "laya-intent", "service_version": SERVICE_VERSION}


@app.get("/readyz")
async def readyz() -> dict[str, Any]:
    if classifier is None or not getattr(classifier, "ready", False):
        return JSONResponse(status_code=503, content={"ready": False, "service": "laya-intent"})
    return {
        "ready": True,
        "service": "laya-intent",
        "service_version": SERVICE_VERSION,
        "profiles": sorted(profiles),
        "root_profiles": sorted(root_profiles),
        "device": getattr(classifier, "device", None),
    }


@app.post("/v1/classify")
async def classify(request: Request, body: ClassifyRequest) -> dict[str, Any]:
    if not _authorized(request):
        raise HTTPException(status_code=401, detail="unauthorized")
    if classifier is None or not getattr(classifier, "ready", False):
        raise HTTPException(status_code=503, detail="classifier not ready")
    profile_name = body.profile or os.environ.get("LAYA_DEFAULT_PROFILE", "phoenix-core")
    selected_profile = profiles.get(profile_name)
    if selected_profile is None or profile_name not in root_profiles:
        raise HTTPException(status_code=400, detail="unknown profile")

    try:
        await asyncio.wait_for(semaphore.acquire(), QUEUE_TIMEOUT_MS / 1000)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=429, detail="classifier busy", headers={"retry-after": "1"})
    started = time.perf_counter()
    release_permit = True
    try:
        work = asyncio.create_task(asyncio.to_thread(_classify_tree, body.text, selected_profile))
        try:
            # Shielding is deliberate: a Python worker thread running GPU
            # inference cannot be safely cancelled.  Keep its admission permit
            # until it actually finishes so timed-out clients cannot create an
            # unbounded backlog of still-running model calls.
            result, profile, route = await asyncio.wait_for(asyncio.shield(work), INFERENCE_TIMEOUT_MS / 1000)
        except asyncio.TimeoutError:
            release_permit = False
            work.add_done_callback(_release_completed_work)
            raise HTTPException(status_code=504, detail="classifier timeout")
        except asyncio.CancelledError:
            release_permit = False
            work.add_done_callback(_release_completed_work)
            raise
        except HTTPException:
            raise
        except Exception:
            raise HTTPException(status_code=503, detail="classifier unavailable")
        return _classification_payload(result, profile, route, (time.perf_counter() - started) * 1000)
    finally:
        if release_permit:
            semaphore.release()


def _release_completed_work(work: asyncio.Task) -> None:
    """Consume a late worker exception and release the permit exactly once."""
    try:
        work.result()
    except (asyncio.CancelledError, Exception):
        pass
    semaphore.release()


def _classify_tree(text: str, profile: Profile) -> tuple[Classification, Profile, list[str]]:
    """Walk only server-owned profile edges, ending on an allowed intent leaf."""
    route = [profile.name]
    # Cycles are rejected when profiles load.  This guard also keeps a manually
    # injected test profile from consuming inference capacity indefinitely.
    for _depth in range(8):
        result = classifier.classify(text, profile)
        child_name = profile.children.get(result.intent or "")
        if result.unknown or child_name is None:
            return result, profile, route
        profile = profiles[child_name]
        route.append(profile.name)
    raise RuntimeError("profile hierarchy exceeded maximum depth")
