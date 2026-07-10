# apps/web feature folders

Each folder under `features/` is one user-facing feature; a module's tests live
next to it. The import rule (enforced by `test/features.structure.test.ts`):

- features MAY import: `@/lib` (cross-feature modules + hooks/icons),
  `@/components/ui` (shadcn primitives), `@/app` (store/trpc/theme/router
  shims and shell error pages), and workspace packages (`@podium/client-core`,
  `@podium/protocol`, ...).
- features may NOT import each other. Features compose only via `app/`
  (AppShell, MobileApp, Workspace, RightDock, routes) — never sideways.
- `lib/` and `components/ui/` may NOT import from `features/`.

A module used by 2+ features belongs in `lib/` (that is why e.g. `derive`,
`markdown`, `voice`, `home`, `SessionContextMenu`, `WorkerLabel` and the
agent-model picker cluster live there); a module used by exactly one feature
belongs in that feature.

Grandfathered exceptions (see EXCEPTIONS in the structure test — shrink, don't
grow): the sidebar work list composes issue/machine/setup surfaces inline
(worklist → issues/machines/setup), the agent pane and the superagent thread
embed the chat surface (terminal/superagent → chat), and settings reuses the
setup form (settings → setup).
