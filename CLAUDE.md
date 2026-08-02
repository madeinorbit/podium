# Podium — agent notes

## Design Context

Design work on the web UI (and the Tauri desktop wrapper, which ships the same dist) is governed by:

- `apps/web/PRODUCT.md` — strategy: register (product), platform (web), users, positioning, brand personality, anti-references, design principles.
- `apps/web/DESIGN.md` — the visual system: Superade theme (deep navy + Superade Yellow `#f5c518`) is canonical, "The Podium" north star, carved-not-floating elevation, issue-color tint channel, agent-state motion grammar. Machine-readable tokens live in its YAML frontmatter; extensions in `apps/web/.impeccable/design.json`.

Read both before designing or restyling any web UI surface. The `/impeccable` skill (project-scoped at `.claude/skills/impeccable/`) consumes these files; `apps/mobile` (React Native) has its own UX concept and is NOT covered by them.

## Cached checks

Run `bun run typecheck` and trust a cache hit — never force a recompute (110x cost;
forced runs have starved the live host). Installs, linker changes, and base swaps
invalidate the cache automatically. If you have a concrete reason to distrust the
cache, run `bun run typecheck -- --uncached-because="<reason>"`; bare `--force` is
refused. Details: AGENTS.md "Cached checks".

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
