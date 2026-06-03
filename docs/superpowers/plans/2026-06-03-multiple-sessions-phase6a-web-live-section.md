# Multiple Sessions — Phase 6a: Functional "Live" Section in the Command-Center Mockup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, functional **Live** section to `apps/web`'s command-center mockup that drives the multi-session backend end to end — connect a `SocketHub` (ws) + a tRPC client (http), list live sessions + discovered conversations, create/resume/kill, and attach a real xterm terminal to the selected session — without disturbing the existing mock modes.

**Architecture:** A self-contained `<LiveSessions/>` component mounted as a new `live` mode in `App.tsx`. It reads the server origin from `?server=` (the e2e/demo entry; falls back to a connect field). The control plane is tRPC v11 (`sessions.*` + `discovery.scan`); the data plane is the `SocketHub` from `@podium/terminal-client`; the terminal is `mountSession(el, { hub, sessionId, toolbarEl })`. It publishes `window.__podium` for the Phase 6b e2e.

**Tech Stack:** React 19, `@trpc/client` v11, `@podium/terminal-client`, `@podium/protocol` (types), `@podium/server` (`AppRouter` type only). Package: `apps/web`.

**Spec:** `docs/superpowers/specs/2026-06-03-multiple-sessions-design.md` §5, §9. **Note:** the original spec assumed a from-scratch switcher; per the user's decision this increment instead adds the functional section *inside* the existing command-center mockup (`App.tsx`), leaving the mock modes untouched.

---

## Sequencing note

Package-scoped gate: `bun run --filter @podium/web typecheck && build` + `bun run lint`. The
backend packages (protocol/server/terminal-client) are already built on this branch. There is no
web unit test; the section's runtime behavior is proven by the **Phase 6b** e2e. `e2e/` stays red
until 6b — not a gate here. Do NOT run workspace-wide typecheck/test as a 6a gate.

`apps/web` importing the `AppRouter` *type* from `@podium/server` is allowed by ARCHITECTURE
(type-only; no runtime app→app dep). Use `import type`.

---

## File structure

- `apps/web/src/trpc.ts` — tRPC v11 client factory + `?server=` parser (create).
- `apps/web/src/LiveSessions.tsx` — the functional section (create).
- `apps/web/src/App.tsx` — add the `live` mode (ModeId, `modes[]`, main-stage, nav already maps `modes`).
- `apps/web/src/App.css` — a handful of `.live-*` classes (append).
- `apps/web/package.json` — add `@trpc/client@^11.0.0` + `@podium/server` (workspace:*, for the type).

---

### Task 1: deps + tRPC client

**Files:** Edit `apps/web/package.json`; create `apps/web/src/trpc.ts`.

- [ ] **Step 1:** Add to `apps/web/package.json` dependencies: `"@trpc/client": "^11.0.0"` and `"@podium/server": "workspace:*"`. Run `bun install`.

- [ ] **Step 2:** Create `apps/web/src/trpc.ts`:

```ts
import type { AppRouter } from '@podium/server'
import { createTRPCClient, httpBatchLink } from '@trpc/client'

export type Trpc = ReturnType<typeof createTRPCClient<AppRouter>>

/** Parse `?server=ws://host:port` into the ws client URL + the http origin for tRPC. */
export function parseServer(search: string): { wsClientUrl: string; httpOrigin: string } | null {
  const server = new URLSearchParams(search).get('server')
  if (!server) return null
  return { wsClientUrl: `${server}/client`, httpOrigin: server.replace(/^ws/, 'http') }
}

