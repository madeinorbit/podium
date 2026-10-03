import type { ConversationOutbox, ConversationRecords } from '@podium/client-core/conversation'
import { storeConversationOutbox, storeConversationRecords } from '@podium/client-core/conversation'
import type { OutboxChatSend } from '@podium/client-core/engine'
import { recordSliceDerivation } from '@podium/client-core/perf'
import { useStoreHandle } from '@podium/client-core/react'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { MobileSessionRows } from '@podium/client-graph/mobile-session-schema'
import type { MachineWire, MessageRecordWire, SessionId } from '@podium/model'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { demoEnabled } from './demoData'
import {
  useBooting,
  useIssue,
  useIssues,
  useMachines,
  useReplica,
  useSession,
  useSessionDraft,
  useSessions,
  useSpawnPending,
  useSpawnPrompt,
  useStoreSelector,
} from './hooks'
import { mobileDataLayer, useMobilePoolProjection } from './mobile-pool'
import type { MobileTrpc } from './trpc'

type Reader = MobileSessionRows['mobileSessionReader']
const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_ISSUES: IssueViewModel[] = []
const EMPTY_MACHINES: MachineWire[] = []

/** The switch belongs to the app root and never changes during an app load.
 * Each pool projection owns one memoized reader, including while attaching. */
function useRead<T>(read: (reader: Reader) => T, empty: T): T {
  const project = useCallback(
    (pool: MobxPool) => {
      const reader = pool.row('mobileSessionReader', 'reader')
      return reader && !pending(reader) ? read(reader) : empty
    },
    [read, empty],
  )
  return useMobilePoolProjection(project, empty)
}
function useLegacyRead() {
  useStoreSelector((s) => {
    recordSliceDerivation(s.replica, 'mobileSession.context')
    return 0
  })
}
function useLegacySession(id: SessionId | undefined) {
  useLegacyRead()
  return useSession(id)
}
function usePoolSession(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.session(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextSession(id: SessionId | undefined) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolSession : useLegacySession
  return useRead(id)
}
function useLegacyIssue(id: string | undefined) {
  useLegacyRead()
  return useIssue(id)
}
function usePoolIssue(id: string | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.issue(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextIssue(id: string | undefined) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolIssue : useLegacyIssue
  return useRead(id)
}
function useLegacySessions() {
  useLegacyRead()
  return useSessions()
}
const sessionsRead = (reader: Reader) => reader.sessions().sessions
function usePoolSessions() {
  return useRead(sessionsRead, EMPTY_SESSIONS)
}
export function useSessionContextSessions() {
  const useRead = mobileDataLayer() === 'pool' ? usePoolSessions : useLegacySessions
  return useRead()
}
function useLegacyIssues() {
  useLegacyRead()
  return useIssues()
}
const issuesRead = (reader: Reader) => reader.issues().issues
function usePoolIssues() {
  return useRead(issuesRead, EMPTY_ISSUES)
}
export function useSessionContextIssues() {
  const useRead = mobileDataLayer() === 'pool' ? usePoolIssues : useLegacyIssues
  return useRead()
}
function useLegacyMachines() {
  useLegacyRead()
  return useMachines()
}
const machinesRead = (reader: Reader) => reader.machines()
function usePoolMachines() {
  return useRead(machinesRead, EMPTY_MACHINES)
}
export function useSessionContextMachines() {
  const useRead = mobileDataLayer() === 'pool' ? usePoolMachines : useLegacyMachines
  return useRead()
}
function useLegacySpawnPending(id: SessionId | undefined) {
  useLegacyRead()
  return useSpawnPending(id)
}
function usePoolSpawnPending(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.spawnPending(id)
      return pending(row) || row === true
    },
    [id],
  )
  // A terminal cannot spend its attach before the existing pool is ready.
  return useRead(read, id !== undefined)
}
export function useSessionContextSpawnPending(id: SessionId | undefined) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolSpawnPending : useLegacySpawnPending
  return useRead(id)
}
function useLegacySpawnPrompt(id: SessionId | undefined) {
  useLegacyRead()
  return useSpawnPrompt(id)
}
function usePoolSpawnPrompt(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.spawnPrompt(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextSpawnPrompt(id: SessionId | undefined) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolSpawnPrompt : useLegacySpawnPrompt
  return useRead(id)
}
function useLegacyExit(id: SessionId | undefined) {
  useLegacyRead()
  const replica = useReplica()
  return id ? replica.exitKind?.('session', id) : undefined
}
function usePoolExit(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.exit(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextExit(id: SessionId | undefined) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolExit : useLegacyExit
  return useRead(id)
}
function useLegacyBooting() {
  useLegacyRead()
  return useBooting()
}
const bootingRead = (reader: Reader) => (demoEnabled() ? false : reader.booting())
function usePoolBooting() {
  return useRead(bootingRead, !demoEnabled())
}
export function useSessionContextBooting() {
  const useRead = mobileDataLayer() === 'pool' ? usePoolBooting : useLegacyBooting
  return useRead()
}
function useLegacyDraft(id: SessionId) {
  useLegacyRead()
  return useSessionDraft(id)
}
function usePoolDraft(id: SessionId) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.draft(id)
      return pending(row) ? '' : row
    },
    [id],
  )
  return useRead(read, '')
}
export function useSessionContextDraft(id: SessionId) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolDraft : useLegacyDraft
  return useRead(id)
}
function useLegacyQuestion(id: SessionId) {
  useLegacyRead()
  return useStoreSelector((s) =>
    (s.pendingInteractions ?? []).find(
      (row) => row.sessionId === id && row.kind === 'question' && row.status === 'asked',
    ),
  )
}
function usePoolQuestion(id: SessionId) {
  const read = useCallback((reader: Reader) => reader.question(id).question, [id])
  return useRead(read, undefined)
}
export function useSessionContextQuestion(id: SessionId) {
  const useRead = mobileDataLayer() === 'pool' ? usePoolQuestion : useLegacyQuestion
  return useRead(id)
}

