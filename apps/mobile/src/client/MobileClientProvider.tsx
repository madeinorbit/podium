import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { ServerConfig } from '@podium/client-core/transport'
import type {
  HeadlessActivityEvent,
  IssueWire,
  SessionMeta,
  TranscriptItem,
  WorkState,
} from '@podium/protocol'
import { SocketHub } from '@podium/terminal-client/connection'
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import {
  DEMO_ISSUES,
  DEMO_SESSIONS,
  DEMO_SUPERAGENT,
  DEMO_TRANSCRIPTS,
  demoEnabled,
} from './demoData'
import { EMPTY_METADATA, type MobileMetadataState } from './metadata'
import { createMobileOutbox } from './outbox'
import { type MobileTrpc, makeMobileTrpc, readServerConfig, type TranscriptPage } from './trpc'

type MobileOutboxKinds = {
  resumeAndSend: { sessionId: string; text: string }
}

export interface MobileClientValue extends MobileMetadataState {
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
  const [metadata, setMetadata] = useState<MobileMetadataState>(EMPTY_METADATA)
  const [outboxSize, setOutboxSize] = useState(0)

  const outbox = useMemo(
    () =>
      createMobileOutbox<MobileOutboxKinds>({
        executors: {
          resumeAndSend: (input) => trpc.sessions.resumeAndSend.mutate(input),
        },
        onPoison: () =>
          setMetadata((prev) => ({
            ...prev,
            error: 'A queued message was rejected by the server.',
          })),
      }),
    [trpc],
  )

  const hub = useMemo(
    () =>
      new SocketHub({
        url: config.wsClientUrl,
        viewport: {
          cols: 80,
          rows: 24,
          dpr: typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1,
        },
        fetchChangesSince: (cursor) => trpc.sync.changesSince.query({ cursor }),
        onMetadataApplied: (state) =>
          setMetadata({
            sessions: state.sessions,
            issues: state.issues,
            conversations: state.conversations,
            connected: true,
            cursor: state.cursor,
            error: null,
          }),
        onError: (message) => setMetadata((prev) => ({ ...prev, error: message })),
      }),
    [config.wsClientUrl, trpc],
  )

  useEffect(() => {
    setOutboxSize(outbox.size())
    const off = outbox.subscribe(setOutboxSize)
    outbox.attach()
    return () => {
      off()
      outbox.dispose()
    }
  }, [outbox])

  useEffect(() => {
    const offSessions = hub.onSessions((sessions) => setMetadata((prev) => ({ ...prev, sessions })))
    const offIssues = hub.onIssues((issues) => setMetadata((prev) => ({ ...prev, issues })))
    const offConversations = hub.onConversations((conversations) =>
      setMetadata((prev) => ({ ...prev, conversations })),
    )
    const offHealth = hub.onConnectionHealth((health) => {
      if (health.status === 'ok') outbox.notifyConnected()
      setMetadata((prev) => ({ ...prev, connected: health.status !== 'down' }))
    })
    hub.connect()
    return () => {
      offSessions()
      offIssues()
      offConversations()
      offHealth()
      hub.dispose()
    }
  }, [hub, outbox])

  const focusSessionIds = useMemo(() => {
    const groups = groupSessions(withoutShells(metadata.sessions))
    return [...groups.needsYou, ...groups.idle, ...groups.working].map((s) => s.sessionId)
  }, [metadata.sessions])

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
      outbox.enqueue('resumeAndSend', { sessionId, text: trimmed })
    },
    [outbox],
  )

  const answerQuestion = useCallback(
    async (sessionId: string, choices: { optionIndices: number[] }[]) => {
      await trpc.sessions.answerAskUserQuestion.mutate({ sessionId, choices })
    },
    [trpc],
  )

  const setArchived = useCallback(
    async (sessionId: string, archived: boolean) => {
      await trpc.sessions.setArchived.mutate({ sessionId, archived })
    },
    [trpc],
  )

  const setWorkState = useCallback(
    async (sessionId: string, workState: WorkState | null) => {
      await trpc.sessions.setWorkState.mutate({ sessionId, workState })
    },
    [trpc],
  )

  const killSession = useCallback(
    async (sessionId: string) => {
      await trpc.sessions.kill.mutate({ sessionId })
    },
    [trpc],
  )

  const continueSession = useCallback(
    async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId })
    },
    [trpc],
  )

  const renameSession = useCallback(
    async (sessionId: string, name: string) => {
      await trpc.sessions.rename.mutate({ sessionId, name })
    },
    [trpc],
  )

  const snooze = useCallback(
    async (sessionId: string, until: string | null) => {
      await trpc.snoozes.set.mutate({ sessionId, until })
    },
    [trpc],
  )

  const clearSnooze = useCallback(
    async (sessionId: string) => {
      await trpc.snoozes.clear.mutate({ sessionId })
    },
    [trpc],
  )

  const value = useMemo<MobileClientValue>(
    () => ({
      ...metadata,
      serverConfig: config,
      trpc,
      sessionById: (sessionId) => metadata.sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => metadata.issues.find((i) => i.id === issueId),
      focusSessionIds,
      outboxSize,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      setArchived,
      setWorkState,
      killSession,
      continueSession,
      renameSession,
      snooze,
      clearSnooze,
    }),
    [
      config,
      trpc,
      focusSessionIds,
      metadata,
      outboxSize,
      readTranscript,
      subscribeTranscript,
      subscribeHeadless,
      sendMessage,
      answerQuestion,
      setArchived,
      setWorkState,
      killSession,
      continueSession,
      renameSession,
      snooze,
      clearSnooze,
    ],
  )

  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
