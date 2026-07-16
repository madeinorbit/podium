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

## Testing independent instances

When changing instance identity, state, endpoints, CLI routing, agent ownership, or lifecycle
behavior, follow **[docs/multi-instance.md](docs/multi-instance.md)** and run
`bun run test:multi-instance`. The acceptance lane starts fully separate concurrent runtimes;
do not substitute multiple clients routed to one server.

## Issue tracking with Podium

This project uses Podium's issue tracker for work management. If you are running inside a Podium
session, use the `podium issue` CLI (start with `podium issue prime`). Track durable/discovered
work as issues, not markdown TODO lists. Full guide: **[docs/agents/podium-issues.md](docs/agents/podium-issues.md)**.

## Delegating to other agents

`podium agent spawn` puts another agent on an issue. Podium infers nothing about a delegate —
no roles, no write-claim, no auto-isolation [spec:SP-4ef9] — so what you tell it in the spawn
prompt is the only lever: its job, a title to give itself, who else is on the issue, and who
owns which files. Full guide: **[docs/agents/delegating.md](docs/agents/delegating.md)**.

## Running tests

Four lanes [spec:SP-0be7]: `bun run test` is the fast hermetic default (run before every
commit); `bun run test:integration` for process/PTY/abduco/daemon/server-boot work;
`bun run test:e2e` for full-stack flows; `bun run test:smoke:agents` launches real agent
CLIs and bills LLM quota — only on explicit human request. Vitest always runs under Bun
(`bun --bun vitest run ...`). Full doctrine: **[docs/agents/testing.md](docs/agents/testing.md)**.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — the four test lanes and which suite to run when.
