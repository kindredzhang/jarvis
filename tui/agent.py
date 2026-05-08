"""Interactive agent mode — 1:1 nanobot CLI replica.

Architecture: Python TUI talks to Bun API server via HTTP/SSE.
Bun handles all agent logic; Python provides the terminal UX.
"""

import os, json, asyncio, signal, sys
from pathlib import Path
from contextlib import nullcontext

from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.styles import Style
from prompt_toolkit.formatted_text import HTML
from prompt_toolkit.patch_stdout import patch_stdout
import httpx

from stream import StreamRenderer, ThinkingSpinner, make_console, LOGO

console = make_console()

SLASH_COMMANDS = ['/help', '/new', '/stop', '/status', '/dream', '/dream-log', '/dream-restore', '/restart']
EXIT_COMMANDS = {'exit', 'quit', '/exit', '/quit', ':q'}

HISTORY_FILE = Path.home() / '.jarvis' / 'tui_history.txt'
HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)

PROMPT_STYLE = Style.from_dict({'prompt': 'bold ansiblue'})

# ---------------------------------------------------------------------------
# Shared state so signal handlers can restore terminal, etc.
# ---------------------------------------------------------------------------
_PROMPT_SESSION: PromptSession | None = None
_SAVED_TERM_ATTRS = None


class SafeFileHistory(FileHistory):
    """FileHistory subclass that sanitizes surrogate characters on write."""

    def store_string(self, string: str) -> None:
        safe = string.encode("utf-8", errors="surrogateescape").decode("utf-8", errors="replace")
        super().store_string(safe)


def _restore_terminal() -> None:
    """Restore terminal to its original state (echo, line buffering, etc.)."""
    try:
        import termios
        if _SAVED_TERM_ATTRS is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, _SAVED_TERM_ATTRS)
    except Exception:
        pass


def _init_prompt_session() -> None:
    """Create the prompt_toolkit session with persistent file history."""
    global _PROMPT_SESSION, _SAVED_TERM_ATTRS
    try:
        import termios
        _SAVED_TERM_ATTRS = termios.tcgetattr(sys.stdin.fileno())
    except Exception:
        pass

    _PROMPT_SESSION = PromptSession(
        history=SafeFileHistory(str(HISTORY_FILE)),
        enable_open_in_editor=False,
        multiline=False,  # Enter submits (single line mode)
        completer=WordCompleter(SLASH_COMMANDS, ignore_case=True, sentence=True),
    )


async def _read_interactive_input_async() -> str:
    """Read user input using prompt_toolkit (handles paste, history, display)."""
    if _PROMPT_SESSION is None:
        raise RuntimeError("Call _init_prompt_session() first")
    try:
        with patch_stdout():
            return await _PROMPT_SESSION.prompt_async(
                HTML("<b fg='ansiblue'>You:</b> "),
            )
    except EOFError as exc:
        raise KeyboardInterrupt from exc


def _is_exit_command(command: str) -> bool:
    return command.lower() in EXIT_COMMANDS


# ---------------------------------------------------------------------------
# Response rendering — nanobot style
# ---------------------------------------------------------------------------

def _print_agent_response(content: str, render_markdown: bool = True, metadata: dict | None = None):
    """Render assistant response with consistent terminal styling — nanobot _print_agent_response."""
    console.print()
    if render_markdown:
        from rich.markdown import Markdown
        console.print(Markdown(content))
    else:
        console.print(content)
    console.print()


def _print_progress_line(text: str, thinking: ThinkingSpinner | None) -> None:
    """Print a progress line, pausing the spinner if needed."""
    with thinking.pause() if thinking else nullcontext():
        console.print(f"  [dim]↳ {text}[/dim]")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _api_base() -> str:
    return os.environ.get('JARVIS_API_URL', 'http://localhost:8000')


async def _send_message(base_url: str, message: str, session_id: str,
                        markdown: bool, thinking: ThinkingSpinner | None = None):
    """Send a message to the Bun API server, streaming response via SSE.

    The API server sends streaming deltas for LLM responses, or a single
    content event for slash-command results — both handled transparently.
    """
    renderer = StreamRenderer(render_markdown=markdown, show_spinner=False)
    payload = {
        "messages": [{"role": "user", "content": message}],
        "session_id": session_id,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        try:
            async with client.stream("POST", f"{base_url}/v1/chat/completions", json=payload) as resp:
                if resp.status_code != 200:
                    text = await resp.atext()
                    console.print(f"\n[red]Error: HTTP {resp.status_code}: {text[:300]}[/red]")
                    await renderer.close()
                    return

                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    if line == "data: [DONE]":
                        await renderer.on_end(resuming=False)
                        continue
                    try:
                        chunk = json.loads(line[6:])
                        choices = chunk.get("choices", [])
                        if not choices:
                            continue
                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            await renderer.on_delta(content)
                    except (json.JSONDecodeError, KeyError, IndexError):
                        pass

                if not renderer.streamed:
                    await renderer.close()
        except Exception as e:
            if not renderer.streamed:
                console.print(f"\n[red]Error: {e}[/red]")
            await renderer.close()


# ---------------------------------------------------------------------------
# Single message mode — nanobot run_once pattern
# ---------------------------------------------------------------------------

async def run_once(message: str, base_url: str, session_id: str, markdown: bool):
    await _send_message(base_url, message, session_id, markdown)


# ---------------------------------------------------------------------------
# Interactive REPL — nanobot run_interactive pattern
# ---------------------------------------------------------------------------

async def run_interactive(base_url: str, session_id: str, markdown: bool):
    _init_prompt_session()

    model = os.environ.get('JARVIS_MODEL', 'deepseek-chat')
    console.print(f"{LOGO}  Interactive mode [bold blue]({model})[/bold blue] — type [bold]exit[/bold] or [bold]Ctrl+C[/bold] to quit\n")

    # Set up signal handlers
    def _handle_signal(signum, frame):
        _restore_terminal()
        sig_name = signal.Signals(signum).name
        console.print(f"\nReceived {sig_name}, goodbye!")
        sys.exit(0)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    if hasattr(signal, 'SIGHUP'):
        signal.signal(signal.SIGHUP, _handle_signal)
    if hasattr(signal, 'SIGPIPE'):
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    thinking: ThinkingSpinner | None = None

    while True:
        try:
            user_input = await _read_interactive_input_async()
        except (KeyboardInterrupt, EOFError):
            _restore_terminal()
            console.print("\nGoodbye!")
            break

        command = user_input.strip()
        if not command:
            continue

        if _is_exit_command(command):
            _restore_terminal()
            console.print("\nGoodbye!")
            break

        # Start thinking spinner
        thinking = ThinkingSpinner()
        thinking.__enter__()

        try:
            await _send_message(base_url, command, session_id, markdown, thinking)
        finally:
            if thinking:
                thinking.__exit__(None, None, None)
                thinking = None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def run_agent(message: str | None = None, session_id: str = "cli:direct", markdown: bool = True):
    base_url = _api_base()

    if message:
        await run_once(message, base_url, session_id, markdown)
    else:
        await run_interactive(base_url, session_id, markdown)
