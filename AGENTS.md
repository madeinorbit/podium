# AGENTS.md

Guidance for AI agents working in this repository.

## Verifying UI / interaction changes

Unit tests + build + review are necessary but **not sufficient** for UI/interaction
features (clickable elements, terminal link clicks, editor open/save). Before calling
such work done, verify it at runtime by driving the real app and observing the
behavior (a real click, a real new tab, the file actually changing on disk).

See **[docs/agents/driving-podium.md](docs/agents/driving-podium.md)** for how to drive
Podium with Playwright — the `?e2e=1` test API, navigating the current DOM, reading
terminal output, clicking terminal cells, and the harness vs. the live instance.

## Reference docs for agents

- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
