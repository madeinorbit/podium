import type { MobxPool } from '@podium/client-graph'
import type { ChatContextRows } from '@podium/client-graph/chat-context-schema'
import type { ConversationRecords, ConversationOutbox } from '@podium/client-core/conversation'
import { storeConversationRecords, storeConversationOutbox } from '@podium/client-core/conversation'
import { recordSliceDerivation } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { SessionView } from '@podium/client-core/session-values'
import type { MessageRecordWire, SessionId } from '@podium/model/browser'
import type { OutboxChatSend } from '@podium/client-core/engine/chat-send'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { shallowEqual } from '@podium/client-core/store'
import { useReplicaIssues, useSessionDraft, useStoreSelector } from '@/app/store'
import { useWorklistPool, useWorklistPoolProjection } from '@/app/store-worklist-pool'
import { issueMentions } from '@/lib/at-mention/mention-sources'
import { chatContextDataLayer } from './chat-context-data-layer'
import type { UseChatSendOptions } from './use-chat-send'
import type { AtOption } from '@/lib/at-mention/at-mention'
import { usePaneSession, usePaneMachines } from '../terminal/use-session-pane-inputs'

const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const EMPTY_OPTIONS: AtOption[] = []
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_MACHINES: import('@podium/model/browser').MachineWire[] = []
const EMPTY_THREADS: import('@podium/client-core/viewmodels').SuperThreadView[] = []
function usePoolChatSession(id: SessionId | undefined) {
  const read = useCallback((pool: MobxPool) => pool.sessionPanes.session(id), [id])
  return useWorklistPoolProjection(read, undefined)
}
export function useChatSession(id: SessionId | undefined) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolChatSession : usePaneSession
  return useRead(id)
}
const chatMachinesRead = (pool: MobxPool) => pool.sessionPanes.machines()
function usePoolChatMachines() { return useWorklistPoolProjection(chatMachinesRead, EMPTY_MACHINES) }
export function useChatMachines() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolChatMachines : usePaneMachines
  return useRead()
}
const EMPTY_WINDOW: ChatContextRows['chatWindow'] = { attachedSessionId: null, transcriptReveal: null }
const EMPTY_INTERACTIONS = { blocked: false, question: undefined, pending: 1 }
export function legacyChatRead<T>(owner: object, name: string, read: () => T): T {
  recordSliceDerivation(owner, `chatContext.${name}`)
  return read()
}
function useLegacyMentions(query: string | null) {
  const issues = useReplicaIssues()
  useStoreSelector(s => legacyChatRead(s.replica ?? s, 'mentions', () => 0))
  return useMemo(() => query === null ? [] : issueMentions(issues, query, 5), [issues, query])
}
function usePoolMentions(query: string | null) {
  const read = useCallback((pool: MobxPool) => {
    if (query === null) return EMPTY_OPTIONS
    const reader = pool.row('chatContextReader', 'reader')
    return reader && !pending(reader) ? issueMentions(reader.mentions().issues, query, 5) : EMPTY_OPTIONS
  }, [query])
  return useWorklistPoolProjection(read, EMPTY_OPTIONS)
}
export function useChatMentions(query: string | null) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolMentions : useLegacyMentions
  return useRead(query)
}
function useLegacyDraft(id: SessionId) {
  useStoreSelector(s => legacyChatRead(s.replica ?? s, 'draft', () => 0))
  return useSessionDraft(id)
}
function usePoolDraft(id: SessionId) {
  const read = useCallback((pool: MobxPool) => {
    const row = pool.row('chatDraft', id)
    return row && !pending(row) ? row.text : ''
  }, [id])
  return useWorklistPoolProjection(read, '')
}
export function useChatDraft(id: SessionId) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolDraft : useLegacyDraft
  return useRead(id)
}
function useLegacyWindow() {
  return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'window', () => ({ attachedSessionId: s.attachedSessionId, transcriptReveal: s.transcriptReveal })), shallowEqual)
}
const windowRead = (pool: MobxPool) => {
  const row = pool.row('chatWindow', 'window')
  return !row || pending(row) ? EMPTY_WINDOW : row
}
function usePoolWindow() { return useWorklistPoolProjection(windowRead, EMPTY_WINDOW) }
export function useChatContextWindow() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolWindow : useLegacyWindow
  return useRead()
}
function useLegacyInteractions(id: SessionId) {
  return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'interactions', () => {
    const rows = (s.pendingInteractions ?? []).filter(row => row.sessionId === id && row.status === 'asked')
    return { blocked: rows.length > 0, question: rows.find(row => row.kind === 'question'), pending: 0 }
  }), shallowEqual)
}
function usePoolInteractions(id: SessionId) {
  const read = useCallback((pool: MobxPool) => {
    const reader = pool.row('chatContextReader', 'reader')
    return !reader || pending(reader) ? EMPTY_INTERACTIONS : reader.interactions(id)
  }, [id])
  return useWorklistPoolProjection(read, EMPTY_INTERACTIONS)
}
export function useChatInteractions(id: SessionId) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolInteractions : useLegacyInteractions
  return useRead(id)
}
function useLegacyArtifactIssue(session: Pick<SessionView, 'sessionId' | 'issueId'>) {
  const issues = useReplicaIssues()
  useStoreSelector(s => legacyChatRead(s.replica ?? s, 'artifacts', () => 0))
  return issues.find(i => i.id === session.issueId) ?? issues.find(i => i.memberSessionIds?.includes(session.sessionId))
}
function usePoolArtifactIssue(session: Pick<SessionView, 'sessionId' | 'issueId'>) {
  const read = useCallback((pool: MobxPool) => {
    const reader = pool.row('chatContextReader', 'reader')
    const issue = reader && !pending(reader) ? reader.artifactIssue(session) : undefined
    return pending(issue) ? undefined : issue
  }, [session.issueId, session.sessionId])
  return useWorklistPoolProjection(read, undefined)
}
export function useChatArtifactIssue(session: Pick<SessionView, 'sessionId' | 'issueId'>) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolArtifactIssue : useLegacyArtifactIssue
  return useRead(session)
}
function useLegacyIssueSeq() {
  const owner = useStoreHandle()
  return useCallback((id: string) => legacyChatRead(owner, 'issueSeq', () => owner.getSnapshot().issueProjections?.find(row => row.id === id)?.seq ?? null), [owner])
}
function usePoolIssueSeq() {
  const pool = useWorklistPool()
  return useCallback((id: string) => {
    const reader = pool?.row('chatContextReader', 'reader')
    const row = reader && !pending(reader) ? reader.issue(id) : undefined
    return row && !pending(row) ? row.seq : null
  }, [pool])
}
export function useChatIssueSeq() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolIssueSeq : useLegacyIssueSeq
  return useRead()
}

