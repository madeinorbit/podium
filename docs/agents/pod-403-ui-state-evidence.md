# POD-403 UI-state cutover evidence

## Ownership and shared authority

`packages/client-core/src/ui-state.ts` is the only client UI-state owner. It creates the URL router, hydrates one workspace snapshot, routes every persisted key, flushes changes, and performs legacy migration. The engine has one reaction into this interface; the deleted `engine/persistence.ts` and `router.ts` no longer provide parallel bookkeeping.

The cross-issue key vocabulary lives in `packages/model/src/user-state/layout-state.ts`. POD-403 consumes that vocabulary through `layoutKeyFromLegacy` and `isLayoutKey`; POD-402's Actions-owned `replicatedLayout` port consumes the same canonical keys and writes through the Outbox. A replicated key cannot acquire a local fallback: `uiStateRoute` throws for anything absent from the shared/client local vocabulary, replicated vocabulary, named theme exception, or the explicitly tracked POD-1380 cursor exception.

## Total routing decisions

| Owned key | Home | Decision |
| --- | --- | --- |
| `podium.view` | device-local | Navigation belongs to this device history and URL. |
| `podium.selectedWorktree` | device-local | Current selection is local and mirrored into the URL. |
| `podium.selectedIssueId` | device-local | Current selection is local and mirrored into the URL. |
| `podium.dockTab` | per-user replicated | Dock selection is personal tab layout and follows the user. |
| `podium.paneA` | device-local | Primary pane selection is current navigation and URL state. |
| `podium.paneB` | device-local | Secondary pane selection is screen geometry. |
| `podium.split` | device-local | Split geometry is a property of this screen. |
| `podium.superOpen.v2` | per-user replicated | Superagent-column openness is personal shell layout. |
| `podium.panelMode` | per-user replicated | Per-session presentation is personal tab layout. |
| `podium.panelModeDefault` | per-user replicated | The default presentation is a personal preference. |
| `podium.dockShells` | device-local | A shell is a live attachment to this device, not portable layout. |
| `podium.recentFiles` | device-local | Paths are device/machine reachability hints. |

Dynamic sidebar, tab, dock-section, and file-presentation families are classified by the same model vocabulary. Client-only transient chrome, focus/capability preferences, and screen sizes are explicitly listed as device-local. The event-stream cursor `podium:superfeed:cursor` is explicitly known-unrouted pending POD-1380; it is not allowed to become replicated or silently default local.

Theme mode and preset are the only raw, unnamespaced exception. `ThemeProvider` needs them before a principal-bound replica exists to prevent first-paint flash; they disclose no tenant data. The audit rejects every other raw `localStorage` access or unnamespaced UI-state write.

## Hydration, writes, and migration

The platform composition root supplies the principal-prefixed replica. Device-local reads and writes use only its `uiState()` collection. Replicated layout reads use the scoped bootstrap/feed snapshot; writes use POD-402's Actions-owned `replicatedLayout` port and exactly one Outbox command. The engine regression drives the real `setDockTab`, `setSuperOpen`, and `setPanelMode` Store setters and asserts one `layoutSet` entry apiece; local route/pane/split setters assert zero Outbox entries.

The replica first consumes known raw legacy keys into the acting principal's versioned local collection and deletes the raw spellings. On the first routed read of a replicated key, the module moves that value once into the optimistic per-user row and removes the local copy. A later principal has neither a raw key nor access to the first principal's namespace, so it cannot re-consume the migration. Theme alone remains mirrored raw.

## Verification

- Final merged boundary lane: 102 tests passed across 8 files covering UI-state, totality/lint audit, Actions, replicated layout, engine, Outbox contracts, socket feed, and sync composition. The Actions/engine pair alone passed 60/60.
- Counterfactual refusal was observed before the green run: a temporary second `layoutSet` from `setDockTab` failed the real-caller assertion with two pending rows, and a temporary `layoutSet` from `setView` failed the device-local assertion with one row instead of zero. Both mutations were reversed byte-for-byte; the production tree was clean before rerunning green.
- Workspace typecheck: 22/22 tasks passed across 25 scoped packages on the cached lane.
- Browser runtime: Chromium drove a real second-panel click, real pointer tab reorder, real split/pane selection, Git dock selection, and page reload. Tab order, both pane identities/geometry, split layout, and Git dock selection survived identically; the migrated raw `podium.panelModeDefault` key was deleted.
- Before the final integration merge, the broader lanes were node 9,404, web 1,460, mobile 34, Bun 14, plus the multi-instance acceptance lane. On integration `dfa58a4f`, the exact rearchitecture audit ran 74 tests (71 passed, 3 deterministic stale POD-1251/change-row assertions failed); that separate integration defect is POD-1416 and was not rebaselined in this issue.