export function makeTrpc(httpOrigin: string): Trpc {
  return createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: `${httpOrigin}/trpc` })] })
}
```

- [ ] **Step 3:** `bun run --filter @podium/web typecheck` → exit 0 (the `AppRouter` type resolves). Commit:
  `git add apps/web/package.json apps/web/src/trpc.ts bun.lock && git commit -m "feat(web): tRPC v11 client + ?server= parser"`

---

### Task 2: the LiveSessions component

**Files:** Create `apps/web/src/LiveSessions.tsx`.

- [ ] **Step 1:** Create `apps/web/src/LiveSessions.tsx`:

```tsx
import type { ConversationSummaryWire, SessionMeta } from '@podium/protocol'
import { type MountedSession, SocketHub, mountSession } from '@podium/terminal-client'
import { useEffect, useRef, useState } from 'react'
import { type Trpc, makeTrpc, parseServer } from './trpc'

type AgentKind = 'claude-code' | 'codex'

export function LiveSessions() {
  const initial = parseServer(window.location.search)
  const [origin, setOrigin] = useState<string | null>(
    initial ? new URLSearchParams(window.location.search).get('server') : null,
  )
  const [originDraft, setOriginDraft] = useState('ws://localhost:8787')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [discovered, setDiscovered] = useState<ConversationSummaryWire[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [activeRole, setActiveRole] = useState<string>('')
  const [newCwd, setNewCwd] = useState('')
  const [newKind, setNewKind] = useState<AgentKind>('claude-code')

  const hubRef = useRef<SocketHub | null>(null)
  const trpcRef = useRef<Trpc | null>(null)
  const termRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef<MountedSession | null>(null)

  // Connect the hub + tRPC when we have a server origin.
  useEffect(() => {
    if (!origin) return
    const cfg = parseServer(`?server=${origin}`)
    if (!cfg) return
    const hub = new SocketHub({
      url: cfg.wsClientUrl,
      viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
    })
    hubRef.current = hub
    const trpc = makeTrpc(cfg.httpOrigin)
    trpcRef.current = trpc
    const offSessions = hub.onSessions(setSessions)
    hub.connect()
    void trpc.discovery.scan
      .mutate()
      .then((r) => setDiscovered(r.conversations))
      .catch(() => setDiscovered([]))

    // e2e surface — delegates to the currently-mounted session.
    ;(globalThis as unknown as { __podium?: unknown }).__podium = {
      sessions: () => hub.sessions(),
      attach: (id: string) => setSelectedId(id),
      create: (agentKind: AgentKind, cwd: string) =>
        trpc.sessions.create.mutate({ agentKind, cwd }),
      state: () => mountedRef.current?.connection.state(),
      screenText: () => mountedRef.current?.view.screenText() ?? '',
      screenHash: () => mountedRef.current?.view.screenHash() ?? '',
      sendInput: (s: string) => mountedRef.current?.connection.sendInput(s),
      takeControl: () => mountedRef.current?.connection.requestControl(),
      simulateKeyboard: (inset: number) => {
        const el = termRef.current
        const mounted = mountedRef.current
        if (!el || !mounted) return
        if (inset > 0) {
          const currentH = el.getBoundingClientRect().height
          const effectiveInset = Math.max(inset, Math.ceil(currentH * 0.5))
          el.style.flex = 'none'
          el.style.height = `${Math.max(1, currentH - effectiveInset)}px`
          void el.offsetHeight
        } else {
          el.style.flex = ''
          el.style.height = ''
          void el.offsetHeight
        }
        const grid = mounted.view.fit()
        mounted.connection.sendResize(grid.cols, grid.rows)
      },
    }

    return () => {
      offSessions()
      mountedRef.current?.dispose()
      mountedRef.current = null
      hub.dispose()
      hubRef.current = null
      trpcRef.current = null
      delete (globalThis as unknown as { __podium?: unknown }).__podium
    }
  }, [origin])

  // Mount the terminal for the selected session.
  useEffect(() => {
    const hub = hubRef.current
    if (!hub || !selectedId || !termRef.current) return
    const mounted = mountSession(termRef.current, {
      hub,
      sessionId: selectedId,
      ...(toolbarRef.current ? { toolbarEl: toolbarRef.current } : {}),
      onState: (s) => setActiveRole(`${s.role} ${s.cols}x${s.rows}`),
    })
    mountedRef.current = mounted
    return () => {
      mounted.dispose()
      mountedRef.current = null
    }
  }, [selectedId])

  if (!origin) {
    return (
      <div className="live-connect">
        <p className="eyebrow">Live sessions</p>
        <h2>Connect to a daemon relay</h2>
        <label>
          <span>Server</span>
          <input value={originDraft} onChange={(e) => setOriginDraft(e.target.value)} />
        </label>
        <button type="button" onClick={() => setOrigin(originDraft)}>
          Connect
        </button>
      </div>
    )
  }

  async function createSession() {
    const { sessionId } = await trpcRef.current!.sessions.create.mutate({
      agentKind: newKind,
      cwd: newCwd || '.',
    })
    setSelectedId(sessionId)
  }
  async function resume(conv: ConversationSummaryWire) {
    if (!conv.resume) return
    const { sessionId } = await trpcRef.current!.sessions.resume.mutate({
      agentKind: conv.agentKind,
      cwd: conv.projectPath ?? '.',
      resume: conv.resume,
      conversationId: conv.id,
      ...(conv.title ? { title: conv.title } : {}),
    })
    setSelectedId(sessionId)
  }
  async function kill(id: string) {
    await trpcRef.current!.sessions.kill.mutate({ sessionId: id })
    if (selectedId === id) setSelectedId(null)
  }

  return (
    <div className="live-layout">
      <aside className="live-list" aria-label="Sessions">
        <section className="section">
          <div className="section-toolbar compact">
            <h3>Live sessions</h3>
            <span>{sessions.length}</span>
          </div>
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={selectedId === s.sessionId ? 'live-row active' : 'live-row'}
            >
              <button type="button" data-session={s.sessionId} onClick={() => setSelectedId(s.sessionId)}>
                <strong>{s.title}</strong>
                <small>
                  {s.agentKind} / {s.status} / {s.geometry.cols}x{s.geometry.rows}
                </small>
              </button>
              <button type="button" className="live-kill" onClick={() => kill(s.sessionId)}>
                Kill
              </button>
            </div>
          ))}
        </section>

        <section className="section">
          <div className="section-toolbar compact">
            <h3>New session</h3>
          </div>
          <div className="control-strip compact">
            <select value={newKind} onChange={(e) => setNewKind(e.target.value as AgentKind)}>
              <option value="claude-code">claude-code</option>
              <option value="codex">codex</option>
            </select>
            <input
              placeholder="cwd"
              value={newCwd}
              onChange={(e) => setNewCwd(e.target.value)}
            />
            <button type="button" data-action="new-session" onClick={() => void createSession()}>
              New
            </button>
          </div>
        </section>

        <section className="section">
          <div className="section-toolbar compact">
            <h3>Discovered</h3>
            <span>{discovered.length}</span>
          </div>
          {discovered.slice(0, 30).map((c) => (
            <button key={c.id} type="button" className="live-row" onClick={() => void resume(c)}>
              <strong>{c.title ?? c.id}</strong>
              <small>
                {c.agentKind}
                {c.git?.branch ? ` / ${c.git.branch}` : ''}
                {c.projectPath ? ` / ${c.projectPath}` : ''}
              </small>
            </button>
          ))}
        </section>
      </aside>

      <section className="live-stage">
        <div className="section-toolbar compact">
          <h2>{selectedId ? `Session ${selectedId}` : 'No session selected'}</h2>
          <div className="control-strip compact">
            <span className="state-badge info">{activeRole || 'detached'}</span>
            <button
              type="button"
              data-action="take-control"
              onClick={() => mountedRef.current?.connection.requestControl()}
            >
              Take control
            </button>
          </div>
        </div>
        <div ref={termRef} id="term" className="live-term" />
        <div ref={toolbarRef} id="toolbar" className="live-toolbar" />
      </section>
    </div>
  )
}
```

- [ ] **Step 2:** `bun run --filter @podium/web typecheck` → exit 0. (Do not commit yet; commit after wiring into App.tsx in Task 3.)

---

### Task 3: wire the `live` mode into App.tsx + styles

**Files:** Edit `apps/web/src/App.tsx`, `apps/web/src/App.css`.

- [ ] **Step 1:** In `App.tsx`, extend the mode union (line ~45):
  `type ModeId = 'product' | 'dev' | 'spec' | 'search' | 'settings' | 'live'`

- [ ] **Step 2:** Import the component + an icon. Add `Radio` (or `Waypoints`) to the existing `lucide-react` import, and add `import { LiveSessions } from './LiveSessions'` near the top.

- [ ] **Step 3:** Add a `modes[]` entry (the side-rail + mobile nav both map `modes`, so this is the only nav change needed). Put it after `product`:
  `{ id: 'live', label: 'Live', icon: Radio },`

- [ ] **Step 4:** Add the main-stage branch alongside the others (after the `product` block, before `dev`):
  ```tsx
  {activeMode === 'live' && <LiveSessions />}
  ```

- [ ] **Step 5:** Append `.live-*` styles to `App.css` (keep it simple, fullscreen-friendly):
  ```css
  .live-layout { display: grid; grid-template-columns: 300px 1fr; gap: 12px; height: 100%; min-height: 0; }
  .live-list { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; min-height: 0; }
  .live-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; text-align: left; padding: 8px; border-radius: 8px; }
  .live-row.active { outline: 2px solid var(--accent, #6d9eeb); }
  .live-row > button:first-child { display: flex; flex-direction: column; align-items: flex-start; flex: 1; background: none; border: 0; color: inherit; cursor: pointer; }
  .live-kill { font-size: 11px; }
  .live-stage { display: flex; flex-direction: column; min-height: 0; }
  .live-term { flex: 1; min-height: 0; background: #000; border-radius: 8px; overflow: hidden; }
  .live-toolbar { display: flex; gap: 6px; overflow-x: auto; padding-top: 6px; }
  .live-connect { display: flex; flex-direction: column; gap: 10px; max-width: 420px; }
  @media (pointer: coarse) { .live-layout { grid-template-columns: 1fr; } }
  ```

- [ ] **Step 6: Package gate**
  - `bun run --filter @podium/web typecheck` → exit 0.
  - `bun run --filter @podium/web build` → exit 0 (vite build succeeds; the new section + tRPC client bundle).
  - `bun run lint` → clean for the new files (run `bun run format` first if Biome would reformat).

- [ ] **Step 7: Commit** —
  `git add apps/web/src/LiveSessions.tsx apps/web/src/App.tsx apps/web/src/App.css && git commit -m "feat(web): functional Live multi-session section in the command center"`

---

## Self-review checklist

- **Demonstrates end to end (user's directive):** the Live mode connects a real `SocketHub` + tRPC client, lists live sessions (`sessions.list`/`sessionsChanged`) and discovered conversations (`discovery.scan`), creates/resumes/kills, and attaches a real xterm terminal with the toolbar + take-control. The mock modes are untouched.
- **Reuses proven pieces:** `mountSession` (fit-on-connect, keyboard, takeover) + `mountKeyToolbar` via `toolbarEl` — no reimplementation.
- **e2e-ready:** `window.__podium` exposes `sessions()`/`attach(id)`/`create()` + active-session `state`/`screenText`/`screenHash`/`sendInput`/`takeControl`/`simulateKeyboard` (delegating to the mounted session).
- **Architecture:** `@podium/server` imported type-only (`AppRouter`); tRPC over http, ws via `SocketHub`.
- **Gate is package-scoped;** full workspace green + e2e is Phase 6b.
- **Known:** without `?server=`, the section shows a connect field (default `ws://localhost:8787`); the e2e + `serve.ts` pass `?server=`.