type Ports = { records: ConversationRecords; outbox: ConversationOutbox; ready: boolean; draft: string; held: (id: SessionId) => readonly OutboxChatSend[] }
function useLegacyPorts(id: SessionId, store: UseChatSendOptions['store']): Ports {
  return useMemo(() => {
    const records = storeConversationRecords(store, id), outbox = storeConversationOutbox(store, id)
    return {
      records: { getSnapshot: () => legacyChatRead(store, 'records', records.getSnapshot), subscribe: records.subscribe },
      outbox: { held: () => legacyChatRead(store, 'outbox', outbox.held), subscribe: outbox.subscribe },
      draft: legacyChatRead(store, 'draftSeed', () => (store.getSnapshot() as { drafts?: Record<string, string> }).drafts?.[id] ?? ''), ready: true,
      held: () => legacyChatRead(store, 'held', outbox.held),
    }
  }, [id, store])
}
const EMPTY_INPUT = { records: [] as readonly MessageRecordWire[], sends: [] as readonly OutboxChatSend[], ready: false, draft: '' }
function usePoolPorts(id: SessionId, _store: UseChatSendOptions['store']): Ports {
  const initial = useRef<{ id: string; draft: string } | undefined>(undefined)
  const read = useCallback((pool: MobxPool) => {
    const reader = pool.row('chatContextReader', 'reader'), held = pool.row('chatHeld', id)
    const draft = initial.current?.id === id ? { text: initial.current.draft } : pool.row('chatDraft', id)
    if (!reader || pending(reader) || !held || pending(held) || !draft || pending(draft)) return EMPTY_INPUT
    const records = reader.records(id)
    return { records: records.records, sends: held.sends, draft: draft.text, ready: records.pending === 0 }
  }, [id])
  const data = useWorklistPoolProjection(read, EMPTY_INPUT)
  if (data.ready && initial.current?.id !== id) initial.current = { id, draft: data.draft }
  const bridge = useMemo(() => {
    let records: readonly MessageRecordWire[] = data.records, sends = data.sends
    const recordListeners = new Set<() => void>(), heldListeners = new Set<() => void>()
    return {
      records: { getSnapshot: () => records, subscribe: (fn: () => void) => { recordListeners.add(fn); return () => { recordListeners.delete(fn) } } },
      outbox: { held: () => sends, subscribe: (fn: () => void) => { heldListeners.add(fn); return () => { heldListeners.delete(fn) } } },
      update(next: typeof data) {
        if (records !== next.records) { records = next.records; for (const fn of recordListeners) fn() }
        if (sends !== next.sends) { sends = next.sends; for (const fn of heldListeners) fn() }
      },
    }
  }, [id])
  useLayoutEffect(() => bridge.update(data), [bridge, data])
  // Initial restoration can recreate the controller once. Later row demand
  // must not reset its draft, optimistic turns or interruption state.
  return { records: bridge.records, outbox: bridge.outbox, ready: initial.current?.id === id, draft: data.draft, held: () => data.sends }
}
export function useChatConversationPorts(id: SessionId, store: UseChatSendOptions['store']) {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolPorts : useLegacyPorts
  return useRead(id, store)
}

