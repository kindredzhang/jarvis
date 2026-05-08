.PHONY: install run agent serve gateway test clean

# ──── Development ────

install:
	@echo "🔧 Installing jarvis..."
	@cd tui && uv sync --quiet
	@bun install --silent
	@chmod +x bin/jarvis
	@echo "✓ jarvis installed. Run: ./bin/jarvis agent"

test:
	@bun test

clean:
	@rm -rf tui/__pycache__ .jarvis-server.pid
	@echo "Cleaned"

# ──── Quick Start ────

agent: install
	@./bin/jarvis agent

serve: install
	@./bin/jarvis serve

gateway: install
	@./bin/jarvis gateway

run: agent
