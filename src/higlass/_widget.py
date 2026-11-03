from __future__ import annotations

import asyncio
import functools
import json
import logging
import pathlib
import typing

import anywidget
import ipywidgets
import pydantic
import traitlets as t

from higlass._tile_requests import TileRequests
from higlass._tileset_registry import TilesetRegistry

__all__ = ["HiGlassWidget"]

logger = logging.getLogger("higlass.widget")


class TilesetInfo(pydantic.BaseModel):
    """A tileset_info request payload."""

    type: typing.Literal["tileset_info"]
    tilesetUid: str


class Tiles(pydantic.BaseModel):
    """A tile request payload."""

    type: typing.Literal["tiles"]
    tileIds: list[str]


class Cancel(pydantic.BaseModel):
    """Cancel queued work using the original request ID."""

    type: typing.Literal["cancel"]


class CustomMessage(pydantic.BaseModel):
    """A custom message from the widget front end."""

    id: str
    payload: typing.Union[TilesetInfo, Tiles, Cancel]  # noqa: UP007


class JupyterTilesetClient(ipywidgets.Widget):
    """A singleton client for handling tileset requests in a Jupyter environment.

    Requests are handled asynchronously using a thread pool executor.
    """

    def __init__(self) -> None:
        super().__init__()
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        self._requests = TileRequests(TilesetRegistry, self._send_response)
        self.on_msg(self._handle_custom_message)

    @classmethod
    @functools.lru_cache(maxsize=1)
    def get_instance(cls):
        """Return a singleton client."""
        return cls()

    def _send_response(self, response):
        """Send from the kernel event loop when a worker finishes."""
        def send_if_open():
            """Suppress callbacks already queued when the client closes."""
            if not self._requests.closed:
                self.send(response)

        if self._loop is not None:
            self._loop.call_soon_threadsafe(send_if_open)
        else:
            send_if_open()

    def _handle_custom_message(self, widget, msg, buffers):
        """Validate messages and report errors instead of losing worker futures."""
        try:
            message = CustomMessage(**msg)
        except pydantic.ValidationError as error:
            self._send_response({"id": msg["id"], "error": {
                "type": type(error).__name__, "message": str(error),
            }})
            return
        self._requests.handle(message.model_dump())

    def close(self):
        """Release queued requests before closing the comm."""
        if hasattr(self, "_requests"):
            self._requests.close()
        super().close()


class HiGlassWidget(anywidget.AnyWidget):
    """An interactive anywidget for HiGlass."""

    _esm = pathlib.Path(__file__).parent / "widget.js"

    _viewconf = t.Dict(allow_none=False).tag(sync=True)
    _options = t.Dict().tag(sync=True)
    _plugin_urls = t.List().tag(sync=True)
    _tileset_client = t.Any().tag(sync=True, **ipywidgets.widget_serialization)

    # readonly properties
    location = t.List(t.Union([t.Float(), t.Tuple()]), read_only=True).tag(sync=True)

    def __init__(self, viewconf: dict, plugin_urls: list[str] | None, **viewer_options):
        bundle = pathlib.Path(__file__).parent / "widget.bundle.js"
        if not bundle.exists():
            raise RuntimeError("Build the patched widget first: see TILE_LOADING.md")
        super().__init__(
            _esm=bundle.read_text(),
            _viewconf=viewconf,
            _plugin_urls=plugin_urls,
            _options=viewer_options,
            _tileset_client=JupyterTilesetClient.get_instance(),
        )

    def reload(self, *items):
        msg = json.dumps(["reload", items])
        self.send(msg)

    def zoom_to(
        self,
        view_id: str,
        start1: int,
        end1: int,
        start2: int | None = None,
        end2: int | None = None,
        animate_time: int = 500,
    ):
        msg = json.dumps(["zoomTo", view_id, start1, end1, start2, end2, animate_time])
        self.send(msg)
