#!/usr/bin/env python3
"""jarvis — Personal AI Assistant.

1:1 nanobot CLI replica. Bun handles all agent logic as an API server;
Python (rich + prompt_toolkit) provides the terminal UX.
"""

import asyncio, json, os, subprocess, sys
from pathlib import Path
from contextlib import nullcontext

import typer
from rich.console import Console
from rich.table import Table

from stream import LOGO

console = Console()
app = typer.Typer(name="jarvis", help="Personal AI Assistant", add_completion=False)

__version__ = "1.0.0"


def _jarvis_root() -> Path:
    return Path(__file__).resolve().parent.parent


# ---------------------------------------------------------------------------
# Version callback
# ---------------------------------------------------------------------------

def version_callback(value: bool):
    if value:
        console.print(f"{LOGO} jarvis v{__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(False, "--version", "-v", help="Show version", callback=version_callback),
):
    """jarvis — Personal AI Assistant."""
    pass


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

@app.command()
def agent(
    message: str | None = typer.Option(None, "--message", "-m", help="Message to send to the agent"),
    session_id: str = typer.Option("cli:direct", "--session", "-s", help="Session ID"),
    markdown: bool = typer.Option(True, "--markdown/--no-markdown", help="Render assistant output as Markdown"),
):
    """Interact with the agent directly."""
    from agent import run_agent
    asyncio.run(run_agent(message, session_id, markdown))


# ---------------------------------------------------------------------------
# OpenAI-compatible API server
# ---------------------------------------------------------------------------

@app.command()
def serve(
    port: int = typer.Option(8000, "--port", "-p", help="Port"),
):
    """Start the OpenAI-compatible API server (/v1/chat/completions)."""
    root = _jarvis_root()
    console.print(f"[dim]Starting jarvis API server on port {port}...[/dim]")
    proc = subprocess.Popen(["bun", "run", "src/cli.ts", "serve", "-p", str(port)], cwd=str(root))
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


# ---------------------------------------------------------------------------
# Gateway
# ---------------------------------------------------------------------------

@app.command()
def gateway(
    port: int = typer.Option(18790, "--port", "-p", help="Gateway port"),
):
    """Start the jarvis gateway."""
    root = _jarvis_root()
    console.print(f"[dim]Starting jarvis gateway on port {port}...[/dim]")
    proc = subprocess.Popen(["bun", "run", "src/cli.ts", "gateway", "-p", str(port)], cwd=str(root))
    try:
        proc.wait()
    except KeyboardInterrupt:
        proc.terminate()


# ---------------------------------------------------------------------------
# Onboard
# ---------------------------------------------------------------------------

@app.command()
def onboard(
    workspace: str | None = typer.Option(None, "--workspace", "-w", help="Workspace directory"),
):
    """Initialize jarvis configuration and workspace."""
    home = Path.home()
    jarvis_dir = Path(workspace) if workspace else home / '.jarvis'
    jarvis_dir.mkdir(parents=True, exist_ok=True)

    config_path = home / '.jarvis' / 'config.json'
    if config_path.exists():
        console.print(f"[yellow]Config already exists at {config_path}[/yellow]")
    else:
        (home / '.jarvis').mkdir(parents=True, exist_ok=True)
        cfg = {
            "apiKey": "",
            "model": "deepseek-chat",
            "baseUrl": "https://api.deepseek.com/v1",
            "workspace": str(jarvis_dir),
        }
        config_path.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
        console.print(f"[green]✓[/green] Created config at {config_path}")

    jarvis_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[green]✓[/green] Workspace ready at {jarvis_dir}")

    console.print("\n[dim]Next steps:[/dim]")
    console.print("[dim]  1. Add API key: set DEEPSEEK_API_KEY env var or edit ~/.jarvis/config.json[/dim]")
    console.print(f"[dim]  2. Chat: jarvis agent[/dim]")
    console.print(f"[dim]  3. Gateway: jarvis gateway[/dim]\n")


# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

@app.command()
def status():
    """Show jarvis status."""
    home = Path.home()
    config_path = home / '.jarvis' / 'config.json'

    console.print(f"[bold]{LOGO} jarvis v{__version__}[/bold]\n")

    table = Table(show_header=False, box=None)
    table.add_column(style="dim", width=12)
    table.add_column()

    try:
        cfg = json.loads(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
        table.add_row("Model", cfg.get("model", "deepseek-chat"))
        table.add_row("URL", cfg.get("baseUrl", "https://api.deepseek.com/v1"))
        table.add_row("Workspace", cfg.get("workspace", str(home / '.jarvis')))
        has_key = bool(os.environ.get('DEEPSEEK_API_KEY') or cfg.get('apiKey'))
        table.add_row("API Key", "[green]✓ configured[/green]" if has_key else "[red]✗ missing[/red]")
    except Exception:
        table.add_row("Error", "Failed to read config")

    console.print(table)
    console.print()


if __name__ == "__main__":
    app()
