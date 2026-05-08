# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal AI assistant (TypeScript port of the Python "nanobot" agent). A ReAct-loop agent with tool use, multi-provider LLM support, session persistence, memory consolidation, and chat channel integrations.

## Commands

```bash
# Install dependencies
bun install

# Run tests
bun test
# Single test file
bun test src/agent/runner.test.ts
# Single test pattern
bun test --test-name-pattern "dropOrphan"

# Run the agent (requires DEEPSEEK_API_KEY env var)
bun run src/cli.ts agent
bun run src/cli.ts agent -m "Hello"

# Start API server (OpenAI-compatible /v1/chat/completions)
bun run src/cli.ts serve -p 8000

# Start gateway (with cron + heartbeat)
bun run src/cli.ts gateway -p 18790

# Initialize config
bun run src/cli.ts onboard

# Makefile shortcuts
make install    # bun install + chmod bin/jarvis
make agent      # install + run agent
make serve      # install + run serve
make gateway    # install + run gateway
make test
```

## Architecture

```
src/cli.ts                  # Commander.js entry point (agent/serve/gateway/onboard)
├── src/agent/loop.ts       # AgentLoop — top-level orchestrator
│   ├── src/agent/context.ts    # ContextBuilder — system prompt + runtime context
│   ├── src/agent/runner.ts     # AgentRunner — ReAct loop (LLM ↔ tools)
│   ├── src/agent/session.ts    # SessionStore — JSONL-based conversation persistence
│   ├── src/agent/memory.ts     # MemoryStore — MEMORY.md + history.jsonl + git
│   ├── src/agent/consolidator.ts # Consolidator (context compaction) + Dream (memory update)
│   ├── src/agent/subagent.ts   # SubagentManager — spawn sub-agent tasks
│   └── src/agent/skills.ts     # SkillsLoader — skill discovery from workspace & builtin dirs
├── src/providers/          # LLM providers
│   ├── base.ts             #   LLMProvider abstract class
│   ├── openai-compat.ts    #   OpenAICompatProvider (OpenAI/DeepSeek/Ollama/OpenRouter)
│   ├── deepseek.ts         #   DeepSeekProvider (default)
│   └── anthropic.ts        #   AnthropicProvider (Claude)
├── src/agent/tools/        # Tool system
│   ├── base.ts             #   Tool abstract class + ToolDefinition
│   ├── registry.ts         #   ToolRegistry (register, cached defs, prepareCall)
│   ├── fs.ts               #   ReadFile, WriteFile, EditFile, ListDir
│   ├── search.ts           #   Glob, Grep
│   ├── shell.ts            #   Exec
│   ├── spawn.ts            #   Spawn (subagent)
│   ├── web.ts              #   WebSearch, WebFetch
│   ├── message.ts          #   Message (send messages to user)
│   └── mcp.ts              #   MCP server client
├── src/command/            # Slash command system (/help, /stop, /dream, etc.)
├── src/bus/                # MessageBus — async queue for channel ↔ agent decoupling
├── src/api/server.ts       # OpenAI-compatible HTTP API (Bun.serve)
├── src/channels/           # Chat channel adapters (Feishu, Discord, Telegram, WhatsApp)
├── src/cron/service.ts     # CronService — scheduled job runner
├── src/heartbeat/service.ts # HeartbeatService — periodic HEARTBEAT.md check
└── src/utils/              # JSONL, GitStore, TemplateEngine, helpers
```

**Data flow**: InboundMessage → AgentLoop.processMessage → ContextBuilder (system prompt + history) → AgentRunner.run (ReAct loop: LLM call → tool execution → result → repeat) → SessionStore.save → OutboundMessage

**Request path**: CLI, API server, or MessageBus channels feed InboundMessage to AgentLoop. Slash commands are intercepted before the ReAct loop and dispatched by CommandRouter.

## Key conventions

Default to using Bun APIs (not Node.js):
- `Bun.serve()` for HTTP (not Express)
- `Bun.file` for file I/O (not `node:fs` readFile/writeFile)
- `bun test` for testing (not Jest/Vitest)
- `bun:sqlite` for SQLite (not better-sqlite3)
- `Bun.sql` for Postgres (not pg/postgres.js)
- Bun auto-loads `.env` — never use dotenv

## Provider system

All providers extend `LLMProvider` (`src/providers/base.ts`) with `generate()` and `generateStream()`. The default is `DeepSeekProvider` — set `DEEPSEEK_API_KEY` env var or `apiKey` in `~/.jarvis/config.json`.

Env vars: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `JARVIS_API_KEY`, `JARVIS_BASE_URL`, `JARVIS_MODEL`, `JARVIS_WORKSPACE`, `JARVIS_TIMEZONE`.

## Workspace

Default workspace is `~/.jarvis/`. Contains:
- `sessions/` — conversation JSONL files
- `memory/MEMORY.md` — long-term memory (git-tracked)
- `memory/history.jsonl` — append-only conversation log
- `skills/` — workspace-level skills (overrides builtin `skills/`)
- `SOUL.md`, `USER.md` — persona and user profile
- `AGENTS.md`, `TOOLS.md` — bootstrap files injected into system prompt
- `cron/jobs.json` — cron job definitions

## Tools

Tools extend the `Tool` abstract class. Key properties: `name`, `description`, `parameters` (JSON Schema). Methods: `execute(args)`, `castParams()`, `validateParams()`. Built-in tools: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `exec`, `spawn`, `web_search`, `web_fetch`, `message`.

MCP servers can be connected via `connectMCPServer()` in `src/agent/tools/mcp.ts` — they register as `mcp_<server>__<tool>` tools.

## Slash commands

`/help`, `/new` (clear session), `/stop` (cancel subagents), `/status`, `/dream` (trigger memory consolidation), `/dream-log [sha]`, `/dream-restore <sha>`, `/restart`.

Priority commands (`/stop`, `/restart`, `/status`) bypass the dispatch lock.

## Testing

Tests use `bun test`. Test files are co-located with source (e.g., `src/agent/runner.test.ts`). Tests use `describe`/`test`/`expect` from `bun:test`. No mocking framework — prefer real or in-memory implementations where possible.
