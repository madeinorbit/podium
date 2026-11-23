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
 * here can fail or slow a delivery. The feature is read from the workspace store for each record attempt.
 *
 * AT THE ROOT SCOPE. The announcement runs inside the commit's post-commit
 * drain, and that drain does not wait for this record. Started there, the
 * record would inherit the drain's scope and query on a lease that has already
 * been released (`StaleTransactionError` from its second statement on), so it
 * is dispatched at the root, where it queues like any other caller.
 */

import { createLogger, describeError } from '@podium/logger'
import { asSessionId, type SessionId } from '@podium/model'
import { runAtRoot } from '../../publication-scope'
import type { CommittedRowChange } from '../../store/committed-rows'
import type { MessageQueueFact } from '../../store/messages'

const log = createLogger('server:concertmaster')

export interface DeliveredMessageWatchDeps {
  enabled(): boolean | Promise<boolean>
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
    if (change.operation !== 'upsert') return
    for (const row of change.rows) {
      if (row.toKind !== 'session' || row.toId === null || row.deliveryStatus !== 'confirmed') {
        continue
      }
      const sessionId = asSessionId(row.toId)
      const messageId = row.id
      const run = runAtRoot(async () => await this.record(sessionId, messageId))
      this.running.add(run)
      void run.finally(() => this.running.delete(run))
    }
  }

  private async record(sessionId: SessionId, messageId: string): Promise<void> {
    try {
      if (!(await this.deps.enabled())) return
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
