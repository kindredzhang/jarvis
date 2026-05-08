---
name: memory
description: Two-layer memory system with Dream-managed knowledge files.
always: true
---

# Memory

## Structure

- `SOUL.md` — Bot personality and communication style. **Managed by Dream.**
- `USER.md` — User profile and preferences. **Managed by Dream.**
- `memory/MEMORY.md` — Long-term facts (project context, important events). **Managed by Dream.**
- `memory/history.jsonl` — append-only JSONL, not loaded into context. Use `grep` tool to search it.

## Search Past Events

`memory/history.jsonl` is JSONL format — each line is a JSON object with `cursor`, `timestamp`, `content`.

- Use `grep(pattern="keyword", path="memory", glob="*.jsonl", output_mode="content")` for content search
- Use `head_limit` / `offset` to page through long histories
- Use `fixed_strings=true` for literal timestamps or JSON fragments
