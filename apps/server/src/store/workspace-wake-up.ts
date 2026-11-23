/**
 * THE WORKSPACE WAKE-UP [POD-7292, POD-6954 design 4.2 and 4.13].
 *
 * One question, asked by every process that serves a workspace's sockets: "tell me when
 * workspace W has new log rows". The answer is a signal with no data in it. A woken
 * subscriber reads the rows after its own cursor from the database, which is the only
 * source of truth, so a signal that is lost, repeated or early is never wrong: a lost one
 * only delays delivery until the next signal or the poll.
 *
 * - {@link WorkspaceWakeUps.publish} is called AFTER a write committed log rows. The store
 *   calls it from a post-commit effect of every change-log append, so no caller of the
 *   store calls it, and nobody names the transport.
 * - {@link WorkspaceWakeUps.subscribe} registers a callback for one workspace.
 *
 * TWO TRANSPORTS, chosen by the store's engine when the database opens (`StoreDatabase`):
 *
 * - SQLite is one process: {@link inProcessWakeUpTransport}, an event in the same process.
 * - Postgres may be many processes: `pgWakeUpTransport` (`workspace-wake-up-pg.ts`),
 *   `LISTEN` on one dedicated connection per process and `NOTIFY` sent after the commit as
 *   its own statement, never inside a write transaction.
 *
 * THE POLL, in both: while a workspace has subscribers this process reads its feed head
 * every {@link DEFAULT_WAKE_UP_POLL_MS} with ONE batched read for all of them
 * (`wake-up-reads.ts`), and wakes the subscribers of each head that moved. The transport
 * asks for one more poll whenever its listener (re)connects, because notifications sent
 * while it was away are gone.
 *
 * PUBLISHING IS BATCHED PER TICK. Workspace ids published in the same turn of the event
 * loop go out as one transport send, and while one send is in flight the next ids wait for
 * it, so a burst of commits costs one `NOTIFY` statement, not one each. On Postgres every
 * commit that notifies takes one global lock; fewer such commits is the point.
 */

import { createLogger } from '@podium/logger'
import type { WorkspaceId } from '@podium/model'

const log = createLogger('server:wake-up')

/**
 * The poll's default period. Seconds, not milliseconds, on purpose: the poll only bounds
 * how late a LOST signal is healed, and signals are rarely lost (a dropped listener
 * connection, a notifier error). Its cost is one indexed read per process per period,
 * whatever the number of workspaces it serves: at 3 s that is a third of a statement per
 * second per process. Shorter buys faster healing of a rare loss for constant load on the
 * database; longer makes a lost signal visible to a person as a stale screen.
 */
export const DEFAULT_WAKE_UP_POLL_MS = 3_000

/** The poll period, by environment (operators and tests). */
export const WAKE_UP_POLL_MS_ENV = 'PODIUM_WAKE_UP_POLL_MS'

/** Called when a workspace may have new log rows. Carries nothing; read after your cursor. */
export type WakeUpListener = () => void

/** "Tell me when workspace W has new log rows" (design 4.2). */
export interface WorkspaceWakeUps {
  /** Call `listener` whenever `workspaceId` may have new log rows. Returns the unsubscribe. */
  subscribe(workspaceId: WorkspaceId, listener: WakeUpListener): () => void
  /**
   * Tell every process that `workspaceId` has new log rows. Only after the commit: the
   * store calls this from a post-commit effect, and nothing else needs to.
   */
  publish(workspaceId: WorkspaceId): void
  /** Stop the poll and the transport. Idempotent. */
  close(): Promise<void>
}

/**
 * How signals travel between processes. `listen` starts receiving (lazily, at the first
 * subscription); `onReady` runs each time the listener is (re)connected, after which
 * anything sent is received, so the hub polls once to cover what was sent before.
 */
export interface WakeUpTransport {
  readonly kind: 'in-process' | 'postgres'
  listen(receive: (workspaceId: WorkspaceId) => void, onReady: () => void): void
  /** Send one signal per id. Ids are distinct. Rejects when the signal could not be sent. */
  send(workspaceIds: readonly WorkspaceId[]): Promise<void>
  close(): Promise<void>
}

/** The feed heads of the listed workspaces, in one read; an absent id has no feed. */
export type FeedHeadReader = (
  workspaceIds: readonly WorkspaceId[],
) => Promise<ReadonlyMap<WorkspaceId, number>>

export interface WakeUpHubOptions {
  readonly transport: WakeUpTransport
  readonly readHeads: FeedHeadReader
  /** The poll period; `0` turns the periodic poll off (the reconnect poll still runs). */
  readonly pollIntervalMs?: number
  /**
   * `tick` (the default) sends the ids of one event-loop turn together and waits for the
   * send in flight. `each` sends every publish on its own, for the measurement only.
   */
  readonly batching?: 'tick' | 'each'
}

interface Subscription {
  readonly listeners: Set<WakeUpListener>
  /** The head the last poll saw; undefined until a poll has seen it. */
  head: number | undefined
}

/**
 * The subscriber side and the publish side over one transport. One per process (one per
 * `StoreDatabase`).
 */
export class WakeUpHub implements WorkspaceWakeUps {
  private readonly subscriptions = new Map<WorkspaceId, Subscription>()
  private readonly pollIntervalMs: number
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private polling: Promise<void> | undefined
  private pollAgain = false
  private listening = false
  private closed = false

  private pending = new Set<WorkspaceId>()
  private flushScheduled = false
  private sending: Promise<void> | undefined

  constructor(private readonly options: WakeUpHubOptions) {
    this.pollIntervalMs = Math.max(0, Math.floor(options.pollIntervalMs ?? DEFAULT_WAKE_UP_POLL_MS))
  }

