import type {
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  HostMetricsWire,
  SessionMeta,
  WorkState,
} from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client'
import type { JSX } from 'react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { formatAppError } from './AppErrorPage'
import { EMPTY_PINS, reposToViews } from './derive'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'
import type { PinKind, PinState } from './types'

export interface Store {
  hub: SocketHub
  trpc: Trpc
  repos: GitRepositoryWire[]
  reposLoading: boolean
  /** True once the first repo refresh has resolved — lets the UI distinguish
   *  "still loading" from "registry is genuinely empty" (first-run onboarding). */
  reposLoaded: boolean
  repoDiagnostics: GitDiscoveryDiagnosticWire[]
  sessions: SessionMeta[]
  /** Latest health sample per daemon host; empty until a daemon reports (or after it drops). */
  hostMetrics: HostMetricsWire[]
  pins: PinState
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** Manual tab order per worktree path (drag-to-reorder). Absent key = no manual order. */
  tabOrders: Record<string, string[]>
  setTabOrder: (worktree: string, sessionIds: string[]) => Promise<void>
  /** Main-area surface: attention board, worktree workspace, superagent, or settings. */
  view: MainView
  setView: (view: MainView) => void
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  paneA: string | null // sessionId in pane A
  paneB: string | null // sessionId in pane B (null = no split)
  setPane: (pane: 'A' | 'B', sessionId: string | null) => void
  split: boolean
  toggleSplit: () => void
  /** Enrich the registered repos with branch/worktree metadata (fast — no
   *  filesystem walk). Discovery scanning happens explicitly via the scan flow. */
  refreshRepos: () => Promise<void>
  killSession: (sessionId: string) => Promise<void>
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  hibernateSession: (sessionId: string) => Promise<void>
  resurrectSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  setWorkState: (sessionId: string, workState: WorkState | null) => Promise<void>
  /** Per-session chat composer draft, shared across every view of that session
   *  (chat panes, split view) and preserved across chat/native mode switches.
   *  The native PTY input line is opaque bytes we can't read back, so this is the
   *  one input state we *can* synchronize. */
  drafts: Record<string, string>
  setSessionDraft: (sessionId: string, text: string) => void
}

export type MainView = 'home' | 'workspace' | 'superagent' | 'settings'

const Ctx = createContext<Store | null>(null)

