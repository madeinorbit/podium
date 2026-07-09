# Warm Session Cache (Component 4) Implementation Plan

> Executed via subagent-driven-development. Steps use `- [ ]`.

**Goal:** Bound the number of mounted session panels to an LRU warm set of N, evicting (unmounting → disposing) the least-recently-viewed beyond N, so memory/contexts stay capped while recent sessions switch instantly.

**Architecture:** Today `Workspace.tsx` mounts an `AgentPanel` for EVERY open session tab (inactive ones `display:none`) — an unbounded warm set. This adds an LRU: keep only the N most-recently-active session tabs mounted (always including the visible pane(s)); render nothing for evicted session tabs (clicking one re-mounts it cold). File tabs (MarkdownFilePanel, cheap) are unaffected — always mounted.

**Tech Stack:** React, TypeScript, vitest (+ happy-dom + createRoot/act for web).

## Global Constraints
- Measured params (from `experiment/webgl-warmset` bench): **N = 8 desktop / 3 mobile**; keep WebGL within the set; **dispose the whole terminal on eviction** (no drop-WebGL-on-hide — measured marginal). Count-based LRU only; memory-pressure eviction is NOT in scope (the data shows count is the lever).
- Device tier: `isMobile = window.matchMedia('(max-width: 768px)').matches` (same check as `AgentPanel.tsx:160`). Desktop N=8, mobile N=3.
- The currently-visible pane(s) (`paneA`, and `paneB` when `split`) MUST always be mounted regardless of N.
- LRU applies to SESSION tabs only. File tabs always render.
- **Commits must NOT include any Co-Authored-By or Claude-Session/sessionUrl trailers** — the repo disabled Claude attribution (`.claude/settings.json`, commit de17cb6). Plain conventional-commit messages only.
- TDD for the pure logic; typecheck + apps/web suite (run FROM `apps/web` with `--config vitest.config.ts`; ~4 pre-existing `shell.structure.test.ts` failures are unrelated — don't add new ones).

---

### Task 1: Pure LRU core (`warm-set.ts`)

**Files:**
- Create: `apps/web/src/warm-set.ts`
- Test: `apps/web/src/warm-set.test.ts`

**Interfaces (produces):**
- `function updateRecency(prev: string[], activeIds: string[], existingIds: string[]): string[]`
  — returns a recency-ordered list (most-recent first): `activeIds` (in given order) moved/added to the front, the remaining `prev` entries kept in their prior relative order, and any id not in `existingIds` dropped. Idempotent when active is already at front.
- `function computeWarmSet(recency: string[], activeIds: string[], capacity: number): Set<string>`
  — always includes every id in `activeIds`; then fills from `recency` (front first, skipping ids already included) until the set size reaches `max(capacity, activeIds.length)`. Ignores ids in `activeIds` not present in `recency` (they're still included). Capacity < active count still keeps all active.

- [ ] **Step 1: Write failing tests**

```ts
// apps/web/src/warm-set.test.ts
import { describe, expect, it } from 'vitest'
import { computeWarmSet, updateRecency } from './warm-set'

describe('updateRecency', () => {
  it('moves active ids to the front, preserving order of the rest', () => {
    expect(updateRecency(['a', 'b', 'c'], ['c'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b'])
  })
  it('adds a newly-active id not seen before to the front', () => {
    expect(updateRecency(['a', 'b'], ['d'], ['a', 'b', 'd'])).toEqual(['d', 'a', 'b'])
  })
  it('keeps multiple active ids in their given order at the front', () => {
    expect(updateRecency(['a', 'b', 'c'], ['c', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'b', 'a'])
  })
  it('drops ids no longer present', () => {
    expect(updateRecency(['a', 'b', 'c'], ['a'], ['a', 'c'])).toEqual(['a', 'c'])
  })
  it('is idempotent when active is already at the front', () => {
    expect(updateRecency(['a', 'b', 'c'], ['a'], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })
})

describe('computeWarmSet', () => {
  it('keeps the N most-recent, always including active', () => {
    expect(computeWarmSet(['a', 'b', 'c', 'd', 'e'], ['a'], 3)).toEqual(new Set(['a', 'b', 'c']))
  })
  it('always includes all active ids even beyond capacity', () => {
    expect(computeWarmSet(['a', 'b', 'c'], ['a', 'b'], 1)).toEqual(new Set(['a', 'b']))
  })
  it('fills remaining capacity from recency after active', () => {
    expect(computeWarmSet(['x', 'a', 'b', 'c'], ['c'], 3)).toEqual(new Set(['c', 'x', 'a']))
  })
  it('returns all when fewer than capacity', () => {
    expect(computeWarmSet(['a', 'b'], ['a'], 8)).toEqual(new Set(['a', 'b']))
  })
})
```

- [ ] **Step 2: Run — expect FAIL** (`cd apps/web && bun run vitest run --config vitest.config.ts src/warm-set.test.ts`) — module not found.

- [ ] **Step 3: Implement**

```ts
// apps/web/src/warm-set.ts

/**
 * Recency-ordered tab ids (most-recent first). The currently-active ids are
 * promoted to the front (in the given order); the remaining previous entries
 * keep their relative order; ids that no longer exist are dropped.
 */
export function updateRecency(
  prev: string[],
  activeIds: string[],
  existingIds: string[],
): string[] {
  const exists = new Set(existingIds)
  const active = activeIds.filter((id) => exists.has(id))
  const rest = prev.filter((id) => exists.has(id) && !active.includes(id))
  return [...active, ...rest]
}

/**
 * The set of tab ids to keep mounted: every active id, plus the most-recent
 * others until the set reaches `max(capacity, activeIds.length)`.
 */
export function computeWarmSet(
  recency: string[],
  activeIds: string[],
  capacity: number,
): Set<string> {
  const warm = new Set(activeIds)
  const target = Math.max(capacity, warm.size)
  for (const id of recency) {
    if (warm.size >= target) break
    warm.add(id)
  }
  return warm
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`git add apps/web/src/warm-set.ts apps/web/src/warm-set.test.ts && git commit -m "feat(web): pure LRU warm-set core"`) — NO attribution trailers.

---

### Task 2: `useWarmSet` hook + Workspace integration

**Files:**
- Modify: `apps/web/src/Workspace.tsx` (the panel-mount map at lines ~234-263)
- Create: `apps/web/src/use-warm-set.ts` (the hook)
- Test: `apps/web/src/use-warm-set.test.tsx` (createRoot/act, exercising recency + cap through the hook)

**Interfaces:**
- Consumes Task 1's `updateRecency`, `computeWarmSet`.
- `function useWarmSet(allSessionIds: string[], activeIds: string[]): Set<string>` — maintains recency state across renders (updates when `activeIds`/`allSessionIds` change), picks `N = matchMedia('(max-width: 768px)').matches ? 3 : 8`, returns the warm set of session ids to mount.

- [ ] **Step 1: Write the hook**

```ts
// apps/web/src/use-warm-set.ts
import { useEffect, useRef, useState } from 'react'
import { computeWarmSet, updateRecency } from './warm-set'

const DESKTOP_N = 8
const MOBILE_N = 3

function warmCapacity(): number {
  if (typeof window === 'undefined' || !window.matchMedia) return DESKTOP_N
  return window.matchMedia('(max-width: 768px)').matches ? MOBILE_N : DESKTOP_N
}

/**
 * Returns the set of session ids that should stay MOUNTED: the active pane(s)
 * plus the most-recently-viewed others up to an LRU cap (8 desktop / 3 mobile).
 * Sessions beyond the cap are evicted (the caller unmounts them); re-selecting
 * one re-enters the warm set and remounts it cold.
 */
export function useWarmSet(allSessionIds: string[], activeIds: string[]): Set<string> {
  const recency = useRef<string[]>([])
  const [warm, setWarm] = useState<Set<string>>(() => new Set(activeIds))
  // Recompute whenever the active pane(s) or the open-session set changes.
  const key = `${activeIds.join(',')}|${allSessionIds.join(',')}`
  useEffect(() => {
    recency.current = updateRecency(recency.current, activeIds, allSessionIds)
    setWarm(computeWarmSet(recency.current, activeIds, warmCapacity()))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return warm
}
```

- [ ] **Step 2: Write the failing integration test** (createRoot/act, render a tiny component using the hook; assert that after activating > N distinct ids, the warm set holds exactly N and the active id, and the oldest is evicted). Run — expect FAIL (hook not created). Mirror the `createRoot`+`act` harness from `apps/web/src/ChatView.test.tsx`. (Set `window.matchMedia` to return desktop in the test so N=8, or test with a small N by activating > 8 ids.)

> Concrete contract to assert: mount a probe component `function P({active, all}) { const w = useWarmSet(all, active); return <span data-w={[...w].sort().join(',')} /> }`. Render with `all=['s1'..'s10']`, activate them one at a time via rerenders (`active=['s1']`, then `['s2']`, …). After activating s1..s10 in order, the warm set must contain s10 (active) + the 7 most-recent (s9..s3) = 8 ids, and must NOT contain s1/s2. Read `data-w`.

- [ ] **Step 3: Wire into Workspace** (`apps/web/src/Workspace.tsx`)

Compute the warm set from the session tabs and active panes, and render a panel slot only for warm session tabs (file tabs always render):
```tsx
  const sessionIds = allTabs.filter((t) => t.kind === 'session').map((t) => t.id)
  const activeIds = [paneA, split ? paneB : null].filter((x): x is string => x != null)
  const warm = useWarmSet(sessionIds, activeIds)
```
Then in the `allTabs.map`, skip mounting a session tab that isn't warm:
```tsx
        {allTabs.map((t) => {
          const inA = t.id === paneA
          const inB = split && t.id === paneB
          const visible = inA || inB
          // Evicted (cold) session tabs render nothing — clicking the tab makes it
          // active → warm → it remounts. The `!visible` guard is load-bearing: the
          // hook updates `warm` in an effect (one render behind), so a just-activated
          // pane may not be in `warm` yet — always mount the visible pane regardless,
          // or it blanks for a frame. File tabs are cheap and always render.
          if (t.kind === 'session' && !visible && !warm.has(t.id)) return null
          return ( /* …existing slot div + AgentPanel/MarkdownFilePanel unchanged… */ )
        })}
```
(Keep the existing slot `div`, `visible ? 'flex' : 'hidden'`, `order`, `active={visible}`, and the file-tab branch exactly as they are.)

- [ ] **Step 4: Run** the hook test + `cd apps/web && bun run vitest run --config vitest.config.ts` — hook test PASS; no NEW failures (4 pre-existing `shell.structure` only). `bun run typecheck` exit 0.

- [ ] **Step 5: Commit** (`git add apps/web/src/use-warm-set.ts apps/web/src/use-warm-set.test.tsx apps/web/src/Workspace.tsx && git commit -m "feat(web): LRU warm-set caps mounted session panels (8 desktop / 3 mobile)"`) — NO attribution trailers.

---

### Task 3: Verify + finish
- [ ] Full apps/web suite (from apps/web, local config) + typecheck green (modulo the 4 pre-existing).
- [ ] Manual smoke note (per memory: in-browser verification pending) — open >8 sessions, confirm switching among recent is instant and the oldest cold-loads on return; not a unit-test blocker.

## Self-review notes
- Spec Component 4 mechanism (LRU mounted set, evict beyond N, dispose-on-evict, file tabs unaffected) → Tasks 1-2. Measured params (N=8/3, no drop-WebGL-on-hide) → Global Constraints + the hook. Memory-pressure eviction → explicitly out of scope.
- Eviction = React unmounts the AgentPanel → its effect cleanup runs `mounted.dispose()` (detach + terminal dispose), which already frees the WebGL context. No TerminalView change needed.
