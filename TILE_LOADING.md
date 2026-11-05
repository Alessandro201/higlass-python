# Notebook tile-loading fix

This branch starts at higlass-python 1.4.0 (815e4aad8d2f83a12974ac2ffc58ec184509fcb1).
The installable fork version is `1.4.0+tilefix.1`.
It requires the paired HiGlass branch, based on JavaScript 2.2.3
(490ef57599a519534df577e4b90eb9ced6367975).

## Build and install in an existing uv project

Use Node 22+ and uv. Commands below work in fish on macOS and Linux.
Choose a folder for the two checkouts, separate from your existing uv project.

```fish
git clone --branch fix/notebook-tile-loading https://github.com/Alessandro201/higlass.git
git clone --branch fix/notebook-tile-loading https://github.com/Alessandro201/higlass-python.git
cd higlass
npm ci
npm run build
cd ../higlass-python
node scripts/build-widget.mjs ../higlass
uv build --wheel
```

From your existing project, install the generated wheel (replace the absolute path):

```fish
cd /absolute/path/to/your/project
uv add /absolute/path/to/higlass-python/dist/higlass_python-*.whl
```

For an editable installation of the same built checkout:

```fish
uv add --editable /absolute/path/to/higlass-python
```

To change only the existing environment without editing pyproject.toml/uv.lock:

```fish
uv pip install --python /absolute/path/to/your/project/.venv/bin/python /absolute/path/to/higlass-python/dist/higlass_python-*.whl
```

The latter may be reverted by a later `uv sync`; prefer `uv add` for persistent use.
Keep higlass-schema 0.2.1, clodius 0.22.2, and cooler 0.12.1 for comparison with your
reported environment. Restart the Jupyter kernel and recreate widgets after installing.
Launch JupyterLab using the environment containing the patched package.

The build embeds the paired HiGlass JavaScript and its React/Pixi dependencies in
`widget.bundle.js`. No unchanged HiGlass CDN import is used at runtime. The widget
checks `NOTEBOOK_TILE_PROTOCOL`; an unbuilt source checkout raises a clear error.
Rebuild the bundle after editing either JavaScript checkout.

The `Notebook tile loading` GitHub Actions workflow also builds wheel artifacts.

## Confirmed code defects

- The old bridge imposed a three-second deadline without cancelling Python work.
  Its batch rejection was unobserved and constituent requests never settled.
- Python discarded executor futures, so provider exceptions produced no response.
- TiledPixiTrack removed `fetching` entries only for returned tiles. Rejections and
  missing tiles could permanently suppress requests, including navigation back.
- DataFetcher dereferenced missing entries (and the first entry of an empty response).
- The global notebook fetcher captured the first client, and widget cleanup only
  detached wheel/context-menu listeners. Fetchers now belong to a rendered widget,
  while read sharing belongs to the actual tileset model.

Upstream inspected: higlass-python e89814c8c29685d05b205bb036f2af367d6ce86b,
HiGlass b35461175d6593aaa94147ec4885200c7f1f5e5a, and
Clodius 39ec67d48fa49d1be9b89c63ca0abb5fae93c7dd.
The relevant Python/widget and TiledPixiTrack/HorizontalHeatmapTrack files were
identical to the supplied releases. DataFetcher's differences were only a removed
comment and whitespace. Clodius's upstream head was the 0.22.2 commit. None fixes
these request-lifecycle bugs.

## Behavior and limits

- Two concurrent physical requests per tileset model, at most 256 frontend jobs,
  two Python workers, and 32 accepted Python requests. Frontend batches contain
  one tile, delivered immediately on completion. Python also caps legacy batches
  at 16 tiles. Overflow is an explicit failure and permits bounded retries.
- Visible requests are shared by tile ID, including resolution and transform.
  Each consumer releases its own interest. Removing the last consumer drops queued
  work and asks Python to cancel work that has not started.
- Running work keeps its physical slot until Python replies. Neither AbortSignal
  nor Future.cancel interrupts an HDF5 read. A genuinely hung provider can still
  occupy a worker indefinitely; this patch does not kill threads or HDF5 reads.
