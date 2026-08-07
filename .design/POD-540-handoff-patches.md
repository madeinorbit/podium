# POD-540 — handoff patches for files owned by the POD-516 rework

The shared hook landed in `4351f2931`:

```
apps/web/src/lib/use-persisted-ui-state.ts
  usePersistedUiValue(key, parse)            -> T
  usePersistedUiState(key, parse, serialize) -> [T, (next: T) => void]
```

`usePersistedUiState` is shaped like `useState`, so a seeded call site converts by
swapping the hook and deleting the hand-written writer. The setter only writes;
the value comes back through the subscription, which is what stops the rendered
state and the stored row from diverging.

Two call sites are still broken and are in files I was told not to touch. Both
patches below are against the text as of `4351f2931`.

---

## 1. `apps/web/src/app/AppShell.tsx` — `sidebarCollapsed` and `rightPanel`

Both keys are per-user replicated (`sidebar.collapsed`, `rightPanel`). Seeded
with a `useState` initializer, so they read `null` before the replica arrives and
stay on the default: **this is the collapse-does-not-survive-reload bug itself.**

### 1a. Import

```diff
-import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
+import { useEffect, useRef, useState } from 'react'
```

(keep `useSyncExternalStore` if anything else in the file still uses it — after
patch 1d nothing does)

```diff
 import { useFeature } from '@/lib/hooks/use-feature'
+import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
```

(exact neighbouring import line does not matter; biome sorts them)

### 1b. Module-scope writers

Add at module scope, e.g. just above `function AppBody`:

```ts
const writeFlightDeckMode = (collapsed: boolean): string => (collapsed ? 'folded' : 'open')
const writeRightPanel = (panel: RightPanelTab | null): string => panel ?? ''
```

They are module-level so the setters keep a stable identity across renders — an
inline arrow would hand `FlightDeck` / `RightRail` a new callback every render.

### 1c. `sidebarCollapsed` (line 229)

```diff
-  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() =>
-    readBooleanState(uiState.get(SIDEBAR_COLLAPSED_KEY)),
-  )
+  // SUBSCRIBED, not seeded: this key is per-user REPLICATED, and a `useState`
+  // initializer reads it before the replica has the row, then never runs again
+  // (POD-540).
+  const [sidebarCollapsed, setSidebarCollapsed] = usePersistedUiState(
+    SIDEBAR_COLLAPSED_KEY,
+    readBooleanState,
+    String,
+  )
```

and delete the hand-written writer (line 260):

```diff
-  const setSidebarCollapsed = (collapsed: boolean): void => {
-    setSidebarCollapsedState(collapsed)
-    uiState.set(SIDEBAR_COLLAPSED_KEY, String(collapsed))
-  }
```

`readBooleanState(value, fallback = false)` takes the raw string as its first
argument, so it drops straight in as `parse`. `String(true) === 'true'`, which
`readBooleanState` accepts.

### 1d. Flight Deck — fold 689186ccb's hand-rolled version onto the hook (line 239)

```diff
-  const flightDeckCollapsed = readFlightDeckCollapsed(
-    useSyncExternalStore(
-      (onChange) => uiState.subscribe(onChange),
-      () => uiState.get(SUPERAGENT_MODE_KEY),
-    ),
-  )
+  const [flightDeckCollapsed, setFlightDeckCollapsed] = usePersistedUiState(
+    SUPERAGENT_MODE_KEY,
+    readFlightDeckCollapsed,
+    writeFlightDeckMode,
+  )
```

and delete (line 264):

```diff
-  const setFlightDeckCollapsed = (collapsed: boolean): void => {
-    uiState.set(SUPERAGENT_MODE_KEY, collapsed ? 'folded' : 'open')
-  }
```

Behaviour-identical — same key, same idiom, one less copy. **If the Flight Deck
rework has already moved this to `FLIGHT_DECK_MODE_KEY`** (`podium.flightDeck.mode`,
added to `CLIENT_DEVICE_LOCAL_UI_KEYS`), the key is now DEVICE-LOCAL and does not
have the race at all — the hook is still the tidier spelling, but skip this patch
if the code has moved on.

### 1e. `rightPanel` (line 245)

```diff
-  const [rightPanel, setRightPanelState] = useState<RightPanelTab | null>(() =>
-    readRightPanel(uiState.get(RIGHT_PANEL_KEY)),
-  )
+  // Per-user REPLICATED dock layout — subscribed, not seeded (POD-540).
+  const [rightPanel, setRightPanelStored] = usePersistedUiState<RightPanelTab | null>(
+    RIGHT_PANEL_KEY,
+    readRightPanel,
+    writeRightPanel,
+  )
```

