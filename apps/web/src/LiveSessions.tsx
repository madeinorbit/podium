import type { ConversationSummaryWire, SessionMeta } from '@podium/protocol'
import { type MountedSession, mountSession, SocketHub } from '@podium/terminal-client'
import { useEffect, useRef, useState } from 'react'
import { makeTrpc, parseServer, type ServerConfig, serverConfig, type Trpc } from './trpc'

type AgentKind = 'claude-code' | 'codex'

export function LiveSessions() {
  // Default to the page origin — the dev host serves the web app and proxies /client + /trpc
  // to the backend on the same port, so we connect with no `?server=` param. An explicit
  // `?server=` (or the override panel below) still points the UI at any other relay.
  const [cfg, setCfg] = useState<ServerConfig>(() => serverConfig(window.location))
  const [showOverride, setShowOverride] = useState(false)
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

  // Connect the hub + tRPC. `cfg` is same-origin by default, or an explicit override.
  useEffect(() => {
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
  }, [cfg])

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

  function applyOverride() {
    const parsed = parseServer(`?server=${originDraft}`)
    if (parsed) {
      setCfg({ ...parsed, override: true })
      setShowOverride(false)
    }
  }

  async function createSession() {
    if (!trpcRef.current) return
    const { sessionId } = await trpcRef.current.sessions.create.mutate({
      agentKind: newKind,
      cwd: newCwd || '.',
    })
    setSelectedId(sessionId)
  }
  async function resume(conv: ConversationSummaryWire) {
    if (!conv.resume || !trpcRef.current) return
    const { sessionId } = await trpcRef.current.sessions.resume.mutate({
      agentKind: conv.agentKind,
      cwd: conv.projectPath ?? '.',
      resume: conv.resume,
      conversationId: conv.id,
      ...(conv.title ? { title: conv.title } : {}),
    })
    setSelectedId(sessionId)
  }
  async function kill(id: string) {
    if (!trpcRef.current) return
    await trpcRef.current.sessions.kill.mutate({ sessionId: id })
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
              <button
                type="button"
                data-session={s.sessionId}
                onClick={() => setSelectedId(s.sessionId)}
              >
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
            <input placeholder="cwd" value={newCwd} onChange={(e) => setNewCwd(e.target.value)} />
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
            <button
              type="button"
              data-action="toggle-relay"
              title={cfg.override ? cfg.wsClientUrl : 'same-origin'}
              onClick={() => setShowOverride((v) => !v)}
            >
              Relay{cfg.override ? ' •' : ''}
            </button>
          </div>
        </div>
        {showOverride && (
          <div className="live-connect compact">
            <label>
              <span>Relay server</span>
              <input value={originDraft} onChange={(e) => setOriginDraft(e.target.value)} />
            </label>
            <button type="button" data-action="apply-relay" onClick={applyOverride}>
              Connect
            </button>
            {cfg.override && (
              <button
                type="button"
                data-action="reset-relay"
                onClick={() => {
                  setCfg(serverConfig(window.location))
                  setShowOverride(false)
                }}
              >
                Use this host
              </button>
            )}
          </div>
        )}
        <div ref={termRef} id="term" className="live-term" />
        <div ref={toolbarRef} id="toolbar" className="live-toolbar" />
      </section>
    </div>
  )
}
