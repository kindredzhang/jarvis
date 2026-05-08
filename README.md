# jarvis

Personal AI assistant — a ReAct-loop agent with tool use, multi-provider LLM support, session persistence, memory consolidation, and chat channel integrations.

## Install

```bash
# via npm
npm install -g @kindred/jarvis

# via bun
bun install -g @kindred/jarvis
```

Requires [Bun](https://bun.sh) >= 1.0.

## Quick Start

```bash
# Interactive mode
jarvis agent

# Single message
jarvis agent -m "hello"

# Start API server (OpenAI-compatible /v1/chat/completions)
jarvis serve -p 8000

# Start gateway (with cron + heartbeat)
jarvis gateway -p 18790

# Initialize config
jarvis onboard
```

## Configuration

Config file at `~/.jarvis/config.json`:

```json
{
  "agents": {
    "defaults": {
      "model": "deepseek-chat"
    }
  },
  "providers": {
    "deepseek": {
      "apiKey": "sk-...",
      "apiBase": "https://api.deepseek.com/v1"
    }
  }
}
```

Or with environment variables: `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

## Slash Commands

In interactive mode, type `/` + Tab for autocomplete:

- `/help` — Show help
- `/new` — New conversation
- `/stop` — Stop tasks
- `/status` — Session stats
- `/skills` — List skills
- `/dream` — Memory consolidation
- `/dream-log` — Dream history
- `/dream-restore <sha>` — Revert memory
- `/restart` — Restart process

## Features

- Multi-provider LLM (DeepSeek, OpenAI, Anthropic, Azure, Ollama, OpenRouter, 20+ more)
- ReAct tool-use loop (files, web search, code execution, MCP servers)
- Session persistence with JSONL storage
- Auto memory consolidation (Dream)
- Subagent spawning for parallel tasks
- Slash command routing
- OpenAI-compatible API server
- Chat channel adapters (Telegram, Discord, Feishu, Slack, Email, more)
- Cron service for scheduled tasks
