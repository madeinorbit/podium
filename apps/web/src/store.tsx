import type {
  ConversationSummaryWire,
  GitDiscoveryDiagnosticWire,
  GitRepositoryWire,
  SessionMeta,
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
import { reposToViews } from './derive'
import { makeTrpc, type ServerOrigin, type Trpc } from './trpc'

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
  const killSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.kill.mutate({ sessionId }).catch(() => {})
      setPaneA((p) => (p === sessionId ? null : p))
      setPaneB((p) => (p === sessionId ? null : p))
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
    const off = hub.onSessions(setSessions)
    const connectTimer = setTimeout(() => {
      try {
        hub.connect()
      } catch (e) {
        onFatalError(formatAppError(e, 'WebSocket connection failed'))
      }
    }, 0)
    if (!started.current) {
      started.current = true
      void Promise.all([refreshRepos(), rescanConversations()]).catch((e) => {
        onFatalError(formatAppError(e, 'Could not load Podium data'))
      })
    }
    return () => {
      clearTimeout(connectTimer)
      off()
      hub.dispose()
    }
  }, [hub, onFatalError, refreshRepos, rescanConversations])

  const value: Store = {
    hub,
    trpc,
    repos,
    reposLoading,
    reposLoaded,
    repoDiagnostics,
    conversations,
    sessions,
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
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
