# AGENTS.md

Guidance for AI agents working in this repository.

## Verifying UI / interaction changes

Automated tests, build, and review do not replace runtime verification for changed
UI/interaction behavior (clickable elements, terminal link clicks, editor open/save).
Before calling such work done, drive the real app and observe the behavior (a real
click, a real new tab, the file actually changing on disk).

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

## Testing policy

Match testing effort to regression risk. Simple, low-risk changes may skip automated tests when
they do not alter runtime behavior, are fully mechanical, or are already protected by existing
coverage; state the reason in the handoff. Do not test trivial wiring, static types, framework
contracts, or assertions already covered at another layer.

When coverage is warranted, write the smallest focused set that protects the changed behavior.
Prefer extending existing tests or adding table-driven cases over creating parallel suites. Run
`bun run test` before commits containing substantive code changes; docs, copy, formatting, and
other test-independent edits may skip it. Add integration, E2E, multi-instance, or agent-smoke
lanes only when the change matches the decision table in
**[docs/agents/testing.md](docs/agents/testing.md)**. Do not create or run long, complex E2E flows
for small or local changes; reserve them for critical cross-boundary behavior or regressions that
require the real stack. Real-agent smoke tests require an explicit human request. Changed
UI/interaction behavior still requires runtime verification.

## Reference docs for agents

- [docs/multi-instance.md](docs/multi-instance.md) — operate and test fully independent instances on one machine.
- [docs/agents/driving-podium.md](docs/agents/driving-podium.md) — drive the Podium UI with Playwright to verify features at runtime.
- [docs/agents/agent-state-classification.md](docs/agents/agent-state-classification.md) — how agent run-state is classified from transcripts.
- [docs/agents/podium-issues.md](docs/agents/podium-issues.md) — use the `podium issue` CLI to track work from inside a session.
- [docs/agents/delegating.md](docs/agents/delegating.md) — spawn other agents: placement, naming, concurrency, advisory locks.
- [docs/agents/testing.md](docs/agents/testing.md) — the four test lanes and which suite to run when.
