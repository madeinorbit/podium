# POD-1350 — Replicated layout state family

## What landed

Sidebar/tab layout is no longer a client-local non-member of the per-user family.
It has a server row, command surface, and a closed key vocabulary shared with POD-403.

| Piece | Where |
|---|---|
| Family member (8th) | `packages/model/src/user-state/layout-state.ts`; `family.ts` is 8 members + 1 non-member |
| Closed key routing | `LAYOUT_EXACT_KEYS`, `LAYOUT_KEY_PREFIXES`, `isLayoutKey`, `layoutKeyFromLegacy`, `DEVICE_LOCAL_UI_KEYS` |
| Table | `user_layout(user_id, key, value, updated_at)`, PK `(user_id, key)` |
| Migration | `drizzle/20260802095200_user-layout-store` — empty CREATE (no server backfill; POD-403 migrates client once) |
| Repository | `apps/server/src/store/user-layout.ts` — every method takes a user |
| Commands | `layout.set` · `layout.clear` — per-user-state, offline-eligible, trpc+outbox |
| Bootstrap | `layout.get` → `LayoutSnapshot` for the calling principal |
| Matrix / durable | row `sidebar-tab-layout`; DURABLE_STORES entry for `user_layout` |

## Key split (with POD-403)

**Replicated (this family):** dockTab, superOpen, superagent.mode, rightPanel, panelMode(+Default), sidebarLayout, sidebar.collapsed, sidebarTab, homeMode, issues.display, htmlmode, mdmode, sidebar.section.*, dock.section.*

**Device-local (stay in ui-state):** view, selectedWorktree, selectedIssueId, paneA/B, split, dockShells, recentFiles, sidebar width. Theme remains the pre-auth exception.

## For POD-402 / POD-403

- POD-402: layout writes are commands (`layout.set` / `layout.clear` on outbox).
- POD-403: import `isLayoutKey` / `layoutKeyFromLegacy` / `DEVICE_LOCAL_UI_KEYS` for the total routing table; hydrate from `layout.get`; one-shot forward legacy values then delete.

## Verification

- Targeted vitest (model user-state, layout contracts, store, service, matrix): 79 green
- `audit-durable-classes`: clean (90 stores)
- `packages/model` + `packages/commands` typecheck: clean

## POD-402 review follow-up (tip c0fc8b35)

1. **Authz** — `layoutAuthzFailure` reads contract `roleFloor` live; trpc refuses before store. Test: no write when role is missing.
2. **Feed** — `userLayout` MetadataEntityKind; service `ledger.capture`; visibility `per-user-state` via `keyedUserOf(parseLayoutRowId)`. Alice bootstrap sees rows; Bob empty; changesSince scoped.
3. **Model** — `LayoutKeyField` on `LayoutState.entityId` and `LayoutSnapshot`; device-local keys fail parse.

Client Outbox kinds remain POD-402 (not operational until both halves land).
