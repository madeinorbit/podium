import { sessionPaneView } from '@podium/client-graph/session-pane'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { ChatContextRows } from '@podium/client-graph/chat-context-schema'
import type { SessionExitRows } from '@podium/client-graph/session-exit-schema'
import type { SessionId } from '@podium/model/browser'
import { useCallback, useEffect, useMemo } from 'react'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import type { AtOption } from '@/lib/at-mention/at-mention'
import { issueMentions } from '@/lib/at-mention/mention-sources'

const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const EMPTY_OPTIONS: AtOption[] = []
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_MACHINES: import('@podium/model/browser').MachineWire[] = []
const EMPTY_THREADS: import('@podium/client-core/values').SuperThreadView[] = []
const referenceReader = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader : undefined
}
function useReferencePicker(active = true) {
  const read = useCallback((pool: MobxPool) => active ? referenceReader(pool) : undefined, [active])
  const reader = useWorklistPoolProjection(read, undefined, active)
  return useMemo(() => reader?.referencePicker(), [reader])
}
export function useChatSession(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => sessionPaneView(pool).session(id), [id])
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
const chatMachinesRead = (pool: MobxPool) => sessionPaneView(pool).machines()
export function useChatMachines() {
  return useWorklistPoolProjection(chatMachinesRead, EMPTY_MACHINES)
}
const EMPTY_WINDOW: ChatContextRows['chatWindow'] = {
  attachedSessionId: null,
  transcriptReveal: null,
}
const EMPTY_INTERACTIONS = { blocked: false, question: undefined, pending: 1 }
export function useChatMentions(query: string | null) {
  const picker = useReferencePicker(query !== null)
  useEffect(() => { if (query !== null) picker?.search(query, 5); return () => picker?.close() }, [picker, query])
  const read = useCallback(() => {
    if (!picker || query === null) return EMPTY_OPTIONS
    return picker.issueIds.flatMap(id => {
      const issue = picker.issue(id)
      return issue && !pending(issue) && !issue.deletedAt
        ? issueMentions([issue], '', 1) : []
    })
  }, [picker, query])
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

/** A reference menu owns candidate identities for its mount. Rows ask by id. */
export function useChatReferenceSessionIds() {
  const picker = useReferencePicker()
  useEffect(() => { picker?.open('sessions'); return () => picker?.close() }, [picker])
  const read = useCallback(() => picker?.sessionIds ?? EMPTY_IDS, [picker])
  return useWorklistPoolProjection(read, EMPTY_IDS)
}
const EMPTY_IDS: string[] = []
export function useChatReferenceSession(id: string) {
  const read = useCallback((pool: MobxPool) => {
    const row = pool.row('session', id, 'summary-fields')
    return row && !pending(row) ? row as SessionView : undefined
  }, [id])
  return useWorklistPoolProjection(read, undefined)
}
/** Compatibility for consumers of the catalog answer: capture only on mount.
 * New picker rows use useChatReferenceSessionIds/useChatReferenceSession. */
export function useChatReferenceSessions() {
  const picker = useReferencePicker()
  useEffect(() => { picker?.open('sessions'); return () => picker?.close() }, [picker])
  const read = useCallback(() => picker?.sessions ?? EMPTY_SESSIONS, [picker])
  return useWorklistPoolProjection(read, EMPTY_SESSIONS)
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

/** The private source already scopes row IDs to this principal. A normal
 * session has no thread demand; a selected backend asks for its one row. */
export function useChatThread(id: string | undefined) {
  const read = useCallback((pool: MobxPool) => {
    if (!id) return undefined
    const row = pool.row('superThread', id)
    return row && !pending(row) ? row : undefined
  }, [id])
  return useWorklistPoolProjection(read, undefined)
}
