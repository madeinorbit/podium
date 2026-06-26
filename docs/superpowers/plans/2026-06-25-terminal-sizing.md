# Visibility-driven terminal sizing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop DOM mount/visibility from changing the PTY size (fixing the quarter-size terminal bug), and keep terminals warm across chat↔native.

**Architecture:** A PTY has one authoritative size (`Session.geometry`, server-owned). Per-session foreground is only knowable client-side (one browser page = one relay client id attached to all its tabs), so the **client** is the primary gate: a terminal proposes a size only when it is the *active* tab of a *visible* page and the container is measurable. The **server** adds coarse page-level defense (a backgrounded page never drives) and prefers visible clients on control handoff.

**Tech Stack:** TypeScript, xterm.js + `@xterm/addon-fit`, vitest (+ happy-dom for client DOM tests), React (apps/web).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-25-terminal-sizing-warm-cache-design.md`.
- Arbitration: **last-foregrounded-wins**; the Take Control button is the explicit override. Auto-grab on foreground may steal from a remote controller.
- Eligibility = `active` prop AND `document.visibilityState === 'visible'`. The actual resize still waits for a *measurable* container (retry-until-measurable).
- A redundant resize (same grid) raises SIGWINCH and repaints TUIs — send `redraw()` instead, and only when forcing a repaint on reveal.
- TDD throughout: failing test first, minimal impl, frequent commits.
- Commit message footer (every commit):
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01M7Y5ztnnsG9m5Uska8Miyt
  ```
- Run tests from repo root with `bun run vitest run <path>` (matches existing scripts). Worktree: `.worktrees/terminal-sizing`.
- **Out of this plan:** Component 4 (warm-set LRU + WebGL eviction) is gated on a measurement experiment and gets its own plan after Components 1–3 land. Min-size co-viewing is out of scope.

---

### Task 1: Pure resize-decision core (`session-viewport.ts`)

The one place that decides, given a freshly fitted grid and the server's current grid, whether to resize, redraw, or do nothing. Pure function, no DOM — fully unit-testable.

**Files:**
- Create: `packages/terminal-client/src/session-viewport.ts`
- Test: `packages/terminal-client/src/session-viewport.test.ts`

**Interfaces:**
- Produces:
  - `type Grid = { cols: number; rows: number }`
  - `type ResizeAction = { kind: 'resize'; cols: number; rows: number } | { kind: 'redraw' } | { kind: 'none' }`
  - `function decideResizeAction(fitted: Grid, serverGrid: Grid, opts: { forceRedrawIfSame: boolean }): ResizeAction`

- [ ] **Step 1: Write the failing test**

```ts
// packages/terminal-client/src/session-viewport.test.ts
import { describe, expect, it } from 'vitest'
import { decideResizeAction } from './session-viewport'

describe('decideResizeAction', () => {
  it('resizes when the fitted grid differs from the server grid', () => {
    expect(
      decideResizeAction({ cols: 200, rows: 50 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: false }),
    ).toEqual({ kind: 'resize', cols: 200, rows: 50 })
  })

  it('redraws (not resize) when grids match and a repaint is forced (reveal)', () => {
    expect(
      decideResizeAction({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: true }),
    ).toEqual({ kind: 'redraw' })
  })

  it('does nothing when grids match and no repaint is forced (steady-state viewport tick)', () => {
    expect(
      decideResizeAction({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, { forceRedrawIfSame: false }),
    ).toEqual({ kind: 'none' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run packages/terminal-client/src/session-viewport.test.ts`
Expected: FAIL — `decideResizeAction` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/terminal-client/src/session-viewport.ts
export type Grid = { cols: number; rows: number }
export type ResizeAction =
  | { kind: 'resize'; cols: number; rows: number }
  | { kind: 'redraw' }
  | { kind: 'none' }

/**
 * Decide what to push to the agent given a freshly fitted grid and the server's
 * current authoritative grid. A genuine size change resizes the PTY; an unchanged
 * size only repaints (and only when a reveal forces it), because re-sending the
 * same winsize raises SIGWINCH and flashes TUIs.
 */
