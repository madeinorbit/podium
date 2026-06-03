import type { ConversationSummaryWire, GitRepositoryWire, SessionMeta } from '@podium/protocol'
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
import { makeTrpc, parseServer, type Trpc } from './trpc'

export interface Store {
  hub: SocketHub
  trpc: Trpc
  repos: GitRepositoryWire[]
  conversations: ConversationSummaryWire[]
  sessions: SessionMeta[]
  selectedWorktree: string | null
  setSelectedWorktree: (path: string | null) => void
  paneA: string | null // sessionId in pane A
  paneB: string | null // sessionId in pane B (null = no split)
  setPane: (pane: 'A' | 'B', sessionId: string | null) => void
  split: boolean
  toggleSplit: () => void
  rescanRepos: () => Promise<void>
  rescanConversations: () => Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function StoreProvider({
  origin,
  children,
}: {
  origin: string
  children: ReactNode
}): JSX.Element {
  const cfg = useMemo(() => parseServer(`?server=${origin}`), [origin])
  if (!cfg) throw new Error(`bad server origin: ${origin}`)

  const hub = useMemo(
    () =>
      new SocketHub({
        url: cfg.wsClientUrl,
        viewport: { cols: 80, rows: 24, dpr: globalThis.devicePixelRatio ?? 1 },
      }),
    [cfg.wsClientUrl],
  )
  const trpc = useMemo(() => makeTrpc(cfg.httpOrigin), [cfg.httpOrigin])

  const [repos, setRepos] = useState<GitRepositoryWire[]>([])
  const [conversations, setConversations] = useState<ConversationSummaryWire[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [selectedWorktree, setSelectedWorktree] = useState<string | null>(null)
  const [paneA, setPaneA] = useState<string | null>(null)
  const [paneB, setPaneB] = useState<string | null>(null)
  const [split, setSplit] = useState(false)
  const started = useRef(false)

  const rescanRepos = useMemo(
    () => async () => {
      const r = await trpc.discovery.scanRepos.mutate().catch(() => null)
      if (r) setRepos(r.repositories)
    },
    [trpc],
  )
  const rescanConversations = useMemo(
    () => async () => {
      const r = await trpc.discovery.scan.mutate().catch(() => null)
      if (r) setConversations(r.conversations)
    },
    [trpc],
  )

  useEffect(() => {
    const off = hub.onSessions(setSessions)
    hub.connect()
    if (!started.current) {
      started.current = true
      void rescanRepos()
      void rescanConversations()
    }
    return () => {
      off()
      hub.dispose()
    }
  }, [hub, rescanRepos, rescanConversations])

  const value: Store = {
    hub,
    trpc,
    repos,
    conversations,
    sessions,
    selectedWorktree,
    setSelectedWorktree,
    paneA,
    paneB,
    setPane: (pane, id) => (pane === 'A' ? setPaneA(id) : setPaneB(id)),
    split,
    toggleSplit: () => setSplit((s) => !s),
    rescanRepos,
    rescanConversations,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}
