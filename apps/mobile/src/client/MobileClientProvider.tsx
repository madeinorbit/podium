import { groupSessions, withoutShells } from '@podium/client-core/focus'
import type { IssueWire, SessionMeta, TranscriptItem } from '@podium/protocol'
import type { ServerConfig } from '@podium/client-core/transport'
import { SocketHub } from '@podium/terminal-client/connection'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { EMPTY_METADATA, type MobileMetadataState } from './metadata'
import { createMobileOutbox } from './outbox'
import { makeMobileTrpc, readServerConfig, type TranscriptPage } from './trpc'


type MobileOutboxKinds = {
  resumeAndSend: { sessionId: string; text: string }
}

export interface MobileClientValue extends MobileMetadataState {
  serverConfig: ServerConfig
  sessionById(sessionId: string): SessionMeta | undefined
  issueById(issueId: string): IssueWire | undefined
  readTranscript(sessionId: string): Promise<TranscriptPage>
  subscribeTranscript(
    sessionId: string,
    since: string | undefined,
    cb: (items: TranscriptItem[], meta: { reset: boolean }) => void,
  ): () => void
  sendMessage(sessionId: string, text: string): Promise<void>
  focusSessionIds: string[]
  outboxSize: number
}

const MobileClientContext = createContext<MobileClientValue | null>(null)

export function MobileClientProvider({ children }: { children: ReactNode }) {
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
    (sessionId: string) =>
      trpc.sessions.transcriptRead.query({ sessionId, direction: 'before', limit: 80 }) as Promise<TranscriptPage>,
    [trpc],
  )

  const subscribeTranscript = useCallback(
    (sessionId: string, since: string | undefined, cb: (items: TranscriptItem[], meta: { reset: boolean }) => void) =>
      hub.subscribeTranscript(sessionId, since, cb),
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

  const value = useMemo<MobileClientValue>(
    () => ({
      ...metadata,
      serverConfig: config,
      sessionById: (sessionId) => metadata.sessions.find((s) => s.sessionId === sessionId),
      issueById: (issueId) => metadata.issues.find((i) => i.id === issueId),
      focusSessionIds,
      outboxSize,
      readTranscript,
      subscribeTranscript,
      sendMessage,
    }),
    [config, focusSessionIds, metadata, outboxSize, readTranscript, sendMessage, subscribeTranscript],
  )

  return <MobileClientContext.Provider value={value}>{children}</MobileClientContext.Provider>
}

export function useMobileClient(): MobileClientValue {
  const value = useContext(MobileClientContext)
  if (!value) throw new Error('useMobileClient must be used inside MobileClientProvider')
  return value
}
