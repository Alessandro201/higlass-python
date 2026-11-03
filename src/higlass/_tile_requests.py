"""Bounded notebook requests; cancellation never interrupts a running provider."""

from __future__ import annotations

import concurrent.futures
import json
import logging
import threading
import time

logger = logging.getLogger("higlass.widget")


class TileRequests:
    """Own pending futures and send exactly one terminal response per request."""

    def __init__(self, registry, send, *, workers=2, capacity=32, max_tiles=16):
        self.registry = registry
        self.send = send
        self.capacity = capacity
        self.max_tiles = max_tiles
        self.executor = concurrent.futures.ThreadPoolExecutor(max_workers=workers)
        self.pending = {}
        self.lock = threading.RLock()
        self.closed = False

    def handle(self, message):
        """Submit bounded work or cancel a queued request by its original ID."""
        request_id = message["id"]
        payload = message["payload"]
        with self.lock:
            if self.closed:
                return
            if payload["type"] == "cancel":
                future = self.pending.get(request_id)
                if future is not None:
                    future.cancel()
                return
            if request_id in self.pending:
                return
            if len(self.pending) >= self.capacity:
                self.send({"id": request_id, "error": {
                    "type": "QueueFull", "message": "Tile request capacity reached",
                    "request": payload,
                }})
                return
            queued = time.perf_counter()
            future = self.executor.submit(self._process, request_id, payload, queued)
            self.pending[request_id] = future
            future.add_done_callback(lambda result: self._complete(request_id, result))

    def _process(self, request_id, payload, queued):
        """Read and validate the response, including JSON serialization failures."""
        started = time.perf_counter()
        response = {"id": request_id}
        try:
            if payload["type"] == "tileset_info":
                uid = payload["tilesetUid"]
                result = {uid: self.registry.get(uid).info()}
            elif payload["type"] == "tiles":
                tile_ids = payload["tileIds"]
                if len(tile_ids) > self.max_tiles:
                    raise ValueError(f"At most {self.max_tiles} tiles per request")
                groups = {}
                for tile_id in tile_ids:
                    groups.setdefault(tile_id.split(".")[0], []).append(tile_id)
                result = {}
                for uid, ids in groups.items():
                    result.update(self.registry.get(uid).tiles(ids))
                missing = [tile_id for tile_id in tile_ids if result.get(tile_id) is None]
                if missing:
                    raise ValueError(f"Provider omitted tiles: {missing}")
            else:
                raise ValueError(f"Unknown request type: {payload['type']}")
            read_finished = time.perf_counter()
            response["payload"] = result
            response_bytes = len(json.dumps(result).encode("utf-8"))
        except Exception as error:
            read_finished = time.perf_counter()
            response.pop("payload", None)
            response["error"] = {
                "type": type(error).__name__, "message": str(error), "request": payload,
            }
            response_bytes = len(json.dumps(response["error"]).encode("utf-8"))
            logger.exception(f"Tile request {request_id} failed: {payload}")
        response["metrics"] = {
            "queue_ms": (started - queued) * 1000,
            "read_ms": (read_finished - started) * 1000,
            "serialize_ms": (time.perf_counter() - read_finished) * 1000,
            "response_bytes": response_bytes,
        }
        return response

    def _complete(self, request_id, future):
        """Release capacity even on failure and acknowledge queued cancellation."""
        with self.lock:
            self.pending.pop(request_id, None)
            if self.closed:
                return
            if future.cancelled():
                response = {"id": request_id, "error": {
                    "type": "AbortError", "message": "Queued request cancelled",
                }}
            else:
                response = future.result()
            self.send(response)

    def close(self):
        """Discard queued work; running reads finish without sending to a closed comm."""
        with self.lock:
            self.closed = True
            for future in list(self.pending.values()):
                future.cancel()
        self.executor.shutdown(wait=False, cancel_futures=True)