- Failures permit two automatic retries after the initial attempt. A changed
  viewport resets the retry budget, including navigation back to failed tiles.
  Request identity prevents old responses from clearing new fetching state.
- Coarse graphics remain during refinement and expire after a bounded grace
  period if replacements fail. Their age is independent of later navigation.
  In-progress rendering is allowed to finish before graphics destruction.
- HorizontalHeatmapTrack's rotated-domain padding and visibility calculations are
  unchanged. This patch adds no speculative outward prefetch.

## Diagnostics and performance

Set `globalThis.HIGLASS_TILE_DEBUG = true` in the browser developer console before
navigation. `higlass.tile` reports frontend queue delay, Python queue/read time,
serialization time, serialized payload bytes, and request round-trip time.
`higlass.viewport` reports time from the current tile-set change until graphics
work completes and the following animation frame. This is a browser render-frame
measurement, not a GPU presentation timestamp. Records include tile/request or
track/viewport identity. The frontend diagnostic buffer is capped at 256 requests.
Python errors include request ID, exception type/message, and tile IDs; full
tracebacks are logged to `higlass.widget` in the kernel.

Deterministic local tests measured a 200 ms slow tile holding a fast tile for about
204 ms in a batch, versus about 2 ms for independent requests with two workers.
A real 3.1-second deterministic read completed successfully, with about 0.3 ms
queue delay and a 29-byte payload. These are synthetic measurements, not .mcool
performance claims. Single-tile batches can sacrifice Clodius's adjacent-tile
coalescing and increase comm overhead; real-file throughput remains to be profiled.
No representative .mcool file was supplied. HDF5 locking, compression, filesystem
latency, matrix conversion, serialization and GPU rendering remain performance
hypotheses until measured with your data. Do not raise concurrency without those
measurements.

## Tests

From the Python checkout, with the paired HiGlass checkout next to it:

```fish
node --test test/js/*.test.mjs
python -m unittest discover -s test/bridge -v
node scripts/browser-smoke.mjs ../higlass
```

The first two run with Node/Python's standard libraries. They execute production
request code and production HiGlass track methods; graphical dependencies are
stubbed in these unit tests. Browser smoke testing uses the actual bundled widget,
HiGlass, React and Pixi, with deterministic encoded heatmap tiles. It writes
`test-results/browser.json` and `test-results/widget.png`.

Coverage includes reads beyond three seconds, exceptions, missing/error tiles,
rapid viewport/resolution changes, out-of-order replies, retries after navigation
back, multiple tracks/widgets sharing a tile, separate client routing, bounded
queues and retry counts, retained coarse tiles, and disposal during active work.


## Validation results

The paired build passed on the macOS 14 GitHub runner with Python 3.12,
higlass-schema 0.2.1, clodius 0.22.2, and cooler 0.12.1: 144 Python tests,
17 JavaScript regression tests, HiGlass typechecking/build, and the browser smoke test.
The browser rendered two horizontal heatmap tracks after a 3.1-second tile response,
recovered from an injected provider error, and handled rapid navigation. Disposal
left zero comm listeners, widget listeners, and canvas elements; no uncaught browser
errors were observed. The final synthetic viewport reached a render frame in about
313 ms for both tracks, with 349,600-byte encoded tile payloads and frontend queue
delays of 0–43 ms. Browser provider read delays were simulated; they do not measure HDF5.
The real Clodius/Cooler test separately reads a tiny generated two-resolution .mcool.

A standalone original-code reproducer is included. To run it from this checkout:

```fish
git show 815e4aad8d2f83a12974ac2ffc58ec184509fcb1:src/higlass/widget.js > /tmp/higlass-original-widget.js
node scripts/reproduce-baseline.mjs /tmp/higlass-original-widget.js
```

It reproduced the default timeout at about 3,006 ms and two constituent promises
still pending after their batch rejected. The track regression suite also failed
against unmodified upstream. An additional geometry regression verifies that the
horizontal heatmap still includes the rotated coverage beyond the genomic interval.
