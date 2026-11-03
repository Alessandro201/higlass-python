"""Exercise the real executor/dispatcher without requiring Jupyter to be installed."""
import importlib.util
import pathlib
import threading
import time
import unittest

path = pathlib.Path(__file__).parents[2] / "src/higlass/_tile_requests.py"
spec = importlib.util.spec_from_file_location("tile_requests", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Provider:
    """Deterministic delayed, failing, missing, and malformed tile provider."""

    def __init__(self):
        self.delay = 0
        self.error = None
        self.missing = False
        self.started = threading.Event()

    def tiles(self, ids):
        """Model a non-interruptible read and return encoded tile data."""
        self.started.set()
        time.sleep(self.delay)
        if self.error:
            raise self.error
        return [] if self.missing else [(tile_id, {"dense": [1]}) for tile_id in ids]

    def info(self):
        """Return minimal tileset metadata."""
        return {"max_zoom": 2}


class RequestsTests(unittest.TestCase):
    """Check terminal responses and resource bounds with real worker threads."""

    def setUp(self):
        """Create an isolated request queue and provider."""
        self.provider = Provider()
        self.responses = []
        self.queue = module.TileRequests({"uid": self.provider}, self.responses.append,
                                         workers=1, capacity=3)

    def tearDown(self):
        """Release worker resources even after assertion failures."""
        self.queue.close()
        self.queue.executor.shutdown(wait=True)

    def submit(self, request_id, tile="uid.0.0.0"):
        """Submit a single-tile request."""
        self.queue.handle({"id": request_id, "payload": {"type": "tiles", "tileIds": [tile]}})

    def wait_responses(self, count, timeout=5):
        """Wait for worker completion with a bounded deadline."""
        deadline = time.monotonic() + timeout
        while len(self.responses) < count and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(len(self.responses), count)

    def test_read_over_three_seconds(self):
        """A long read returns once, with queue/read/serialization diagnostics."""
        self.provider.delay = 3.1
        self.submit("slow")
        self.wait_responses(1)
        response = self.responses[0]
        self.assertIn("payload", response)
        self.assertGreaterEqual(response["metrics"]["read_ms"], 3100)
        self.assertGreater(response["metrics"]["response_bytes"], 0)
        self.assertEqual(self.queue.pending, {})
        print(f"slow provider metrics: {response['metrics']}")

    def test_exception_missing_and_later_retry(self):
        """Failure details reach the frontend; navigation back can retry normally."""
        self.provider.error = OSError("broken HDF5 read")
        self.submit("failure"); self.wait_responses(1)
        self.assertEqual(self.responses[0]["error"]["type"], "OSError")
        self.assertEqual(self.responses[0]["error"]["request"]["tileIds"], ["uid.0.0.0"])
        self.provider.error = None; self.provider.missing = True
        self.submit("missing"); self.wait_responses(2)
        self.assertIn("omitted", self.responses[1]["error"]["message"])
        self.provider.missing = False
        self.submit("retry"); self.wait_responses(3)
        self.assertIn("payload", self.responses[2])

    def test_cancel_queued_not_running(self):
        """Queued cancellation responds immediately; running work finishes normally."""
        self.provider.delay = 0.15
        self.submit("running"); self.provider.started.wait(1)
        self.submit("queued")
        for request_id in ["queued", "running"]:
            self.queue.handle({"id": request_id, "payload": {"type": "cancel"}})
        self.wait_responses(2)
        self.assertEqual(self.responses[0]["id"], "queued")
        self.assertEqual(self.responses[0]["error"]["type"], "AbortError")
        self.assertIn("payload", self.responses[1])

    def test_capacity_batch_limit_and_serialization_error(self):
        """Reject excess work and unserializable results as structured failures."""
        self.provider.delay = 0.05
        for i in range(4):
            self.submit(f"request-{i}")
        self.wait_responses(4)
        self.assertEqual(self.responses[0]["error"]["type"], "QueueFull")
        self.queue.handle({"id": "big", "payload": {"type": "tiles", "tileIds": ["uid.0"] * 17}})
        self.wait_responses(5)
        self.assertIn("At most 16", self.responses[-1]["error"]["message"])
        self.provider.tiles = lambda ids: [(ids[0], {"bad": object()})]
        self.submit("invalid"); self.wait_responses(6)
        self.assertEqual(self.responses[-1]["error"]["type"], "TypeError")

    def test_close_discards_queued_and_suppresses_running_reply(self):
        """Closing the comm never sends a late response."""
        self.provider.delay = 0.1
        self.submit("running"); self.provider.started.wait(1)
        self.submit("queued")
        self.queue.close(); self.queue.executor.shutdown(wait=True)
        self.assertEqual(self.responses, [])
        self.assertEqual(self.queue.pending, {})

    def test_batched_head_of_line_blocking(self):
        """Measure aggregate delivery versus independent single-tile requests."""
        class MixedProvider:
            """Sleep only for the slow tile, regardless of batch order."""
            def tiles(self, ids):
                """Return the whole batch after its slowest member."""
                if "uid.slow" in ids:
                    time.sleep(0.2)
                return [(tile_id, {"dense": [1]}) for tile_id in ids]
        for batched in [True, False]:
            responses = []
            started = time.perf_counter()
            queue = module.TileRequests({"uid": MixedProvider()},
                lambda msg: responses.append((time.perf_counter() - started, msg)), workers=2)
            if batched:
                queue.handle({"id": "batch", "payload": {"type": "tiles", "tileIds": ["uid.slow", "uid.fast"]}})
            else:
                for tile in ["slow", "fast"]:
                    queue.handle({"id": tile, "payload": {"type": "tiles", "tileIds": [f"uid.{tile}"]}})
            queue.executor.shutdown(wait=True)
            fast = next((elapsed for elapsed, msg in responses if "uid.fast" in msg.get("payload", {})))
            print(f"batched={batched}: fast tile delivered after {fast * 1000:.2f} ms")
            if batched:
                self.assertGreaterEqual(fast, 0.2)
            else:
                self.assertLess(fast, 0.15)
            queue.close()


if __name__ == "__main__":
    unittest.main()
