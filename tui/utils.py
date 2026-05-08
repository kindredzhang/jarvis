"""rich markdown / styling utilities"""

from rich.console import Console
from rich.markdown import Markdown
from rich.text import Text
from rich.panel import Panel
from rich.live import Live
from rich.spinner import Spinner
import re

console = Console()

LOGO = """
 ██╗ █████╗ ██████╗ ██╗   ██╗██╗███████╗
 ██║██╔══██╗██╔══██╗██║   ██║██║██╔════╝
 ██║███████║██████╔╝██║   ██║██║███████╗
 ██║██╔══██║██╔══██╗╚██╗ ██╔╝██║╚════██║
 ██║██║  ██║██║  ██║ ╚████╔╝ ██║███████║
 ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝  ╚═══╝  ╚═╝╚══════╝

  Personal AI Assistant
"""

def print_logo():
    console.print(LOGO, style="bold")

def print_response(content: str):
    """Print assistant response with markdown rendering."""
    console.print()
    md = Markdown(content)
    console.print(md)
    console.print()

def print_assistant(content: str, metadata: dict | None = None):
    """Render assistant response."""
    if not content or not content.strip():
        return
    print_response(content)

def print_streaming_delta(delta: str):
    """Print a streaming delta — just write to stdout."""
    import sys
    sys.stdout.write(delta)
    sys.stdout.flush()

def print_progress(content: str, tool_hint: bool = False):
    """Print progress / tool hint."""
    style = "dim italic" if not tool_hint else "dim"
    console.print(f"  ↳ {content}", style=style)

def print_error(msg: str):
    console.print(f"\n✗ {msg}", style="bold red")

def create_spinner(text: str = "thinking..."):
    return console.status(text, spinner="dots")