type Ports = {
  records: ConversationRecords
  outbox: ConversationOutbox
  ready: boolean
  draft: string
}
function useLegacyPorts(id: SessionId): Ports {
  const owner = useStoreHandle<MobileTrpc>()
  return useMemo(() => {
    // Count the adapter's subscriber selectors too: replacing only its
    // getSnapshot facade would leave the legacy store subscription invisible.
    const source = {
      getSnapshot: () => {
        recordSliceDerivation(owner, 'mobileSession.ports')
        return owner.getSnapshot()
      },
      subscribe: (fn: () => void) => owner.subscribe(fn),
    }
    return {
      records: storeConversationRecords(source, id),
      outbox: storeConversationOutbox(source, id),
      ready: true,
      draft: source.getSnapshot().drafts[id] ?? '',
    }
  }, [owner, id])
}
const EMPTY_INPUT = {
  records: [] as readonly MessageRecordWire[],
  sends: [] as readonly OutboxChatSend[],
  ready: false,
  draft: '',
}
function usePoolPorts(id: SessionId): Ports {
  const read = useCallback((reader: Reader) => reader.conversation(id), [id])
  const data = useRead(read, EMPTY_INPUT)
  const initial = useRef<{ id: string; draft: string } | undefined>(undefined)
  if (data.ready && initial.current?.id !== id) initial.current = { id, draft: data.draft }
  // One bridge per conversation. Late attachment restores the seed once;
  // subsequent records/outbox demand never replaces the live controller.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the bridge owns its listeners per addressed conversation
  const bridge = useMemo(() => {
    let records = data.records,
      sends = data.sends
    const recordListeners = new Set<() => void>(),
      outboxListeners = new Set<() => void>()
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
          outboxListeners.add(fn)
          return () => {
            outboxListeners.delete(fn)
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
          for (const fn of outboxListeners) fn()
        }
      },
    }
  }, [id])
  useLayoutEffect(() => bridge.update(data), [bridge, data])
  return {
    records: bridge.records,
    outbox: bridge.outbox,
    ready: initial.current?.id === id,
    draft: initial.current?.id === id ? initial.current.draft : '',
  }
}
export function useSessionConversationPorts(id: SessionId): Ports {
  const useRead = mobileDataLayer() === 'pool' ? usePoolPorts : useLegacyPorts
  return useRead(id)
}
