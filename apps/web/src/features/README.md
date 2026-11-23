# apps/web feature folders

Each folder under `features/` is one user-facing feature; a module's tests live
next to it. The import rule (enforced by `test/features.structure.test.ts`):

- features MAY import: `@/lib` (cross-feature modules + hooks/icons),
  `@/components/ui` (shadcn primitives), `@/app` (store/trpc/theme/router
  shims and shell error pages), workspace packages (`@podium/client-core`,
  `@podium/protocol`, ...), and other features when a screen composes another
  feature's surface (the sidebar work list mounting issue and machine surfaces,
  the agent pane embedding chat, settings reusing the setup form).
- `lib/` and `components/ui/` may NOT import from `features/`. They are the
  shared layers under every feature; colocated tests may use a feature's pure
  helpers as fixtures.

A module used by 2+ features belongs in `lib/` (that is why e.g. `derive`,
`markdown`, `voice`, `home`, `SessionContextMenu`, `WorkerLabel` and the
agent-model picker cluster live there); a module used by exactly one feature
belongs in that feature. Composing another feature's screen is fine; reaching
into its internals to reuse a helper is the sign that helper belongs in `lib/`.