export function decideResizeAction(
  fitted: Grid,
  serverGrid: Grid,
  opts: { forceRedrawIfSame: boolean },
): ResizeAction {
  if (fitted.cols !== serverGrid.cols || fitted.rows !== serverGrid.rows) {
    return { kind: 'resize', cols: fitted.cols, rows: fitted.rows }
  }
  return opts.forceRedrawIfSame ? { kind: 'redraw' } : { kind: 'none' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run packages/terminal-client/src/session-viewport.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-client/src/session-viewport.ts packages/terminal-client/src/session-viewport.test.ts
git commit -m "feat(terminal-client): pure resize/redraw/none decision core"
```

---

### Task 2: Eligibility-gated sizing in `mountSession` + `setActive`

Replace the scattered fit logic (bare mount-fit at `session-mount.ts:63`, the controller-gated `viewport.onChange` at :191-195, and the one-shot `onControllerEnter` fit at :170-179) with eligibility-driven sizing. A terminal proposes a size only when eligible AND measurable; becoming eligible claims control (last-foregrounded-wins).

**Files:**
- Modify: `packages/terminal-client/src/session-mount.ts`
- Test: `packages/terminal-client/src/session-mount.sizing.test.ts` (new)

**Interfaces:**
- Consumes: `decideResizeAction`, `Grid` from Task 1; `TerminalView.fit()`/`isFittable()`; `SessionConnection.sendResize/redraw/requestControl`; the `onState` callback's `state.cols/state.rows`.
- Produces (additions):
  - `MountSessionOptions.active?: boolean` (initial eligibility; default `true`).
  - `MountedSession.setActive(active: boolean): void` — called by the panel when the tab's active/visible state changes; remount is NOT required.
- Internal behavior:
  - `eligible = active && pageVisible()` where `pageVisible()` returns `document.visibilityState === 'visible'` (true when `document` is absent, e.g. tests without it).
  - Track `serverGrid` from `onState` (`{ cols, rows }`).
  - On **becoming eligible**: `connection.requestControl()`, then fit-with-retry; once measurable, apply `decideResizeAction(fitted, serverGrid, { forceRedrawIfSame: true })`.
  - On **viewport change while eligible**: fit-with-retry; apply `decideResizeAction(fitted, serverGrid, { forceRedrawIfSame: false })`.
  - On **page `visibilitychange`**: re-evaluate eligibility (acts only when `active`).
  - When **ineligible**: never resize/redraw/requestControl.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/terminal-client/src/session-mount.sizing.test.ts
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { SessionCallbacks, SocketHub } from './connection'
import { mountSession } from './session-mount'

function withResizeObserver(): void {
  if (!('ResizeObserver' in globalThis)) {
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  }
}

/** Hub stub that records resize/redraw/requestControl and lets a test drive onState. */
function fakeHub() {
  let cbs: SessionCallbacks = {}
  const calls = { resize: [] as Array<[number, number]>, redraw: 0, requestControl: 0 }
  const connection = {
    sendResize: (c: number, r: number) => calls.resize.push([c, r]),
    sendInput: () => {},
    requestControl: () => {
      calls.requestControl += 1
    },
    redraw: () => {},
    state: () => ({ role: 'controller', cols: 80, rows: 24, epoch: 0, connected: true }),
  }
  const hub = {
    attach: (_id: string, cb: SessionCallbacks = {}) => {
      cbs = cb
      return connection
    },
    detach: () => {},
  } as unknown as SocketHub
  return {
    hub,
    calls,
    state: (cols: number, rows: number) =>
      cbs.onState?.({ role: 'controller', cols, rows, epoch: 0, connected: true } as never),
  }
}

/** A host element that reports a real size so fit() can measure a grid. */
function fittableHost(): HTMLDivElement {
  const el = document.createElement('div')
  // xterm reads clientWidth/Height via getComputedStyle; happy-dom returns 0 by
  // default, so stub the measurement the FitAddon relies on.
  Object.defineProperty(el, 'clientWidth', { value: 1200, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 800, configurable: true })
  return el
}

describe('mountSession eligibility-gated sizing', () => {
  it('does not resize or claim control when mounted inactive (hidden tab)', () => {
    withResizeObserver()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    expect(calls.requestControl).toBe(0)
    expect(calls.resize).toEqual([])
    mounted.setActive(false) // still inactive: still nothing
    expect(calls.resize).toEqual([])
    mounted.dispose()
  })

  it('claims control and resizes when it becomes active and is measurable', () => {
    withResizeObserver()
    const { hub, calls } = fakeHub()
    const mounted = mountSession(fittableHost(), { hub, sessionId: 's1', active: false })
    mounted.setActive(true)
    expect(calls.requestControl).toBe(1)
    expect(calls.resize.length).toBeGreaterThanOrEqual(1)
    expect(calls.resize.at(-1)?.[0]).toBeGreaterThan(2) // a real fitted width, not the 80 default-only path
    mounted.dispose()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run packages/terminal-client/src/session-mount.sizing.test.ts`
Expected: FAIL — `active`/`setActive` not honored; `requestControl` not called on activation (current code resizes on mount regardless of `active`).

- [ ] **Step 3: Implement eligibility gating in `mountSession`**

In `packages/terminal-client/src/session-mount.ts`:

Add to `MountSessionOptions`:
```ts
  /**
   * Whether this panel is the active, foreground tab. Only an active panel on a
   * visible page may drive the PTY size (and claim control). Defaults to true so
   * existing single-panel callers are unaffected. Toggle at runtime via
   * MountedSession.setActive — the panel is NOT remounted on tab switches.
   */
  active?: boolean
```

Add to `MountedSession`:
```ts
  setActive(active: boolean): void
```

Replace the initial-fit + retry + viewport wiring. Concretely:

```ts
export function mountSession(el: HTMLElement, opts: MountSessionOptions): MountedSession {
  const { hub, sessionId } = opts
  const view = new TerminalView()
  view.mount(el)

  let active = opts.active ?? true
  let serverGrid: Grid = { cols: view.cols(), rows: view.rows() }
  const pageVisible = (): boolean =>
    typeof document === 'undefined' || document.visibilityState === 'visible'
  const eligible = (): boolean => active && pageVisible()

  // fit-with-retry: a measurable container fits immediately; an unmeasurable one
  // (just-revealed, layout not settled) retries across rAFs. onMeasured runs once
  // a grid is obtained.
  const MAX_FIT_RETRIES = 10
  let fitRunning = false
  function fitWithRetry(onMeasured: (grid: Grid) => void): void {
    const grid = view.fit()
    if (grid) {
      onMeasured(grid)
      return
    }
    if (fitRunning) return
    fitRunning = true
    let attempts = 0
    const retry = (): void => {
      attempts += 1
      const g = view.fit()
      if (g) {
        fitRunning = false
        onMeasured(g)
        return
      }
      if (attempts < MAX_FIT_RETRIES) requestAnimationFrame(retry)
      else fitRunning = false
    }
    requestAnimationFrame(retry)
  }

  function applyFit(forceRedrawIfSame: boolean): void {
    if (!eligible()) return
    fitWithRetry((grid) => {
      const action = decideResizeAction(grid, serverGrid, { forceRedrawIfSame })
      if (action.kind === 'resize') connection.sendResize(action.cols, action.rows)
      else if (action.kind === 'redraw') connection.redraw()
    })
  }

  function becomeEligible(): void {
    if (!eligible()) return
    connection.requestControl() // last-foregrounded-wins
    applyFit(true) // force a repaint on reveal even when the size is unchanged
  }
```

Wire `onState` to track `serverGrid` (inside the existing `onState` handler, after the existing `view.resize` reconcile):
```ts
      serverGrid = { cols: state.cols, rows: state.rows }
```

Remove the old mount-time `const fitted = view.fit()` (line 63) and its `if (fitted) connection.sendResize(...)` (line 164); remove `fitAndSend`, `onControllerEnter`'s fit body, and the controller-gate in `viewport.onChange`. Replace the viewport wiring with:
```ts
  const viewport = new DomViewportSource(el)
  const offViewport = viewport.onChange(() => applyFit(false))
```

Add a page-visibility listener:
```ts
  const onVisibility = (): void => {
    if (eligible()) becomeEligible()
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility)
  }
```

Kick the initial state once, after `connection` is created:
```ts
  if (active) becomeEligible()
```

Add `setActive` to the returned object and tear down the listener in `dispose`:
```ts
    setActive(next: boolean): void {
      if (next === active) return
      active = next
      if (active) becomeEligible()
      // going inactive: do nothing — never resize a hidden panel
    },
```
```ts
    dispose() {
      // ...existing teardown...
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },
```

Add the import at the top:
```ts
import { decideResizeAction, type Grid } from './session-viewport'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun run vitest run packages/terminal-client/src/session-mount.sizing.test.ts packages/terminal-client/src/session-mount.ready.test.ts`
Expected: PASS. (Re-run the ready test to confirm no regression in the attach/onReady path.)

- [ ] **Step 5: Run the full terminal-client suite**

Run: `bun run vitest run packages/terminal-client`
Expected: PASS. Fix any fallout in `session-mount.first-frame.test.ts` / `terminal-view.fit.test.ts` caused by removing the unconditional mount-fit (those tests should drive `active`/`setActive` or assert via `onState` now).

- [ ] **Step 6: Commit**

```bash
git add packages/terminal-client/src/session-mount.ts packages/terminal-client/src/session-mount.sizing.test.ts
git commit -m "feat(terminal-client): gate PTY resize on active+visible+measurable, claim control on foreground"
```

---

### Task 3: Thread `active` from the panel; mark chat-mode terminal inactive

The panel owns the `active` prop and the mode. It must (a) pass initial `active`, (b) call `setActive` when `active` or mode changes, and (c) treat chat mode as inactive so the hidden-under-chat terminal never drives size.

**Files:**
- Modify: `apps/web/src/AgentPanel.tsx`
- Test: `apps/web/src/agent-panel-active.test.tsx` (new) — or extend an existing AgentPanel test if present.

**Interfaces:**
- Consumes: `MountedSession.setActive` (Task 2).
- The panel computes `terminalActive = active && effectiveMode === 'native' && !hibernated && !exited`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/agent-panel-active.test.tsx
// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

// Capture the latest MountedSession handed back by mountSession.
const setActive = vi.fn()
vi.mock('@podium/terminal-client', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return {
    ...real,
    mountSession: vi.fn(() => ({
      connection: { state: () => ({ role: 'controller' }), sendInput: vi.fn() },
      view: {
        setFileLinks: vi.fn(),
        onScroll: () => () => {},
        atBottom: () => true,
        focus: vi.fn(),
      },
      setActive,
      dispose: vi.fn(),
    })),
  }
})

// NOTE: exact render harness mirrors the nearest existing AgentPanel/Workspace test.
// The assertion that matters:
describe('AgentPanel active wiring', () => {
  it('calls setActive(false) when the panel is backgrounded or switched to chat', () => {
    // render <AgentPanel sessionId="s1" active /> in native mode, then rerender
    // with active={false}; expect setActive to have been called with false.
    // (Fill the render/rerender with the project's React test util used elsewhere.)
    expect(typeof setActive).toBe('function')
  })
})
```

> Render harness (same as `apps/web/src/ChatView.test.tsx`): `import { act } from 'react'`, `import { createRoot } from 'react-dom/client'`, `// @vitest-environment happy-dom`, and `vi.mock('./store', …)` to supply a fake `useStore()` (copy the mock shape from `ChatView.test.tsx` — `hub`, `sessions`, `repos`, `trpc`, `drafts`, `panelMode`, `setSessionDraft`, `openFile`, etc.). Mount with `act(() => root.render(<AgentPanel sessionId="s1" active />))`; re-render with `active={false}` inside another `act(...)`. The behavioral contract to assert: after mount with `active` in native mode, flipping `active` to `false` (or `effectiveMode` to `'chat'`) calls `setActive(false)`; flipping back calls `setActive(true)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/web/src/agent-panel-active.test.tsx`
Expected: FAIL — AgentPanel does not pass `active` to `mountSession` nor call `setActive`.

- [ ] **Step 3: Implement the wiring**

In `AgentPanel.tsx`:

Pass initial active in the `mountSession` call (~line 346):
```tsx
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId,
      active: active && effectiveMode === 'native' && !hibernated && !exited,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      ...(E2E ? { test: true } : {}),
      focusOnMount: false,
      onReady: () => setReady(true),
      onFrame: scheduleSample,
    })
```

Add an effect that pushes active changes without remounting (place after the mount effect):
```tsx
  // Drive the terminal's eligibility from the tab's active/visible/mode state.
  // Separate from the mount effect so a tab switch (or chat<->native toggle once
  // the terminal stays mounted) never tears down and re-attaches the terminal.
  const terminalActive = active && effectiveMode === 'native' && !hibernated && !exited
  useEffect(() => {
    mountedRef.current?.setActive(terminalActive)
  }, [terminalActive])
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/web/src/agent-panel-active.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/AgentPanel.tsx apps/web/src/agent-panel-active.test.tsx
git commit -m "feat(web): thread active/visible/mode into the terminal's size eligibility"
```

---

### Task 4: Server — ignore resize from a backgrounded page

A fully backgrounded page (`client.visible === false`) must not move the shared PTY size, even if it is somehow the controller (e.g. it was controller before the page was hidden).

**Files:**
- Modify: `apps/server/src/session.ts:333-340` (`handleResize`)
- Test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: existing `ClientConn.visible: boolean` (`session.ts:28`).

- [ ] **Step 1: Write the failing test**

```ts
// add inside describe('Session', ...) in apps/server/src/session.test.ts
it('ignores a resize from the controller when its page is backgrounded', () => {
  const toDaemon = vi.fn()
  const s = makeSession(toDaemon)
  const a = makeClient('a')
  s.attachClient(a) // controller
  a.visible = false // page backgrounded
  s.handleResize('a', 200, 50)
  expect(s.geometry).toEqual(geo) // unchanged
  expect(toDaemon).not.toHaveBeenCalledWith({ type: 'resize', sessionId: 's1', cols: 200, rows: 50 })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/server/src/session.test.ts -t "backgrounded"`
Expected: FAIL — geometry becomes 200×50 and a daemon resize is sent.

- [ ] **Step 3: Implement the guard**

```ts
  handleResize(clientId: string, cols: number, rows: number): void {
    const client = this.clients.get(clientId)
    if (client) client.viewport = { cols, rows }
    // A backgrounded page must never move the shared PTY size — its grid is stale
    // (a hidden xterm reports its last on-screen size). Record the viewport so a
    // later foreground/takeover can use it, but do not drive the agent.
    if (clientId === this.controllerId && client?.visible !== false) {
      this.geometry = { cols, rows }
      this.toDaemon({ type: 'resize', sessionId: this.sessionId, cols, rows })
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/server/src/session.test.ts`
Expected: PASS (existing resize test still green — `makeClient` defaults `visible: true`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "fix(server): ignore PTY resize from a backgrounded page"
```

---

### Task 5: Server — don't auto-promote a backgrounded page; prefer visible on handoff

Two related guards so a hidden page never silently becomes the size-driving controller.

**Files:**
- Modify: `apps/server/src/session.ts:190` (auto-promote in `attachClient`), `:298-312` (`detachClient` handoff)
- Test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: `ClientConn.visible`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/server/src/session.test.ts
it('does not auto-promote a backgrounded first attacher to controller', () => {
  const s = makeSession()
  const a = makeClient('a')
  a.visible = false
  s.attachClient(a)
  expect(s.controllerId).toBeNull()
  expect(s.geometry).toEqual(geo) // frozen at the default; nothing drove it
})

it('hands control on detach to a visible client, not a hidden one', () => {
  const s = makeSession()
  const a = makeClient('a') // visible controller
  const hidden = makeClient('h')
  hidden.visible = false
  const c = makeClient('c') // visible
  s.attachClient(a)
  s.attachClient(hidden)
  s.attachClient(c)
  expect(s.controllerId).toBe('a')
  s.detachClient('a')
  expect(s.controllerId).toBe('c') // skips the hidden client
})

it('freezes (null controller) on detach when only hidden clients remain', () => {
  const s = makeSession()
  const a = makeClient('a')
  const hidden = makeClient('h')
  hidden.visible = false
  s.attachClient(a)
  s.attachClient(hidden)
  s.detachClient('a')
  expect(s.controllerId).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run vitest run apps/server/src/session.test.ts -t "promote|hands control|freezes"`
Expected: FAIL — backgrounded attacher becomes controller; handoff picks the first remaining (hidden) client.

- [ ] **Step 3: Implement the guards**

Auto-promote (replace line 190):
```ts
    if (this.controllerId === null && client.visible !== false) this.controllerId = client.id
```

Handoff (replace the body of the `if (this.controllerId === clientId)` block in `detachClient`):
```ts
    if (this.controllerId === clientId) {
      // Prefer a visible client; a hidden page must not silently inherit the size-
      // driving controller role. If none are visible, freeze (null) — geometry is
      // left untouched so the agent keeps its last real size.
      let next: string | null = null
      for (const [id, c] of this.clients) {
        if (c.visible !== false) {
          next = id
          break
        }
      }
      this.controllerId = next
      if (this.controllerId !== null) {
        this.broadcast({
          type: 'controllerChanged',
          sessionId: this.sessionId,
          controllerId: this.controllerId,
          geometry: { ...this.geometry },
        })
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run vitest run apps/server/src/session.test.ts`
Expected: PASS. The existing "first attached client becomes controller" test still passes (its client is `visible: true`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "fix(server): only visible clients auto-acquire/inherit the size-driving controller"
```

---

### Task 6: Keep the terminal mounted across chat↔native

Stop disposing the terminal on a mode toggle. The terminal stays mounted (hidden under the chat overlay) and is marked inactive via Task 3's wiring, so it neither drives size nor wastes a re-attach.

**Files:**
- Modify: `apps/web/src/AgentPanel.tsx` — the mount effect deps (`~line 388`) and the render (`~line 513`).
- Test: `apps/web/src/agent-panel-warm-toggle.test.tsx` (new)

**Interfaces:**
- Consumes: Task 3's `terminalActive` + `setActive`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/web/src/agent-panel-warm-toggle.test.tsx
// @vitest-environment happy-dom
// Mock mountSession (as in Task 3) so we can count construct/dispose calls.
// Assert: toggling effectiveMode native -> chat -> native does NOT call
// mountSession again and does NOT call dispose() — the same MountedSession
// instance is reused; only setActive(false) then setActive(true) are called.
import { describe, expect, it } from 'vitest'
describe('AgentPanel warm chat<->native toggle', () => {
  it('reuses the same terminal instance across a mode toggle', () => {
    // render native; flip to chat; flip to native.
    // expect mountSession called exactly once; dispose not called; setActive
    // toggled false then true. (Render util mirrors sibling apps/web tests.)
    expect(true).toBe(true) // replace with real assertions per the harness
  })
})
```

> Same harness as Task 3 (`createRoot` + `act` + mocked `./store`). The contract: across one native→chat→native cycle (driven by re-rendering `<AgentPanel>` with a changing mocked `panelMode[sessionId]`, or by toggling the mode prop the store exposes), `mountSession` is invoked exactly once and the returned `dispose` is never invoked.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run vitest run apps/web/src/agent-panel-warm-toggle.test.tsx`
Expected: FAIL — today the mount effect re-runs on `effectiveMode`, disposing and recreating the terminal.

- [ ] **Step 3: Implement — decouple mount from mode**

1. Remove `effectiveMode` from the mount effect's dependency array (`~line 388`). The effect should depend only on identity that genuinely requires a fresh terminal: `[hub, sessionId, hibernated, exited, session?.agentKind, setSessionDraft]`.
2. The mount effect must still gate on having a terminal element to mount into. Change the early-out at `~line 244` from `if (effectiveMode !== 'native' …) return` to `if (hibernated || exited) return` (the terminal mounts for both modes; chat just overlays it).
3. In the render, keep the terminal container always mounted while live, and show/hide it by mode instead of conditionally rendering it. Replace the `effectiveMode === 'native' && …` guard around the terminal `div` (`~line 513`) with an always-rendered container whose visibility flips:
```tsx
        <div
          ref={termRef}
          className={cn('term min-h-0 flex-1 px-1.5 py-1', effectiveMode === 'chat' && 'hidden')}
          data-role="controller"
        />
        {effectiveMode === 'chat' && chatCapable && (
          <ChatView /* …existing props… */ />
        )}
```
   (Keep the existing terminal `div` attributes/handlers; only the conditional-render becomes a visibility class. Confirm against the current JSX — the goal is: the terminal element exists in both modes, hidden in chat.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run vitest run apps/web/src/agent-panel-warm-toggle.test.tsx apps/web/src/agent-panel-active.test.tsx`
Expected: PASS — one `mountSession`, no `dispose` across the toggle; `setActive(false)`/`setActive(true)` observed.

- [ ] **Step 5: Manual smoke (documented, not a unit test)**

Per memory (UI features need runtime verification): after merging, verify in-browser that chat↔native toggles instantly with no "Starting…" flash and the terminal fills the pane. Note this as a follow-up verification item, not a blocker for the unit-tested tasks.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/AgentPanel.tsx apps/web/src/agent-panel-warm-toggle.test.tsx
git commit -m "feat(web): keep the terminal mounted across chat<->native (warm toggle)"
```

---

### Task 7: Full suite + typecheck

**Files:** none (verification).

- [ ] **Step 1: Run the affected suites**

Run: `bun run vitest run packages/terminal-client apps/server/src/session.test.ts apps/web/src`
Expected: PASS.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck` (or the repo's configured typecheck script).
Expected: no errors.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test: stabilize terminal-sizing suites + typecheck"
```

---

## Self-review notes

- **Spec coverage:** Component 1 → Tasks 4–5. Component 2 → Tasks 1–3. Component 3 → Task 6. Component 4 (warm-set LRU + WebGL eviction, measurement-gated) → explicitly deferred to its own plan (Global Constraints). Min-size co-view → out of scope (spec).
- **Type consistency:** `decideResizeAction(fitted, serverGrid, { forceRedrawIfSame })` and `Grid` are defined in Task 1 and consumed verbatim in Task 2. `MountedSession.setActive(active: boolean)` is defined in Task 2 and consumed in Tasks 3 & 6. `ClientConn.visible` is pre-existing.
- **Known soft spots (resolve during execution, against the live harness):** the React tests in Tasks 3 & 6 use the `createRoot` + `act` + `vi.mock('./store')` harness from `apps/web/src/ChatView.test.tsx` (the fake `useStore` shape is copied from there); the JSX edit in Task 6 Step 3 must be reconciled against the current `AgentPanel` return (the goal is invariant: the terminal element exists in both modes, hidden in chat). These two are described by contract because the surrounding store-mock and JSX are the source of truth and must be read at execution time.
