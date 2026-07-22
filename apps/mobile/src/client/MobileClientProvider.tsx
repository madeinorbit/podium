/**
 * Mobile binding for the shared client store (arch-v2 P3, issue #192): the
 * hand-rolled useState metadata layer is gone — the Expo app runs the SAME
 * StoreProvider as the web (replica-backed entity reads, outboxed optimistic
 * mutations) over an AsyncStorage-backed replica, so a cold offline start
 * paints from local data and offline writes replay on reconnect.
 *
 * `useMobileClient` keeps its existing shape: it is now a thin adapter over
 * the shared store (mobile-only extras — transcript paging, ask-user answers —
 * ride on the store's hub/trpc). Demo mode (`?demo=1`) stays a static fixture.
 */

import { groupSessions, withoutShells } from '@podium/client-core/focus'
import { type StoreNotices, StoreProvider, useStore } from '@podium/client-core/react'
import {
  createAsyncStorageReplicaStorage,
  createReplica,
  type Replica,
} from '@podium/client-core/replica'
import { createMemoryRouterWindow } from '@podium/client-core/router'
import type { ServerConfig } from '@podium/client-core/transport'
import type {
  ConversationSummaryWire,
  HeadlessActivityEvent,
  IssueWire,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/protocol'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { BootSplash } from '../components/BootSplash'
import {
  DEMO_ISSUES,
  DEMO_SESSIONS,
  DEMO_SUPERAGENT,
  DEMO_TRANSCRIPTS,
  demoEnabled,
} from './demoData'
import { type MobileTrpc, makeMobileTrpc, readServerConfig, type TranscriptPage } from './trpc'

export interface MobileClientValue {
  sessions: SessionMeta[]
  issues: IssueWire[]
  conversations: ConversationSummaryWire[]
  connected: boolean
  cursor: number | null
  error: string | null
  serverConfig: ServerConfig
  trpc: MobileTrpc
  sessionById(sessionId: string): SessionMeta | undefined
  issueById(issueId: string): IssueWire | undefined
  readTranscript(sessionId: string, anchor?: string): Promise<TranscriptPage>
  subscribeTranscript(
    sessionId: string,
    since: string | undefined,
    cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void
  subscribeHeadless(sessionId: string, cb: (e: HeadlessActivityEvent) => void): () => void
  /** Queue a chat message (offline-safe, idempotent; wakes a parked session). */
  sendMessage(sessionId: string, text: string): Promise<void>
  answerQuestion(sessionId: string, choices: { optionIndices: number[] }[]): Promise<void>
  setArchived(sessionId: string, archived: boolean): Promise<void>
  setWorkState(sessionId: string, workState: WorkState | null): Promise<void>
  killSession(sessionId: string): Promise<void>
  continueSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, name: string): Promise<void>
  snooze(sessionId: string, until: string | null): Promise<void>
  clearSnooze(sessionId: string): Promise<void>
  /** Round-robin triage order: needsYou, then idle, then working. */
  focusSessionIds: string[]
  outboxSize: number
}

const MobileClientContext = createContext<MobileClientValue | null>(null)

/** Static fixture client for `?demo=1` — design/screenshot mode, no backend. */
function demoValue(config: ServerConfig): MobileClientValue {
  const sessions = DEMO_SESSIONS
  const groups = groupSessions(withoutShells(sessions))
  const noop = async () => {}
  return {
    sessions,
    issues: DEMO_ISSUES,
    conversations: [],
    connected: true,
    cursor: null,
    error: null,
    serverConfig: config,
    trpc: {
      superagent: {
        listThreads: { query: async () => [] },
        history: { query: async () => DEMO_SUPERAGENT },
        sendTurn: { mutate: async () => ({ threadId: 'global' }) },
        interruptTurn: { mutate: noop },
        clear: { mutate: noop },
      },
      repos: { list: { query: async () => ['/home/dev/src/podium'] } },
    } as unknown as MobileTrpc,
    sessionById: (id) => sessions.find((s) => s.sessionId === id),
    issueById: (id) => DEMO_ISSUES.find((i) => i.id === id),
    readTranscript: async (sessionId) => ({
      items: DEMO_TRANSCRIPTS[sessionId] ?? [],
      hasMore: false,
    }),
    subscribeTranscript: () => () => {},
    subscribeHeadless: () => () => {},
    sendMessage: noop,
    answerQuestion: noop,
    setArchived: noop,
    setWorkState: noop,
    killSession: noop,
    continueSession: noop,
    renameSession: noop,
    snooze: noop,
    clearSnooze: noop,
    focusSessionIds: [...groups.needsYou, ...groups.idle, ...groups.working].map(
      (s) => s.sessionId,
    ),
    outboxSize: 0,
  }
}

export function MobileClientProvider({ children }: { children: ReactNode }) {
  if (demoEnabled()) return <DemoProvider>{children}</DemoProvider>
  return <LiveProvider>{children}</LiveProvider>
}

function DemoProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const value = useMemo(() => demoValue(config), [config])
  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

function LiveProvider({ children }: { children: ReactNode }) {
  const config = useMemo(readServerConfig, [])
  const trpc = useMemo(() => makeMobileTrpc(config.httpOrigin), [config.httpOrigin])
  const [error, setError] = useState<string | null>(null)
  // AsyncStorage is Promise-only; hydrate the replica's synchronous storage
  // bridge before the store boots (offline cold-start paints from it).
  const [replica, setReplica] = useState<Replica | null>(null)
  useEffect(() => {
    let alive = true
    void createAsyncStorageReplicaStorage(AsyncStorage).then((bridge) => {
      if (alive) setReplica(createReplica({ storage: bridge.storage }))
    })
    return () => {
      alive = false
    }
  }, [])
  const routerWindow = useMemo(() => createMemoryRouterWindow(), [])
  const notices = useMemo<StoreNotices>(
    () => ({ error: (message) => setError(message), info: () => {} }),
    [],
  )
  if (!replica) return <BootSplash />
  return (
    <StoreProvider
      config={config}
      api={trpc}
      onFatalError={setError}
      notices={notices}
      createReplicaFn={() => replica}
      routerWindow={routerWindow}
    >
      <LiveBridge config={config} error={error}>
        {children}
      </LiveBridge>
    </StoreProvider>
  )
}

/** Adapts the shared store to the MobileClientValue the screens consume. */
function LiveBridge({
  config,
  error,
  children,
}: {
  config: ServerConfig
  error: string | null
  children: ReactNode
}) {
  const store = useStore<MobileTrpc>()
  const { hub, trpc, replica, sessions, issues, conversations, outboxSize } = store
  const [connected, setConnected] = useState(() => hub.connectionHealth().status !== 'down')
  useEffect(() => hub.onConnectionHealth((health) => setConnected(health.status !== 'down')), [hub])

  const focusSessionIds = useMemo(() => {
    const groups = groupSessions(withoutShells(sessions))
    return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
  }, [sessions])

  const readTranscript = useCallback(
    (sessionId: string, anchor?: string) =>
      trpc.sessions.transcriptRead.query({
        sessionId,
        ...(anchor ? { anchor } : {}),
        direction: 'before',
        limit: 80,
      }),
    [trpc],
  )
  const subscribeTranscript = useCallback(
    (
      sessionId: string,
      since: string | undefined,
      cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
    ) => hub.subscribeTranscript(sessionId, since, cb),
    [hub],
  )
  const subscribeHeadless = useCallback(
    (sessionId: string, cb: (e: HeadlessActivityEvent) => void) =>
      hub.subscribeHeadless(sessionId, cb),
    [hub],
  )
  const sendMessage = useCallback(
    async (sessionId: string, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      // Optimistic + outboxed via the shared store (survives offline reloads).
      await store.resumeAndSend(sessionId, trimmed)
    },
    [store.resumeAndSend],
  )
  const answerQuestion = useCallback(
    async (sessionId: string, choices: { optionIndices: number[] }[]) => {
      await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
    },
    [trpc],
  )

  const value = useMemo<MobileClientValue>(
    () => ({
      sessions,
      issues,
      conversations,
      connected,
      cursor: replica.getCursor(),
      error,
      serverConfig: config,
      trpc,
      sessionById: (sessionId) => sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => issues.find((i) => i.id === issueId),
      focusSessionIds,
      outboxSize,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      // Curation actions come straight from the shared store: optimistic
      // replica apply + outboxed round-trip (mobile gains offline writes).
      setArchived: store.archiveSession,
      setWorkState: store.setWorkState,
      killSession: store.killSession,
      continueSession: store.continueSession,
      renameSession: store.renameSession,
      snooze: store.setSnooze,
      clearSnooze: store.clearSnooze,
    }),
    [
      sessions,
      issues,
      conversations,
      connected,
      replica,
      error,
      config,
      trpc,
      focusSessionIds,
      outboxSize,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      store.archiveSession,
      store.setWorkState,
      store.killSession,
      store.continueSession,
      store.renameSession,
      store.setSnooze,
      store.clearSnooze,
    ],
  )

  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
