"""nanobot-style streaming renderer + Rich utilities."""

import sys
import time
from rich.console import Console
from rich.live import Live
from rich.markdown import Markdown
from rich.text import Text

def make_console() -> Console:
    return Console(file=sys.stdout, force_terminal=sys.stdout.isatty())


class ThinkingSpinner:
    """Spinner that shows 'nanobot is thinking...' with pause support."""

    def __init__(self, console: Console | None = None):
        c = console or make_console()
        self._spinner = c.status("[dim]nanobot is thinking...[/dim]", spinner="dots")
        self._active = False

    def __enter__(self):
        self._spinner.start()
        self._active = True
        return self

    def __exit__(self, *exc):
        self._active = False
        self._spinner.stop()
        return False

    def pause(self):
        from contextlib import contextmanager
        @contextmanager
        def _ctx():
            if self._spinner and self._active:
                self._spinner.stop()
            try:
                yield
            finally:
                if self._spinner and self._active:
                    self._spinner.start()
        return _ctx()


LOGO = "\n".join([
    " ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗",
    " ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝",
    " ██║███████║██████╔╝██║   ██║██║███████╗",
    " ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║",
    " ██║██║  ██║██║  ██║ ╚████╔╝ ██║███████║",
    " ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝",
])


class StreamRenderer:
    """Rich Live streaming with markdown. Exact nanobot replica.

    Flow: spinner -> first delta -> header+Live -> on_end -> stop
    """

    def __init__(self, render_markdown: bool = True):
        self._md = render_markdown
        self._buf = ""
        self._live: Live | None = None
        self._t = 0.0
        self.streamed = False
        self._spinner: ThinkingSpinner | None = None
        self._start_spinner()

    def _render(self):
        return Markdown(self._buf) if self._md and self._buf else Text(self._buf or "")

    def _start_spinner(self) -> None:
        self._spinner = ThinkingSpinner()
        self._spinner.__enter__()

    def _stop_spinner(self) -> None:
        if self._spinner:
            self._spinner.__exit__(None, None, None)
            self._spinner = None

    async def on_delta(self, delta: str) -> None:
        self.streamed = True
        self._buf += delta
        if self._live is None:
            if not self._buf.strip():
                return
            self._stop_spinner()
            c = make_console()
            c.print()
            c.print(f"[cyan]{LOGO} jarvis[/cyan]")
            self._live = Live(self._render(), console=c, auto_refresh=False)
            self._live.start()
        now = time.monotonic()
        if (now - self._t) > 0.15:
            self._live.update(self._render())
            self._live.refresh()
            self._t = now

    async def on_end(self, *, resuming: bool = False) -> None:
        if self._live:
            self._live.update(self._render())
            self._live.refresh()
            self._live.stop()
            self._live = None
        self._stop_spinner()
        if resuming:
            self._buf = ""
            self._start_spinner()
        else:
            make_console().print()

    def stop_for_input(self) -> None:
        self._stop_spinner()

    async def close(self) -> None:
        if self._live:
            self._live.stop()
            self._live = None
        self._stop_spinner()