export function StoreProvider({
  config,
  onFatalError,
  children,
}: {
  config: ServerOrigin
  onFatalError: (message: string) => void
  children: ReactNode
}): JSX.Element {
  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
        onError: (message) => onFatalError(message),
      }),
    [config.wsClientUrl, onFatalError],
  )
  const trpc = useMemo(() => makeTrpc(config.httpOrigin), [config.httpOrigin])

  const [repos, setRepos] = useState<GitRepositoryWire[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [reposLoaded, setReposLoaded] = useState(false)
  const [repoDiagnostics, setRepoDiagnostics] = useState<GitDiscoveryDiagnosticWire[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [hostMetrics, setHostMetrics] = useState<HostMetricsWire[]>([])
  const [pins, setPins] = useState<PinState>(EMPTY_PINS)
  const [tabOrders, setTabOrders] = useState<Record<string, string[]>>({})
  const [view, setView] = useState<MainView>('home')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null)
  const [paneA, setPaneA] = useState<string | null>(null)
  const [paneB, setPaneB] = useState<string | null>(null)
  const [split, setSplit] = useState(false)
  const started = useRef(false)

  const refreshRepos = useMemo(
    () => async () => {
      setReposLoading(true)
      try {
        const r = await trpc.discovery.refreshRepos.mutate()
        setRepos(r.repositories)
        setRepoDiagnostics(r.diagnostics)
      } finally {
        setReposLoading(false)
        setReposLoaded(true)
      }
    },
    [trpc],
  )
  const refreshPins = useMemo(
    () => async () => {
      setPins(await trpc.pins.list.query())
    },
    [trpc],
  )
  const setPinned = useMemo(
    () => async (kind: PinKind, id: string, pinned: boolean) => {
      setPins(await trpc.pins.set.mutate({ kind, id, pinned }))
    },
    [trpc],
  )
  const refreshTabOrders = useMemo(
    () => async () => {
      setTabOrders(await trpc.tabs.listOrders.query())
    },
    [trpc],
  )
  // Optimistic: dnd-kit hands back the new order on drop, and waiting on the
  // round-trip would make the tab snap back for a frame. Server result reconciles.
  const setTabOrder = useMemo(
    () => async (worktree: string, sessionIds: string[]) => {
      setTabOrders((orders) => ({ ...orders, [worktree]: sessionIds }))
      setTabOrders(await trpc.tabs.setOrder.mutate({ worktree, sessionIds }))
    },
    [trpc],
  )
  const killSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.kill.mutate({ sessionId }).catch(() => {})
      setPaneA((p) => (p === sessionId ? null : p))
      setPaneB((p) => (p === sessionId ? null : p))
      setPins((p) => ({ ...p, panels: p.panels.filter((id) => id !== sessionId) }))
      setTabOrders((orders) =>
        Object.fromEntries(
          Object.entries(orders).map(([wt, ids]) => [wt, ids.filter((id) => id !== sessionId)]),
        ),
      )
    },
    [trpc],
  )
  const continueSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const hibernateSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.hibernate.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  const resurrectSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.resurrect.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
  // Curation mutations are optimistic: the server broadcast reconciles, but
  // waiting on it makes renames/drags feel sticky.
  const renameSession = useMemo(
    () => async (sessionId: string, name: string) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, name: name.trim() } : s)),
      )
      await trpc.sessions.rename.mutate({ sessionId, name }).catch(() => {})
    },
    [trpc],
  )
  const archiveSession = useMemo(
    () => async (sessionId: string, archived: boolean) => {
      // Archiving "files the work away": it also lands the session in the board's
      // Done lane. Unarchiving only restores it — it doesn't reopen the work state.
      const workState: WorkState | undefined = archived ? 'done' : undefined
      setSessions((all) =>
        all.map((s) =>
          s.sessionId === sessionId ? { ...s, archived, ...(archived ? { workState } : {}) } : s,
        ),
      )
      await trpc.sessions.setArchived.mutate({ sessionId, archived }).catch(() => {})
      if (archived) {
        await trpc.sessions.setWorkState.mutate({ sessionId, workState: 'done' }).catch(() => {})
      }
    },
    [trpc],
  )
  const setSessionDraft = useMemo(
    () => (sessionId: string, text: string) =>
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text })),
    [],
  )
  const setWorkState = useMemo(
    () => async (sessionId: string, workState: WorkState | null) => {
      setSessions((all) =>
        all.map((s) =>
          s.sessionId === sessionId ? { ...s, workState: workState ?? undefined } : s,
        ),
      )
      await trpc.sessions.setWorkState.mutate({ sessionId, workState }).catch(() => {})
    },
    [trpc],
  )

  useEffect(() => {
    if (!selectedWorktree) {
      const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
      setSelectedWorktree(worktrees[0]?.path ?? null)
      return
    }
    const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
    // Keep an explicit selection alive when it's a registered worktree OR when a
    // session is actually running there — a superagent-/CLI-spawned session can
    // sit in a path the web's repo list doesn't know yet, and reverting it to
    // worktrees[0] made "Open" on that session show an unrelated one.
    const known = worktrees.some((w) => w.path === selectedWorktree)
    const hasSession = sessions.some((s) => s.cwd === selectedWorktree)
    if (known || hasSession) return
    setSelectedWorktree(worktrees[0]?.path ?? null)
  }, [repos, selectedWorktree, sessions])

  useEffect(() => {
    const offSessions = hub.onSessions(setSessions)
    const offHostMetrics = hub.onHostMetrics(setHostMetrics)
    // Attention → web notification, but only while this page can't be seen —
    // a visible Podium window IS the notification.
    const offAttention = hub.onAttention((e) => {
      if (document.visibilityState === 'visible') return
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      try {
        new Notification(e.title, { body: e.body, tag: e.sessionId })
      } catch {
        // some webviews throw on construction — never break the app over a toast
      }
    })
    // Presence feeds the server's smart router (skip mobile push while visible).
    const reportVisibility = () => hub.setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', reportVisibility)
    reportVisibility()
    const connectTimer = setTimeout(() => {
      try {
        hub.connect()
      } catch (e) {
        onFatalError(formatAppError(e, 'WebSocket connection failed'))
      }
    }, 0)
    if (!started.current) {
      started.current = true
      void Promise.all([refreshRepos(), refreshPins(), refreshTabOrders()]).catch((e) => {
        onFatalError(formatAppError(e, 'Could not load Podium data'))
      })
    }
    return () => {
      clearTimeout(connectTimer)
      offSessions()
      offHostMetrics()
      offAttention()
      document.removeEventListener('visibilitychange', reportVisibility)
      hub.dispose()
    }
  }, [hub, onFatalError, refreshPins, refreshRepos, refreshTabOrders])

  const value: Store = {
    hub,
    trpc,
    repos,
    reposLoading,
    reposLoaded,
    repoDiagnostics,
    sessions,
    hostMetrics,
    pins,
    setPinned,
    tabOrders,
    setTabOrder,
    view,
    setView,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    paneB,
    setPane: (pane, id) => (pane === 'A' ? setPaneA(id) : setPaneB(id)),
    split,
    toggleSplit: () => setSplit((s) => !s),
    refreshRepos,
    killSession,
    continueSession,
    hibernateSession,
    resurrectSession,
    renameSession,
    archiveSession,
    setWorkState,
    drafts,
    setSessionDraft,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
