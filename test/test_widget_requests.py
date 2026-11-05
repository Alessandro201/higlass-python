"""Integration tests with real ipywidgets, the event loop, and pinned tile libraries."""
import asyncio
import importlib.metadata
import threading

import numpy as np
import pandas as pd

from higlass._tileset_registry import TilesetRegistry
from higlass._widget import JupyterTilesetClient


def test_comm_response_uses_kernel_loop():
    """Worker failures must return on the owning loop with request context."""
    class Failing:
        """Provider with a deterministic I/O failure."""
        def tiles(self, ids):
            """Raise inside the executor thread."""
            raise OSError("fixture read failed")

    async def run():
        """Create and exercise the client while an event loop is running."""
        client = JupyterTilesetClient()
        provider = Failing()
        uid = TilesetRegistry.add(provider)
        responses = []
        event = asyncio.Event()
        owner = threading.get_ident()

        def send(response):
            """Capture the thread and signal response delivery."""
            responses.append((threading.get_ident(), response))
            event.set()

        client.send = send
        try:
            client._handle_custom_message(client, {"id": "failed", "payload": {
                "type": "tiles", "tileIds": [f"{uid}.0.0.0"],
            }}, [])
            await asyncio.wait_for(event.wait(), 5)
            assert len(responses) == 1
            assert responses[0][0] == owner
            assert responses[0][1]["error"]["type"] == "OSError"
            assert responses[0][1]["id"] == "failed"
        finally:
            client.close()
    asyncio.run(run())


def test_pinned_cooler_clodius_read(tmp_path):
    """Read a tiny synthetic multiresolution file through real Clodius 0.22.2."""
    import cooler
    import h5py
    from clodius.tiles import cooler as cooler_tiles

    for package, version in [("higlass-schema", "0.2.1"), ("clodius", "0.22.2"), ("cooler", "0.12.1")]:
        assert importlib.metadata.version(package) == version
    filename = tmp_path / "synthetic.mcool"
    for resolution in [1000, 2000]:
        count = 32_000 // resolution
        bins = pd.DataFrame({"chrom": ["chr1"] * count,
                             "start": np.arange(count) * resolution,
                             "end": (np.arange(count) + 1) * resolution})
        pixels = pd.DataFrame({"bin1_id": np.arange(count), "bin2_id": np.arange(count),
                               "count": np.ones(count, dtype=int)})
        cooler.create_cooler(f"{filename}::resolutions/{resolution}", bins, pixels, mode="a")
        with h5py.File(filename, "a") as handle:
            handle[f"resolutions/{resolution}/bins"].create_dataset("weight", data=np.ones(count))
    info = cooler_tiles.tileset_info(str(filename))
    assert sorted(info["resolutions"]) == [1000, 2000]
    result = dict(cooler_tiles.tiles(str(filename), ["test.0.0.0", "test.1.0.0"]))
    assert len(result) == 2
    assert all("dense" in tile for tile in result.values())
