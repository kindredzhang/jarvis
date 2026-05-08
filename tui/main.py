#!/usr/bin/env python3
"""jarvis — Personal AI Assistant."""

import asyncio, json, os, subprocess, sys
from pathlib import Path
import typer
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from stream import LOGO

console = Console()
app = typer.Typer(name="jarvis", help="Personal AI Assistant", add_completion=False)

def _jarvis_root() -> Path:
    return Path(__file__).resolve().parent.parent

# ──── agent ────
@app.command()
def agent(
    message: str | None = typer.Option(None, "--message", "-m", help="Message to send"),
    session_id: str = typer.Option("cli:direct", "--session", "-s", help="Session ID"),
    markdown: bool = typer.Option(True, "--markdown/--no-markdown", help="Render output as Markdown"),
):
    """Interact with the agent directly."""
    from agent import run_agent
    asyncio.run(run_agent(message, session_id, markdown))

# ──── serve ────
@app.command()
def serve(
    port: int = typer.Option(8000, "--port", "-p", help="Port"),
):
    """Start the OpenAI-compatible API server (/v1/chat/completions)."""
    root = _jarvis_root()
    console.print(f"[dim]Starting jarvis API server on port {port}...[/dim]")
    proc = subprocess.Popen(["bun", "run", "jarvis", "serve", "-p", str(port)], cwd=str(root))
    try: proc.wait()
    except KeyboardInterrupt: proc.terminate()

# ──── gateway ────
@app.command()
def gateway(
    port: int = typer.Option(18790, "--port", "-p", help="Gateway port"),
):
    """Start the jarvis gateway."""
    root = _jarvis_root()
    console.print(f"[dim]Starting jarvis gateway on port {port}...[/dim]")
    proc = subprocess.Popen(["bun", "run", "jarvis", "gateway", "-p", str(port)], cwd=str(root))
    try: proc.wait()
    except KeyboardInterrupt: proc.terminate()

# ──── onboard ────
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
        cfg = {"apiKey": "", "model": "deepseek-chat", "baseUrl": "https://api.deepseek.com/v1", "workspace": str(jarvis_dir)}
        config_path.write_text(json.dumps(cfg, indent=2), encoding='utf-8')
        console.print(f"[green]✓[/green] Created config at {config_path}")

    jarvis_dir.mkdir(parents=True, exist_ok=True)
    console.print(f"[green]✓[/green] Workspace ready at {jarvis_dir}")

    console.print("\n[dim]Next steps:[/dim]")
    console.print("[dim]  1. Add API key to config or set DEEPSEEK_API_KEY env[/dim]")
    console.print(f"[dim]  2. Chat: jarvis agent[/dim]")
    console.print(f"[dim]  3. Gateway: jarvis gateway[/dim]\n")

# ──── status ────
@app.command()
def status():
    """Show jarvis status."""
    home = Path.home()
    config_path = home / '.jarvis' / 'config.json'

    console.print(f"[bold]{LOGO}[/bold]")
    console.print(f"[bold]jarvis v1.0.0[/bold]\n")

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

# ──── callback ────
@app.callback()
def main(version: bool = typer.Option(False, "--version", "-v", help="Show version")):
    """jarvis - Personal AI Assistant"""
    if version:
        console.print(f"jarvis v1.0.0")
        raise typer.Exit()

if __name__ == "__main__":
    app()
