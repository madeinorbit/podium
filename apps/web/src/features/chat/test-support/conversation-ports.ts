import { omitGone } from '@podium/client-graph/lookup'
import type { ConversationOutbox, ConversationRecords } from '@podium/client-core/conversation'
import type { OutboxChatSend } from '@podium/client-core/engine'
import type { MessageRecordWire, SessionId } from '@podium/model'
import type { MobxPool } from '@podium/client-graph'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { useWorklistPoolProjection } from '@/app/store-worklist-pool'
const pending = (row: unknown): row is symbol => typeof row === 'symbol'

/** Test adapter for the optimistic behavior corpus; production reads model ports. */
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
      const reader = omitGone(pool.row('chatContextReader', 'reader')),
        held = omitGone(pool.row('chatHeld', id))
      const draft =
        initial.current?.id === id ? { text: initial.current.draft } : omitGone(pool.row('chatDraft', id))
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