then the three write sites collapse (lines 267, 288, 297):

```diff
   const setRightPanel = (panel: RightPanelTab | null): void => {
     if (!panelAllowed(panel)) return
-    setRightPanelState(panel)
-    uiState.set(RIGHT_PANEL_KEY, panel ?? '')
+    setRightPanelStored(panel)
     setSuperOpen(panel === 'superagent')
   }
```

```diff
     if (superOpen) {
-      setRightPanelState('superagent')
-      uiState.set(RIGHT_PANEL_KEY, 'superagent')
+      setRightPanelStored('superagent')
       return
     }
```

```diff
     if (rightPanel !== 'superagent') return
-    setRightPanelState(null)
-    uiState.set(RIGHT_PANEL_KEY, '')
-  }, [superOpen, rightPanel, uiState])
+    setRightPanelStored(null)
+  }, [superOpen, rightPanel, setRightPanelStored])
```

**Leave the mount-only seed effect alone**:

```ts
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only — seed the store from the persisted panel.
  useEffect(() => {
    if (rightPanel === 'superagent') setSuperOpen(true)
  }, [])
```

It now runs while `rightPanel` is still `null`, but the restore is not lost:
`superOpen` is itself a replicated key, and the engine re-applies it from the
replica in `syncReplicatedUi()` (`packages/client-core/src/engine/runtime.ts`),
which drives the mirror effect below it. Making this effect react to `rightPanel`
instead would fight that mirror in the `superOpen → false` direction.

---

## 2. `apps/web/src/features/worklist/sidebar-common.tsx` — `useCollapsed` (line 159)

`fold-keys.ts` documents it explicitly: the `podium:sidebar:` prefix maps to
`sidebar.section.<name>`, which makes every worklist fold per-user REPLICATED. So
the snoozed / proposed / closed group folds all lose their state on reload today.

```diff
 export function useCollapsed(key: string, defaultCollapsed: boolean): [boolean, () => void] {
-  const ui = useStoreSelector((s) => s.uiState)
-  const [collapsed, setCollapsed] = useState<boolean>(() => {
-    const v = ui.get(key)
-    return v === null ? defaultCollapsed : v === 'true'
-  })
-  const toggle = () => {
-    setCollapsed((c) => {
-      const next = !c
-      ui.set(key, next ? 'true' : 'false')
-      return next
-    })
-  }
+  // These keys are per-user REPLICATED (see fold-keys.ts on the `podium:sidebar:`
+  // spelling), so they must be SUBSCRIBED: a `useState` initializer reads them
+  // before the replica has the row and the fold is stuck on its default for the
+  // session (POD-540).
+  const [collapsed, setCollapsed] = usePersistedUiState(
+    key,
+    useCallback(
+      (raw: string | null) => (raw === null ? defaultCollapsed : raw === 'true'),
+      [defaultCollapsed],
+    ),
+    writeCollapsed,
+  )
+  const toggle = useCallback(() => setCollapsed(!collapsed), [setCollapsed, collapsed])
   return [collapsed, toggle]
 }
```

with, at module scope:

```ts
const writeCollapsed = (collapsed: boolean): string => (collapsed ? 'true' : 'false')
```

and the imports:

```diff
-import { useState } from 'react'
+import { useCallback, useState } from 'react'
+import { usePersistedUiState } from '@/lib/use-persisted-ui-state'
```

(`useState` is still used elsewhere in the file — the resizable column's width,
which is device-local and correctly seeded.)

`toggle`'s identity now changes when `collapsed` changes; it did not before. No
caller memoizes on it (`UnifiedIssueRow`, `work-folds`), so this is inert, but it
is the one thing to look at if a row's render count matters.

`DockSection` in `apps/web/src/features/issues/DockSection.tsx` is the same shape
and is already converted in `4351f2931` — copy from there if the diff above has
drifted.

---

## Not patched, filed instead

`apps/web/src/features/terminal/use-panel-surface.ts` materializes a derived
panel mode into the store on mount when a session has no saved one. On a cold
load the replicated `podium.panelMode` map is empty, so every panel writes, and
the engine's flush serializes the WHOLE map — the stored map is replaced by a
one-entry map and lost to last-writer-wins. Both candidate fixes change panel
presentation semantics, so it is **POD-555**, not this patch.
