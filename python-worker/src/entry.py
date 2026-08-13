from __future__ import annotations

import hashlib
import time
from urllib.parse import urlparse

from workers import DurableObject, Response, WorkerEntrypoint

from arena_hero_tactic.strategy_core.contracts import ContractError
from arena_hero_tactic.strategy_core.serialization import (
    InvalidJsonError,
    canonical_json,
    decode_tick_request_json,
    encode_tick_response,
    error_response,
)
from arena_hero_tactic.strategy_core.service import classify_ordering, execute_tick

MAX_REQUEST_BYTES = 2 * 1024 * 1024
JSON_HEADERS = {"Content-Type": "application/json; charset=utf-8"}


def _json_response(payload: object, status: int = 200) -> Response:
    return Response(canonical_json(payload), status=status, headers=JSON_HEADERS)


class StrategyPlanner(DurableObject):
    async def fetch(self, request):
        path = urlparse(request.url).path
        if request.method == "GET" and path == "/health":
            return _json_response(
                {
                    "ok": True,
                    "service": "arena-hero-python-strategy",
                    "contract_version": "1",
                    "strategy_version": "python-economy-v1",
                }
            )
        if request.method != "POST" or path != "/plan":
            return _json_response(
                error_response("NOT_FOUND", "unknown strategy route", retryable=False),
                404,
            )

        try:
            body = await request.text()
            if len(body.encode("utf-8")) > MAX_REQUEST_BYTES:
                return _json_response(
                    error_response(
                        "REQUEST_TOO_LARGE",
                        "strategy request exceeds the configured limit",
                        retryable=False,
                    ),
                    413,
                )
            digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
            decoded = decode_tick_request_json(body)
            last_tick = await self.ctx.storage.get("last_tick")
            last_digest = await self.ctx.storage.get("last_digest")
            ordering = classify_ordering(last_tick, last_digest, decoded.tick, digest)
            if ordering == "replay":
                cached = await self.ctx.storage.get("last_response")
                if isinstance(cached, str):
                    return Response(cached, status=200, headers=JSON_HEADERS)
                ordering = "conflict"
            if ordering == "stale":
                return _json_response(
                    error_response(
                        "STALE_TICK",
                        "request tick is older than the latest completed tick",
                        retryable=False,
                    ),
                    409,
                )
            if ordering == "conflict":
                return _json_response(
                    error_response(
                        "TICK_CONFLICT",
                        "the same tick was requested with different input",
                        retryable=False,
                    ),
                    409,
                )

            started = time.perf_counter()
            result = execute_tick(decoded)
            payload = encode_tick_response(
                decoded,
                result,
                (time.perf_counter() - started) * 1000.0,
            )
            response_body = canonical_json(payload)
            await self.ctx.storage.put(
                {
                    "last_tick": decoded.tick,
                    "last_digest": digest,
                    "last_response": response_body,
                }
            )
            return Response(response_body, status=200, headers=JSON_HEADERS)
        except InvalidJsonError as error:
            return _json_response(
                error_response("INVALID_JSON", str(error), retryable=False),
                400,
            )
        except ContractError as error:
            return _json_response(
                error_response("CONTRACT_ERROR", str(error), retryable=False),
                400,
            )
        except Exception as error:
            print(
                canonical_json(
                    {
                        "event": "strategy_failed",
                        "error_type": type(error).__name__,
                    }
                )
            )
            return _json_response(
                error_response(
                    "STRATEGY_ERROR",
                    type(error).__name__,
                    retryable=True,
                ),
                500,
            )


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        if request.method == "GET" and urlparse(request.url).path == "/health":
            return _json_response(
                {
                    "ok": True,
                    "service": "arena-hero-python-strategy",
                    "contract_version": "1",
                    "strategy_version": "python-economy-v1",
                }
            )
        return _json_response(
            error_response("NOT_FOUND", "unknown worker route", retryable=False),
            404,
        )
