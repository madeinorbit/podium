import type { SessionId, TranscriptItem, TranscriptTag } from '@podium/model'

export interface ConversationPendingTurn {
  id: string
  deliveryId: string
  text: string
  /** Exact payload delivered to the agent. Retry never reconstructs it from `text`. */
  wire: string
  at: number
  state: 'sending' | 'queued' | 'sent' | 'failed' | 'interrupted'
  kind: 'message' | 'offer'
  error?: string
  tags?: TranscriptTag[]
  toolPaths?: string[]
  files?: readonly { path: string }[]
  acceptsAppendedBrief?: boolean
}

export interface ConversationQueuedMessage {
  id: string
  text: string
  at: number
  injectedAt: number | null
}

export interface ProjectedConversationTurn extends ConversationPendingTurn {
  durable?: ConversationQueuedMessage
}

const QUEUE_CLOCK_SKEW_MS = 5_000
const QUEUE_ACK_WINDOW_MS = 60_000

export function queuedConversationMessages(
  rows: unknown,
  sessionId: SessionId,
): ConversationQueuedMessage[] {
  if (!Array.isArray(rows)) return []
  return rows
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .filter(
      (row) =>
        row.from === 'operator' &&
        row.to === `session:${sessionId}` &&
        row.status === 'queued' &&
        typeof row.id === 'string' &&
        typeof row.body === 'string' &&
        typeof row.createdAt === 'string',
    )
    .map((row) => ({
      id: row.id as string,
      text: row.body as string,
      at: Date.parse(row.createdAt as string) || 0,
      injectedAt: typeof row.injectedAt === 'string' ? Date.parse(row.injectedAt) || null : null,
    }))
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))
}

export function pairPendingWithConversationQueue(
  pending: readonly ConversationPendingTurn[],
  queued: readonly ConversationQueuedMessage[],
): { pending: ProjectedConversationTurn[]; queued: ConversationQueuedMessage[] } {
  const unmatched = [...queued]
  const projected = pending.map((turn): ProjectedConversationTurn => {
    if (turn.state === 'failed' || turn.state === 'interrupted') return turn
    const exact = unmatched.findIndex((message) => message.id === turn.deliveryId)
    if (exact >= 0) {
      const [durable] = unmatched.splice(exact, 1)
      return durable ? { ...turn, durable } : turn
    }
    let best = -1
    let distance = Number.POSITIVE_INFINITY
    for (const [index, message] of unmatched.entries()) {
      if (message.text.trim() !== turn.wire.trim()) continue
      if (message.at < turn.at - QUEUE_CLOCK_SKEW_MS) continue
      if (message.at > turn.at + QUEUE_ACK_WINDOW_MS) continue
      const candidate = Math.abs(message.at - turn.at)
      if (candidate < distance) {
        best = index
        distance = candidate
      }
    }
    if (best < 0) return turn
    const [durable] = unmatched.splice(best, 1)
    return durable ? { ...turn, durable } : turn
  })
  return { pending: projected, queued: unmatched }
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

function textCarriesPaths(text: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return false
  const lines = new Set(text.split('\n').map((line) => line.trim()))
  return paths.every((path) => lines.has(path))
}

export function conversationTurnMatchesItem(
  turn: Pick<ConversationPendingTurn, 'text' | 'wire' | 'toolPaths' | 'acceptsAppendedBrief'>,
  item: TranscriptItem,
): boolean {
  const text = turn.text.trim()
  const itemText = item.text.trim()
  if (
    turn.acceptsAppendedBrief === true &&
    (itemText === text || itemText.startsWith(`${text}\n\n`))
  ) {
    return true
  }
  const paths = turn.toolPaths ?? []
  const itemPaths = item.toolPaths ?? []
  if (paths.length > 0) {
    if (itemPaths.length > 0) return samePaths(paths, itemPaths)
    return textCarriesPaths(item.text, paths)
  }
  if (itemPaths.length > 0) return textCarriesPaths(turn.wire, itemPaths)
  return itemText === text || itemText === turn.wire.trim()
}

export function reconcileConversationPending(
  pending: readonly ConversationPendingTurn[],
  userItems: readonly TranscriptItem[],
  echoMode: 'matching-user' | 'any-user' = 'matching-user',
): ConversationPendingTurn[] {
  if (pending.length === 0 || userItems.length === 0) return pending as ConversationPendingTurn[]
  if (echoMode === 'any-user') return pending.filter((turn) => turn.state === 'interrupted')
  const remaining = [...userItems]
  return pending.filter((turn) => {
    if (turn.state === 'interrupted') return true
    const index = remaining.findIndex((item) => conversationTurnMatchesItem(turn, item))
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
}

export function reconcileConversationQueue(
  queued: readonly ConversationQueuedMessage[],
  userItems: readonly TranscriptItem[],
): ConversationQueuedMessage[] {
  if (queued.length === 0 || userItems.length === 0) return queued as ConversationQueuedMessage[]
  const remaining = [...userItems]
  return queued.filter((message) => {
    const index = remaining.findIndex((item) =>
      conversationTurnMatchesItem({ text: message.text, wire: message.text }, item),
    )
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
}

export function projectConversationQueue(
  pending: readonly ConversationPendingTurn[],
  queued: readonly ConversationQueuedMessage[],
  transcript: readonly TranscriptItem[],
): { pending: ProjectedConversationTurn[]; queued: ConversationQueuedMessage[] } {
  const paired = pairPendingWithConversationQueue(pending, queued)
  const available = transcript.filter((item) => item.role === 'user')
  const pendingVisible = paired.pending.filter((turn) => {
    const index = available.findIndex((item) => {
      const timestamp = item.ts ? Date.parse(item.ts) : Number.NaN
      return (
        Number.isFinite(timestamp) &&
        timestamp >= turn.at - QUEUE_CLOCK_SKEW_MS &&
        conversationTurnMatchesItem(turn, item)
      )
    })
    if (index < 0) return true
    available.splice(index, 1)
    return false
  })
  const queuedVisible = paired.queued.filter((message) => {
    const index = available.findIndex((item) => {
      const timestamp = item.ts ? Date.parse(item.ts) : Number.NaN
      return (
        Number.isFinite(timestamp) &&
        timestamp >= message.at - QUEUE_CLOCK_SKEW_MS &&
        conversationTurnMatchesItem({ text: message.text, wire: message.text }, item)
      )
    })
    if (index < 0) return true
    available.splice(index, 1)
    return false
  })
  return { pending: pendingVisible, queued: queuedVisible }
}
