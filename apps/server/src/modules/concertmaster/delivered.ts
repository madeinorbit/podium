/**
 * A PERSON'S DELIVERED MESSAGE JOINS THE CONCERTMASTER'S CONVERSATION (POD-7211).
 *
 * The curated chat shows the person's own messages beside the agent's. They
 * are chat messages like any other (the `messages` table and its delivery
 * ledger), so the conversation records one once it is CONFIRMED: the agent has
 * it. A message still on its way, a retracted one or one that failed is the
 * chat's own bubble, never an entry.
 *
 * AFTER THE COMMIT, ON ITS OWN UNIT. The messages repository announces the rows
 * each committed write changed; this watches for a confirmed message to a
 * session and hands it to the service, which decides whether that session is a
 * Concertmaster. Nothing here runs inside a delivery's transaction, so nothing
 * here can fail or slow a delivery. With the feature off it does nothing, and
 * reads nothing.
 */

import { createLogger, describeError } from '@podium/logger'
import { asSessionId, type SessionId } from '@podium/model'
import type { CommittedRowChange } from '../../store/committed-rows'
import type { MessageQueueFact } from '../../store/messages'

const log = createLogger('server:concertmaster')

export interface DeliveredMessageWatchDeps {
  enabled(): boolean
  subscribe(listener: (change: CommittedRowChange<MessageQueueFact>) => void): () => void
  /** Record one confirmed message; runs as a server write of its own. */
  record(sessionId: SessionId, messageId: string): Promise<unknown>
}

export class DeliveredMessageWatch {
  private readonly unsubscribe: () => void
  private readonly running = new Set<Promise<void>>()

  constructor(private readonly deps: DeliveredMessageWatchDeps) {
    this.unsubscribe = deps.subscribe((change) => this.onCommitted(change))
  }

  private onCommitted(change: CommittedRowChange<MessageQueueFact>): void {
    if (change.operation !== 'upsert' || !this.deps.enabled()) return
    for (const row of change.rows) {
      if (row.toKind !== 'session' || row.toId === null || row.deliveryStatus !== 'confirmed') {
        continue
      }
      const run = this.record(asSessionId(row.toId), row.id)
      this.running.add(run)
      void run.finally(() => this.running.delete(run))
    }
  }

  private async record(sessionId: SessionId, messageId: string): Promise<void> {
    try {
      await this.deps.record(sessionId, messageId)
    } catch (err) {
      // One message missing from a curated chat; the agent has it either way.
      log.warn('a delivered message was not added to the concertmaster conversation', {
        sessionId,
        messageId,
        err: describeError(err),
      })
    }
  }

  /** Every record started so far has finished: for a test, and for shutdown. */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running])
  }

  dispose(): void {
    this.unsubscribe()
  }
}
