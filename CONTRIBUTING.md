# Contributing to Jarvis

Thank you for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/kindredzhang/jarvis.git
cd jarvis
bun install
make install   # install + make bin executable
```

## How to Contribute

### Report Bugs

Open an [issue](https://github.com/kindredzhang/jarvis/issues) with:
- Clear title and description
- Steps to reproduce
- Expected vs actual behavior
- Environment (OS, Bun version, etc.)

### Suggest Features

Open an [issue](https://github.com/kindredzhang/jarvis/issues) with the `enhancement` label. Describe the problem you're solving and why it fits the project scope.

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes and add tests
4. Ensure tests pass: `bun test`
5. Commit with a clear message
6. Open a PR against `main`

### Code Style

- TypeScript with strict mode
- Run `bun run` (no explicit build/lint scripts yet — contributions that add these are welcome)
- Keep the architecture consistent with `CLAUDE.md`

## Repository Structure

```
src/
  agent/       # ReAct loop, memory, session, tools, subagent
  providers/   # LLM provider adapters
  channels/    # Chat platform adapters (Feishu, Discord, etc.)
  api/         # OpenAI-compatible HTTP API
  cron/        # Scheduled job runner
  command/     # Slash command system
```

## Questions?

Open an issue or reach out via the project discussion board.