# Podium — agent notes

## Design Context

Design work on the web UI (and the Tauri desktop wrapper, which ships the same dist) is governed by:

- `apps/web/PRODUCT.md` — strategy: register (product), platform (web), users, positioning, brand personality, anti-references, design principles.
- `apps/web/DESIGN.md` — the visual system: Superade theme (deep navy + Superade Yellow `#f5c518`) is canonical, "The Podium" north star, carved-not-floating elevation, issue-color tint channel, agent-state motion grammar. Machine-readable tokens live in its YAML frontmatter; extensions in `apps/web/.impeccable/design.json`.

Read both before designing or restyling any web UI surface. The `/impeccable` skill (project-scoped at `.claude/skills/impeccable/`) consumes these files; `apps/mobile` (React Native) has its own UX concept and is NOT covered by them.
