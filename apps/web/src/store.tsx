import type {
  ConversationSummaryWire,
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
  conversations: ConversationSummaryWire[]
  sessions: SessionMeta[]
  /** Latest health sample per daemon host; empty until a daemon reports (or after it drops). */
  hostMetrics: HostMetricsWire[]
  pins: PinState
  setPinned: (kind: PinKind, id: string, pinned: boolean) => Promise<void>
  /** Manual tab order per worktree path (drag-to-reorder). Absent key = no manual order. */
  tabOrders: Record<string, string[]>
  setTabOrder: (worktree: string, sessionIds: string[]) => Promise<void>
  /** Main-area surface: attention board, worktree workspace, or the superagent. */
  view: 'home' | 'workspace' | 'superagent'
  setView: (view: 'home' | 'workspace' | 'superagent') => void
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
  rescanConversations: () => Promise<void>
  killSession: (sessionId: string) => Promise<void>
  /** Nudge an errored agent to retry ("continue⏎" into its PTY). */
  continueSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  hibernateSession: (sessionId: string) => Promise<void>
  resurrectSession: (sessionId: string) => Promise<void>
  archiveSession: (sessionId: string, archived: boolean) => Promise<void>
  setWorkState: (sessionId: string, workState: WorkState | null) => Promise<void>
}

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
  const [conversations, setConversations] = useState<ConversationSummaryWire[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [hostMetrics, setHostMetrics] = useState<HostMetricsWire[]>([])
  const [pins, setPins] = useState<PinState>(EMPTY_PINS)
  const [tabOrders, setTabOrders] = useState<Record<string, string[]>>({})
  const [view, setView] = useState<'home' | 'workspace' | 'superagent'>('home')
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
  const rescanConversations = useMemo(
    () => async () => {
      const r = await trpc.discovery.scan.mutate()
      setConversations(r.conversations)
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
      setSessions((all) => all.map((s) => (s.sessionId === sessionId ? { ...s, archived } : s)))
      await trpc.sessions.setArchived.mutate({ sessionId, archived }).catch(() => {})
    },
    [trpc],
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
    const worktrees = reposToViews(repos).flatMap((repo) => repo.worktrees)
    if (selectedWorktree && worktrees.some((worktree) => worktree.path === selectedWorktree)) {
      return
    }
    setSelectedWorktree(worktrees[0]?.path ?? null)
  }, [repos, selectedWorktree])

  useEffect(() => {
    const offSessions = hub.onSessions(setSessions)
    const offConversations = hub.onConversations(setConversations)
    const offHostMetrics = hub.onHostMetrics(setHostMetrics)
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
      offConversations()
      offHostMetrics()
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
    conversations,
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
    rescanConversations,
    killSession,
    continueSession,
    hibernateSession,
    resurrectSession,
    renameSession,
    archiveSession,
    setWorkState,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
