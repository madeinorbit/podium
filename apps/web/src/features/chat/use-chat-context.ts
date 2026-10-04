import type { ConversationOutbox, ConversationRecords } from '@podium/client-core/conversation'
import type { OutboxChatSend } from '@podium/client-core/engine'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { ChatContextRows } from '@podium/client-graph/chat-context-schema'
import type { SessionExitRows } from '@podium/client-graph/session-exit-schema'
import type { MessageRecordWire } from '@podium/model'
import type { SessionId } from '@podium/model/browser'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { AtOption } from '@/lib/at-mention/at-mention'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import type { UseChatSendOptions } from './use-chat-send'

const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const EMPTY_OPTIONS: AtOption[] = []
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_MACHINES: import('@podium/model/browser').MachineWire[] = []
const EMPTY_THREADS: import('@podium/client-core/values').SuperThreadView[] = []
export function useChatSession(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function useChatSessionExitKind(id: SessionId | undefined) {
  const read = useCallback(
    (pool: MobxPool): SessionExitRows['sessionExit']['kind'] => {
      if (id === undefined) return undefined
      const row = pool.row('sessionExit', id)
      return row && !pending(row) ? row.kind : undefined
    },
    [id],
  )
  return useWorklistPoolProjection(read, undefined)
}
const chatMachinesRead = (pool: MobxPool) => pool.sessionPanes.machines()
export function useChatMachines() {
  return useWorklistPoolProjection(chatMachinesRead, EMPTY_MACHINES)
}
const EMPTY_WINDOW: ChatContextRows['chatWindow'] = {
  attachedSessionId: null,
  transcriptReveal: null,
}
const EMPTY_INTERACTIONS = { blocked: false, question: undefined, pending: 1 }
export function useChatMentions(query: string | null) {
  const read = useCallback(
    (pool: MobxPool) => {
      if (query === null) return EMPTY_OPTIONS
      const reader = pool.row('chatContextReader', 'reader')
      return reader && !pending(reader)
        ? issueMentions(reader.mentions().issues, query, 5)
        : EMPTY_OPTIONS
    },
    [query],
  )
  return useWorklistPoolProjection(read, EMPTY_OPTIONS)
}
export function useChatDraft(id: SessionId) {
  const read = useCallback(
    (pool: MobxPool) => {
      const row = pool.row('chatDraft', id)
      return row && !pending(row) ? row.text : ''
    },
    [id],
  )
  return useWorklistPoolProjection(read, '')
}
const windowRead = (pool: MobxPool) => {
  const row = pool.row('chatWindow', 'window')
  return !row || pending(row) ? EMPTY_WINDOW : row
}
export function useChatContextWindow() {
  return useWorklistPoolProjection(windowRead, EMPTY_WINDOW)
}
export function useChatInteractions(id: SessionId) {
  const read = useCallback(
    (pool: MobxPool) => {
      const reader = pool.row('chatContextReader', 'reader')
      return !reader || pending(reader) ? EMPTY_INTERACTIONS : reader.interactions(id)
    },
    [id],
  )
  return useWorklistPoolProjection(read, EMPTY_INTERACTIONS)
}
export function useChatArtifactIssue(session: Pick<SessionView, 'sessionId' | 'issueId'>) {
  const { issueId, sessionId } = session
  const read = useCallback(
    (pool: MobxPool) => {
      const reader = pool.row('chatContextReader', 'reader')
      const issue =
        reader && !pending(reader) ? reader.artifactIssue({ issueId, sessionId }) : undefined
      return pending(issue) ? undefined : issue
    },
    [issueId, sessionId],
  )
  return useWorklistPoolProjection(read, undefined)
}
export function useChatIssueSeq() {
  const pool = useWorklistPool()
  return useCallback(
    (id: string) => {
      const reader = pool?.row('chatContextReader', 'reader')
      const row = reader && !pending(reader) ? reader.issue(id) : undefined
      return row && !pending(row) ? row.seq : null
    },
    [pool],
  )
}

type Ports = {
  records: ConversationRecords
  outbox: ConversationOutbox
  ready: boolean
  draft: string
  held: (id: SessionId) => readonly OutboxChatSend[]
}
const EMPTY_INPUT = {
  records: [] as readonly MessageRecordWire[],
  sends: [] as readonly OutboxChatSend[],
  ready: false,
  draft: '',
}
export function useChatConversationPorts(
  id: SessionId,
): Ports {
  const initial = useRef<{ id: string; draft: string } | undefined>(undefined)
  const read = useCallback(
    (pool: MobxPool) => {
      const reader = pool.row('chatContextReader', 'reader'),
        held = pool.row('chatHeld', id)
      const draft =
        initial.current?.id === id ? { text: initial.current.draft } : pool.row('chatDraft', id)
      if (!reader || pending(reader) || !held || pending(held) || !draft || pending(draft))
        return EMPTY_INPUT
      const records = reader.records(id)
      return {
        records: records.records,
        sends: held.sends,
        draft: draft.text,
        ready: records.pending === 0,
      }
    },
    [id],
  )
  const data = useWorklistPoolProjection(read, EMPTY_INPUT)
  if (data.ready && initial.current?.id !== id) initial.current = { id, draft: data.draft }
  // biome-ignore lint/correctness/useExhaustiveDependencies: One bridge per addressed conversation; layout updates its borrowed rows without replacing listener ownership.
  const bridge = useMemo(() => {
    let records: readonly MessageRecordWire[] = data.records,
      sends = data.sends
    const recordListeners = new Set<() => void>(),
      heldListeners = new Set<() => void>()
    return {
      records: {
        getSnapshot: () => records,
        subscribe: (fn: () => void) => {
          recordListeners.add(fn)
          return () => {
            recordListeners.delete(fn)
          }
        },
      },
      outbox: {
        held: () => sends,
        subscribe: (fn: () => void) => {
          heldListeners.add(fn)
          return () => {
            heldListeners.delete(fn)
          }
        },
      },
      update(next: typeof data) {
        if (records !== next.records) {
          records = next.records
          for (const fn of recordListeners) fn()
        }
        if (sends !== next.sends) {
          sends = next.sends
          for (const fn of heldListeners) fn()
        }
      },
    }
  }, [id])
  useLayoutEffect(() => bridge.update(data), [bridge, data])
  // Initial restoration can recreate the controller once. Later row demand
  // must not reset its draft, optimistic turns or interruption state.
  return {
    records: bridge.records,
    outbox: bridge.outbox,
    ready: initial.current?.id === id,
    draft: data.draft,
    held: () => data.sends,
  }
}
const sessionRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.sessions().sessions : EMPTY_SESSIONS
}
export function useChatReferenceSessions() {
  return useWorklistPoolProjection(sessionRead, EMPTY_SESSIONS)
}
const machineRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.machines() : EMPTY_MACHINES
}
export function useChatReferenceMachines() {
  return useWorklistPoolProjection(machineRead, EMPTY_MACHINES)
}
const repoRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.repositoryKey() : ''
}
export function useChatRepositoryKey() {
  return useWorklistPoolProjection(repoRead, '')
}
const threadRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.threads().threads : EMPTY_THREADS
}
export function useChatThreads() {
  return useWorklistPoolProjection(threadRead, EMPTY_THREADS)
}
