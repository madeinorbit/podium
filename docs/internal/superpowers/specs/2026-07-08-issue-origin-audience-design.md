# Issue provenance & audience: two `human | agent` axes + epic progress rollup

**Issue:** #198
**Date:** 2026-07-08
**Status:** Design approved, pending spec review

## Problem

The tracker has a single `origin: 'human' | 'agent'` field intended to keep an
agent's internal work out of the human's top-level board. It does not work:

- **`origin` is never set to `'agent'`.** It is a defaultable create parameter
  (`issues.ts:1308`, default `'human'`). `podium issue create` — the command
  agents call — never passes it (`packages/issue-client/src/commands.ts:265`).
  The auto-created draft vessel is hard-coded `origin: 'human'`
  (`issues.ts:1046`). The only path that can set `'agent'` is
  `attachSession --newSubissue`. **Result: effectively every issue is
  `origin: 'human'`.**
- The board filter is real but starved: `filterBoardScope` hides
  `origin === 'agent'` from the top level (`apps/web/src/issues-display.ts:80`),
  but there is nothing for it to hide.

Two conflated meanings sit on one field: **who created an issue** (provenance)
and **who the issue is for** (should the human track it at the top level). An
agent creating an issue *because the human asked this session* is human-facing
intent; an agent decomposing its own work is internal scaffolding — same actor,
opposite meaning. One field cannot express both.

## Design

Split into **two independent axes that share the `human | agent` vocabulary.**

### Axis 1 — `origin: 'human' | 'agent'` (provenance, deterministic)

*Who created the issue.* **Derived from the caller, never passed:**

- Create through the constrained agent capability (`issue-authz`) → `'agent'`.
- Create by the operator (web UI / human) → `'human'`.

The `origin` create parameter is **removed** from the input schema
(`commands.ts:159` and the create proc). Origin can no longer be set by hand, so
it cannot lie. It is pure provenance — rendered as a quiet badge ("by agent" /
"by you"), used for audit, never used to hide anything.

### Axis 2 — `audience: 'human' | 'agent'` (who it is for, agent-declared)

*Who the issue is for.* New column, parallel to `origin`:

- **`human`** — a top-level work item the human should track (a deliverable, an
  epic). Always shows on the board.
- **`agent`** — internal working detail (the agent's own decomposition). Hidden
  from the top level; nests under its nearest human-audience ancestor.

Assignment:

- Operator (human) creates → always `audience: 'human'`.
- Agent creates → **`audience: 'agent'` by default**; the agent opts a work item
  up to the human board by passing `--audience human`.

`audience` — not `origin` — is what the board filters on.

### Board behavior

`filterBoardScope` (`apps/web/src/issues-display.ts`) switches its top-level test
from `origin !== 'agent'` to `audience === 'human'`. The existing ancestor-walk
is retargeted: an `audience: 'agent'` issue is kept only when some ancestor chain
reaches an `audience: 'human'` issue, and then renders nested under it. The
`showAgentTasks` display option becomes `showInternal` (same semantics: reveal
`audience: 'agent'` rows at the top level for debugging).

### Epic progress rollup

Every `audience: 'human'` issue with a non-empty internal (`audience: 'agent'`)
subtree gets a computed rollup so the human tracks progress without seeing the
churn:

- `N / M closed` across the internal subtree,
- the current stage (max/most-advanced open child stage),
- a live-agent indicator (is a session actively working any descendant).

Pure, derived from the already-loaded issue set — no new persisted state.

### Orphan-internal warning

When a create resolves to `audience: 'agent'` but the calling agent is **not
attached to any issue** (no working parent for it to nest under), the result
would be invisible: hidden from the top level with no human-audience ancestor,
so `filterBoardScope` drops it entirely. On this condition, emit a **soft
warning** in the CLI / tool response:

> This issue will be invisible: it is internal (`audience: agent`) but has no
> human-facing parent. Pass `--audience human`, or attach to an issue first.

Warn, do not block — the create still succeeds.

### Agent discipline (guidance, not code)

`podium issue prime` and the session hook text instruct agents:

> When you take on a chunk of work the human should be able to track, cut a
> human-audience issue for it (`--audience human`) and keep your own breakdown
> as internal (`audience: agent`) children under it. Be deliberate about where
> the human-facing cut lines fall — the human tracks progress off these.

### Migration

All existing rows are `origin: 'human'` today. Backfill `audience = 'human'` on
every existing row so nothing disappears from the board. Behavior changes only
for **new** creates (deterministic origin + agent-declared audience).

## Components touched

| Area | Change |
|---|---|
| `apps/server/src/store/issues.ts` | Add `audience` column + read/write; migration to add column and backfill `'human'`. |
| `apps/server/src/issues.ts` | `create()`: derive `origin` from caller, set `audience` default by caller kind; drop `origin` from wire-in. |
| `apps/server/src/modules/issues/commands.ts` | Remove `origin` param; add `audience` param; caller-kind derivation; orphan-internal warning. |
| `packages/issue-client/src/commands.ts` | `create`: add `--audience`; surface warning text. |
| `apps/web/src/issues-display.ts` | Filter on `audience === 'human'`; `showAgentTasks` → `showInternal`. |
| `apps/web/src/SidebarUnified.tsx` + board views | Origin badge; epic progress rollup; internal nesting on `audience`. |
| `packages/protocol` | `IssueWire`: add `audience`; keep `origin`. |
| `prime` / hook text | Agent discipline guidance. |

## Non-goals

- No change to the dependency graph, stages, or authz model.
- No per-issue privacy/ACL — `audience` is a board-surface hint, not access
  control.
- No auto-promotion of internal issues; the human or agent promotes explicitly.