  get transportKind(): WakeUpTransport['kind'] {
    return this.options.transport.kind
  }

  subscribe(workspaceId: WorkspaceId, listener: WakeUpListener): () => void {
    if (this.closed) throw new Error('workspace wake-ups are closed')
    let subscription = this.subscriptions.get(workspaceId)
    if (subscription === undefined) {
      subscription = { listeners: new Set(), head: undefined }
      this.subscriptions.set(workspaceId, subscription)
    }
    subscription.listeners.add(listener)
    this.startListening()
    this.startPolling()
    return () => {
      const current = this.subscriptions.get(workspaceId)
      if (current === undefined || !current.listeners.delete(listener)) return
      if (current.listeners.size === 0) this.subscriptions.delete(workspaceId)
      if (this.subscriptions.size === 0) this.stopPolling()
    }
  }

  publish(workspaceId: WorkspaceId): void {
    if (this.closed) return
    if (this.options.batching === 'each') {
      this.track(this.options.transport.send([workspaceId]))
      return
    }
    this.pending.add(workspaceId)
    this.scheduleFlush()
  }

  /**
   * A signal arrived for `workspaceId`: wake its subscribers in this process. The one
   * entry point of every transport's signals, and so the seam a test drops them at.
   */
  receive(workspaceId: WorkspaceId): void {
    const subscription = this.subscriptions.get(workspaceId)
    if (subscription !== undefined) this.wake(workspaceId, subscription)
  }

  /**
   * Read the heads of every subscribed workspace once and wake those that moved. A poll
   * asked for while one runs runs again after it, so its read starts after the request
   * (the reconnect poll must read after the listener is back). Resolves when done.
   */
  poll(): Promise<void> {
    if (this.polling !== undefined) {
      this.pollAgain = true
      return this.polling
    }
    const run = (async () => {
      try {
        do {
          this.pollAgain = false
          await this.pollOnce()
        } while (this.pollAgain && !this.closed)
      } finally {
        // In the same turn as the last check of `pollAgain`, so a request made after
        // that check starts a new run instead of joining a finished one.
        this.polling = undefined
      }
    })()
    this.polling = run
    return run
  }

  /** Every published id has been handed to the transport and the sends have settled. */
  async settled(): Promise<void> {
    while (this.flushScheduled || this.sending !== undefined || this.pending.size > 0) {
      if (this.sending !== undefined) await this.sending
      else await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stopPolling()
    this.subscriptions.clear()
    await this.settled().catch(() => undefined)
    await this.options.transport.close()
  }

  private wake(workspaceId: WorkspaceId, subscription: Subscription): void {
    for (const listener of [...subscription.listeners]) {
      try {
        listener()
      } catch (err) {
        log.warn('workspace wake-up listener threw', { workspaceId, err })
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const ids = [...this.subscriptions.keys()]
    if (ids.length === 0 || this.closed) return
    let heads: ReadonlyMap<WorkspaceId, number>
    try {
      heads = await this.options.readHeads(ids)
    } catch (err) {
      if (!this.closed) log.warn('workspace wake-up poll failed', { err })
      return
    }
    for (const id of ids) {
      const subscription = this.subscriptions.get(id)
      const head = heads.get(id)
      if (subscription === undefined || head === undefined) continue
      // A head this hub has not seen yet wakes too: a signal may have been lost between
      // the subscriber's own read and this first poll, and a spare wake-up costs one read.
      if (subscription.head === head) continue
      subscription.head = head
      this.wake(id, subscription)
    }
  }

  private startListening(): void {
    if (this.listening) return
    this.listening = true
    this.options.transport.listen(
      (workspaceId) => this.receive(workspaceId),
      () => {
        if (!this.closed) void this.poll()
      },
    )
  }

  private startPolling(): void {
    if (this.pollTimer !== undefined || this.pollIntervalMs === 0 || this.closed) return
    this.pollTimer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.sending !== undefined) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      this.flush()
    })
  }

  private flush(): void {
    if (this.pending.size === 0) return
    const ids = [...this.pending]
    this.pending = new Set()
    const sending = this.options.transport.send(ids).then(
      () => undefined,
      (err: unknown) => {
        // The poll heals a lost signal; a failed send is not a failed write.
        if (!this.closed) log.warn('workspace wake-up send failed', { count: ids.length, err })
      },
    )
    this.sending = sending
    void sending.finally(() => {
      this.sending = undefined
      if (this.pending.size > 0) this.scheduleFlush()
    })
  }

  private track(sending: Promise<void>): void {
    sending.catch((err: unknown) => {
      if (!this.closed) log.warn('workspace wake-up send failed', { count: 1, err })
    })
  }
}

/**
 * The single-process transport: a signal is delivered to this process's subscribers in
 * the same turn it is sent, which is already after the commit and one event-loop tick.
 */
export function inProcessWakeUpTransport(): WakeUpTransport {
  let receive: ((workspaceId: WorkspaceId) => void) | undefined
  return {
    kind: 'in-process',
    listen(onReceive, onReady) {
      receive = onReceive
      onReady()
    },
    async send(workspaceIds) {
      for (const id of workspaceIds) receive?.(id)
    },
    async close() {
      receive = undefined
    },
  }
}

/** The poll period from the environment, or the default. Refuses a value that is not one. */
export function wakeUpPollMsFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[WAKE_UP_POLL_MS_ENV]?.trim()
  if (!raw) return DEFAULT_WAKE_UP_POLL_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${WAKE_UP_POLL_MS_ENV} must be a whole number of milliseconds, got '${raw}'`)
  }
  return value
}
