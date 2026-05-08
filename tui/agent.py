"""Interactive agent mode — 1:1 nanobot replica."""

import os, json, asyncio, signal, sys
from pathlib import Path
from prompt_toolkit import PromptSession
from prompt_toolkit.history import FileHistory
from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
from prompt_toolkit.completion import WordCompleter
from prompt_toolkit.styles import Style
from prompt_toolkit.key_binding import KeyBindings
import httpx
from stream import StreamRenderer, ThinkingSpinner, make_console, LOGO

console = make_console()

SLASH_COMMANDS = ['/help', '/new', '/stop', '/status', '/dream', '/dream-log', '/dream-restore', '/restart']
EXIT_COMMANDS = {'exit', 'quit', '/exit', '/quit', ':q'}
HISTORY_FILE = Path.home() / '.jarvis' / 'tui_history.txt'
HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)

PROMPT_STYLE = Style.from_dict({'prompt': 'cyan bold'})

def get_api_base() -> str:
    return os.environ.get('JARVIS_API_URL', 'http://localhost:8000')

def print_agent_response(content: str, render_markdown: bool = True):
    """Print assistant response — nanobot _print_agent_response pattern."""
    console.print()
    if render_markdown:
        from rich.markdown import Markdown
        console.print(Markdown(content))
    else:
        console.print(content)
    console.print()

async def run_once(message: str, base_url: str, session_id: str, markdown: bool):
    """Single message mode — nanobot run_once pattern."""
    renderer = StreamRenderer(render_markdown=markdown)

    # Build request
    payload = {"messages": [{"role": "user", "content": message}], "session_id": session_id, "stream": True}

    async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
        try:
            async with client.stream("POST", f"{base_url}/v1/chat/completions", json=payload) as resp:
                if resp.status_code != 200:
                    text = await resp.atext()
                    console.print(f"[red]Error: HTTP {resp.status_code}: {text[:200]}[/red]")
                    return
                async for line in resp.aiter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            chunk = json.loads(line[6:])
                            choices = chunk.get("choices", [])
                            if not choices:
                                continue
                            delta = choices[0].get("delta", {})
                            content = delta.get("content", "")
                            finish = choices[0].get("finish_reason")
                            if content:
                                await renderer.on_delta(content)
                            if finish and finish != "tool_calls":
                                await renderer.on_end(resuming=False)
                        except (json.JSONDecodeError, KeyError, IndexError):
                            pass
        except Exception as e:
            if not renderer.streamed:
                console.print(f"[red]Error: {e}[/red]")
            await renderer.close()

async def run_interactive(base_url: str, session_id: str, markdown: bool):
    """Interactive REPL — nanobot run_interactive pattern."""
    session = PromptSession(
        history=FileHistory(str(HISTORY_FILE)),
        auto_suggest=AutoSuggestFromHistory(),
        completer=WordCompleter(SLASH_COMMANDS, ignore_case=True),
        style=PROMPT_STYLE,
    )

    # Handle signals
    def handle_signal(sig, frame):
        console.print(f"\nReceived {signal.Signals(sig).name}, goodbye!")
        sys.exit(0)
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)
    if hasattr(signal, 'SIGPIPE'):
        signal.signal(signal.SIGPIPE, signal.SIG_IGN)

    console.print(f"{LOGO} Interactive mode [bold blue]({os.environ.get('JARVIS_MODEL', 'deepseek-chat')})[/bold blue] — type [bold]exit[/bold] or [bold]Ctrl+C[/bold] to quit\n")

    thinking = None

    while True:
        try:
            user_input = (await session.prompt_async(
                [('class:prompt', '▶ '), ('', '')],
            )).strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\nGoodbye!", style="dim")
            break

        if not user_input:
            continue
        if user_input.lower() in EXIT_COMMANDS:
            console.print("Goodbye!", style="dim")
            break

        # Streaming logic: spinner -> first delta -> Live rendering -> on_end
        renderer = StreamRenderer(render_markdown=markdown)

        payload = {"messages": [{"role": "user", "content": user_input}], "session_id": session_id, "stream": True}

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0)) as client:
                async with client.stream("POST", f"{base_url}/v1/chat/completions", json=payload) as resp:
                    if resp.status_code != 200:
                        text = await resp.atext()
                        console.print(f"[red]Error: HTTP {resp.status_code}[/red]")
                        continue
                    async for line in resp.aiter_lines():
                        if line.startswith("data: ") and line != "data: [DONE]":
                            try:
                                chunk = json.loads(line[6:])
                                choices = chunk.get("choices", [])
                                if not choices: continue
                                delta = choices[0].get("delta", {})
                                content = delta.get("content", "")
                                finish = choices[0].get("finish_reason")
                                if content:
                                    await renderer.on_delta(content)
                                if finish and finish != "tool_calls":
                                    await renderer.on_end(resuming=False)
                            except (json.JSONDecodeError, KeyError, IndexError):
                                pass
        except Exception as e:
            if not renderer.streamed:
                console.print(f"[red]Error: {e}[/red]")
            await renderer.close()

async def run_agent(message: str | None = None, session_id: str = "cli:direct", markdown: bool = True):
    base_url = get_api_base()

    if message:
        await run_once(message, base_url, session_id, markdown)
    else:
        await run_interactive(base_url, session_id, markdown)
