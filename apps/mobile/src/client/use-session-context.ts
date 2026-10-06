import type { ConversationOutbox, ConversationRecords } from '@podium/client-core/conversation'
import type { OutboxChatSend } from '@podium/client-core/engine'
import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import type { MobxPool } from '@podium/client-graph'
import type { MobileSessionRows } from '@podium/client-graph/mobile-session-schema'
import type { MachineWire, MessageRecordWire, SessionId } from '@podium/model'
import { asSessionId } from '@podium/model'
import { reaction } from 'mobx'
import { useCallback, useLayoutEffect, useMemo } from 'react'
import { demoEnabled } from './demoData'
import { useMobilePoolProjection } from './mobile-pool'

type Reader = MobileSessionRows['mobileSessionReader']
const pending = (row: unknown): row is symbol => typeof row === 'symbol'
const EMPTY_SESSIONS: SessionView[] = []
const EMPTY_ISSUES: IssueViewModel[] = []

/** Each pool projection owns one memoized reader, including while attaching. */
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
export function useSessionContextSession(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.session(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextIssue(id: string | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.issue(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
/** Session chrome does not need the full issue page's seat/dependency projection. */
export function useSessionContextChromeIssue(id: string | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.chromeIssue(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
/** Only a visible delete confirmation needs the addressed task's seat count. */
export function useSessionContextIssueAgentCount(id: string | undefined, active: boolean) {
  const read = useCallback(
    (reader: Reader) => {
      if (!active) return 0
      const count = reader.issueAgentCount(id)
      return pending(count) ? undefined : (count ?? 0)
    },
    [id, active],
  )
  return useRead<number | undefined>(read, undefined)
}
/** Next is an action-time scalar question; a closed menu retains no triage demand. */
const nextSessionRead = (reader: Reader) => reader.nextSession
export function useSessionContextNextSession() {
  const nextSession = useRead<Reader['nextSession'] | undefined>(nextSessionRead, undefined)
  return useCallback(
    (id: SessionId): SessionId | undefined => {
      const next = nextSession?.(id)
      return next === undefined ? undefined : asSessionId(next)
    },
    [nextSession],
  )
}
/** A clicked transcript reference uses the existing identity reader/load
 * window. Undefined stays loading; null is a resolved missing reference. */
export function useSessionContextReferenceIssue(ref: string | undefined) {
  const read = useCallback(
    (pool: MobxPool): IssueViewModel | null | undefined => {
      if (ref === undefined) return undefined
      const reader = pool.row('mobileSessionReader', 'reader')
      if (!reader || pending(reader)) return undefined
      const id = pool.queries.linkedIssueId(ref)
      if (id === undefined) return null
      const row = reader.issue(id)
      return pending(row) ? undefined : (row ?? null)
    },
    [ref],
  )
  return useMobilePoolProjection(read, undefined)
}
const sessionsRead = (reader: Reader) => reader.sessions().sessions
export function useSessionContextSessions(active = true) {
  const read = useCallback(
    (reader: Reader) => (active ? sessionsRead(reader) : EMPTY_SESSIONS),
    [active],
  )
  return useRead(read, EMPTY_SESSIONS)
}
const issuesRead = (reader: Reader) => reader.issues().issues
export function useSessionContextIssues(active = true) {
  const read = useCallback(
    (reader: Reader) => (active ? issuesRead(reader) : EMPTY_ISSUES),
    [active],
  )
  return useRead(read, EMPTY_ISSUES)
}
export function useSessionContextMachine(id: string | undefined): MachineWire | undefined {
  const read = useCallback((reader: Reader) => reader.machine(id), [id])
  return useRead(read, undefined)
}
/** Replicated machine display name for the offline banner (POD-5661):
 * undefined without a feed companion, so the banner falls back. */
export function useSessionContextMachineHome(id: string | undefined): string | undefined {
  const read = useCallback((reader: Reader) => reader.machineHome(id), [id])
  return useRead(read, undefined)
}
export function useSessionContextSpawnPending(id: SessionId | undefined) {
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
export function useSessionContextSpawnPrompt(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.spawnPrompt(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
export function useSessionContextExit(id: SessionId | undefined) {
  const read = useCallback(
    (reader: Reader) => {
      const row = reader.exit(id)
      return pending(row) ? undefined : row
    },
    [id],
  )
  return useRead(read, undefined)
}
const bootingRead = (reader: Reader) => (demoEnabled() ? false : reader.booting())
export function useSessionContextBooting() {
  return useRead(bootingRead, !demoEnabled())
}
export function useSessionContextQuestion(id: SessionId) {
  const read = useCallback((reader: Reader) => reader.question(id).question, [id])
  return useRead(read, undefined)
}

type Ports = {
  records: ConversationRecords
  outbox: ConversationOutbox
  ready: boolean
}
const EMPTY_PORTS_INPUT = {
  records: [] as readonly MessageRecordWire[],
  sends: [] as readonly OutboxChatSend[],
  ready: false,
}
export function useSessionConversationPorts(id: SessionId): Ports {
  const read = useCallback((reader: Reader) => reader.conversationPorts(id), [id])
  const data = useRead(read, EMPTY_PORTS_INPUT)
  // One bridge per conversation. Late attachment restores the seed once;
  // subsequent records/outbox demand never replaces the live Conversation.
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
    ready: data.ready,
  }
}

/** These subscriptions outlive a screen while its Conversation is warm. */
export function mobileConversationPorts(
  pool: MobxPool,
  id: SessionId,
): Pick<Ports, 'records' | 'outbox'> {
  const read = () => {
    const reader = pool.row('mobileSessionReader', 'reader')
    return reader && !pending(reader) ? reader.conversationPorts(id) : EMPTY_PORTS_INPUT
  }
  return {
    records: {
      getSnapshot: () => read().records,
      subscribe: (listener) => reaction(() => read().records, listener),
    },
    outbox: {
      held: () => read().sends,
      subscribe: (listener) => reaction(() => read().sends, listener),
    },
  }
}