function useLegacyReferenceSessions() { return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'referenceSessions', () => s.sessions)) }
const sessionRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.sessions().sessions : EMPTY_SESSIONS
}
function usePoolReferenceSessions() { return useWorklistPoolProjection(sessionRead, EMPTY_SESSIONS) }
export function useChatReferenceSessions() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolReferenceSessions : useLegacyReferenceSessions
  return useRead()
}
function useLegacyReferenceMachines() { return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'referenceMachines', () => s.machines)) }
const machineRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.machines() : EMPTY_MACHINES
}
function usePoolReferenceMachines() { return useWorklistPoolProjection(machineRead, EMPTY_MACHINES) }
export function useChatReferenceMachines() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolReferenceMachines : useLegacyReferenceMachines
  return useRead()
}
function useLegacyRepoKey() { return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'referenceRepos', () => s.repos.map(row => row.path).sort().join('\n'))) }
const repoRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.repositoryKey() : ''
}
function usePoolRepoKey() { return useWorklistPoolProjection(repoRead, '') }
export function useChatRepositoryKey() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolRepoKey : useLegacyRepoKey
  return useRead()
}

function useLegacyThreads() { return useStoreSelector(s => legacyChatRead(s.replica ?? s, 'threads', () => s.superThreads)) }
const threadRead = (pool: MobxPool) => {
  const reader = pool.row('chatContextReader', 'reader')
  return reader && !pending(reader) ? reader.threads().threads : EMPTY_THREADS
}
function usePoolThreads() { return useWorklistPoolProjection(threadRead, EMPTY_THREADS) }
export function useChatThreads() {
  const useRead = chatContextDataLayer() === 'pool' ? usePoolThreads : useLegacyThreads
  return useRead()
}
