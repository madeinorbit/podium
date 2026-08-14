/**
 * Engine adapter for the real sync-kernel Outbox.
 *
 * Both composition roots open this adapter before mounting the engine, then
 * every transition is performed by the kernel state machine against the
 * replica's own transactional store — IndexedDB on web, SQLite on the phone
 * (POD-2073). It is the SAME state machine over two adapters, which is the
 * point: partitioned FIFO, exponential backoff, and D10's age horizon are
 * properties of this driver, so they arrived on mobile by deleting its second
 * driver rather than by porting them into it.
 *
 * NOTHING IN HERE IS BROWSER-SPECIFIC ANY MORE, and that had to be checked
 * rather than assumed — see the connectivity fields on `KernelEngineOutbox`,
 * which were the one place a browser global was still being consulted directly.
 */

import type { MutationId } from '@podium/model'
import { actorUser, asUserId } from '@podium/model'
import {
  Outbox as KernelOutbox,
  OUTBOX_MAX_AGE_MS,
  type OutboxEnvelope,
  type OutboxEvent,
  type OutboxRecord,
  type OutboxStorePort,
  type RetrySatisfaction,
} from '@podium/sync/outbox'
import type { PodiumClientApi } from '../api'
import { randomUUID } from '../id'
import {
  classifyRefusal,
  type OnlineEvents,
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  platformIsOnline,
  platformOnlineEvents,
} from '../outbox'
import { couldNotSaveNotice } from '../outbox-recovery-copy'
import {
  type CreateEngineOutbox,
  deadLetterHandlingFor,
  type EngineOutbox,
  type EngineOutboxCallbacks,
  OUTBOX_COMMANDS,
  type OutboxKinds,
  outboxExecutors,
  outboxRoutingFor,
  shouldParkDeadLetter,
} from './wiring'

export interface OpenKernelEngineOutboxOptions {
  readonly store: OutboxStorePort
  readonly principal: string
  readonly api: PodiumClientApi
  readonly onDegraded: (detail: unknown) => void
  /**
   * THE CLOCK THE QUEUE AGES BY, when the composition root has one (POD-2073).
   *
   * Defaults to `Date.now`, which is what web has always passed by omission. It
   * is injectable because the root that opens this queue has usually ALREADY
   * written rows into the same store under its own clock — mobile runs
   * `migrateLegacyReplica` with `deps.now` immediately before opening this — and
   * D10 measures expiry from `queuedAt`. Two clocks over one store means a row
   * stamped by the first can read as fourteen days old to the second and be
   * swept into dead-letter recovery on the spot, which is a real user's unsent
   * edit resolved by a disagreement between two `now`s.
   */
  readonly now?: () => number
}

const kindByCommand = new Map<string, keyof OutboxKinds>(
  Object.entries(OUTBOX_COMMANDS).map(([kind, command]) => [
    command.name,
    kind as keyof OutboxKinds,
  ]),
)

function kindFor(record: Pick<OutboxRecord, 'command'>): keyof OutboxKinds {
  const kind = kindByCommand.get(record.command.name)
  if (kind === undefined) throw new Error(`unknown kernel Outbox command: ${record.command.name}`)
  return kind
}

function shouldDiscardDeadLetter(record: Pick<OutboxRecord, 'command' | 'input'>): boolean {
  const kind = kindByCommand.get(record.command.name)
  if (kind === undefined) return false
  return !shouldParkDeadLetter(kind, record.input)
}

async function discardAutomaticDeadLetters(kernel: KernelOutbox): Promise<void> {
  for (const record of kernel.deadLetters()) {
    if (!shouldDiscardDeadLetter(record)) continue
    await kernel.retireAutomaticBookkeeping(record.mutationId)
  }
}

/**
 * Send one envelope through the SAME executor table the compatibility queue uses
 * (`outboxExecutors`, wiring.ts).
 *
 * IT USED TO BE A SWITCH HERE, and that is the bug POD-781 group 3 drove into:
 * this file listed the dotted command names by hand, stopped at
 * `issues.setTucked`, and every curation command groups 1 and 2 added fell
 * through to a synthetic BAD_REQUEST — which `classifyRefusal` reads as a
 * DEFINITIVE refusal, so the write dead-lettered and the optimistic row snapped
 * back a beat after the press. The unit tests all passed: they drive the other
 * table. Two hand-maintained lists of the same fact, one of them the one the web
 * app actually runs.
 *
 * `kindFor` already owns name → kind, so the shared table is reachable from an
 * envelope, and a new kind now fails to COMPILE rather than failing under a
 * user's pointer.
 */
function submit(api: PodiumClientApi, envelope: OutboxEnvelope): Promise<unknown> {
  const input = { ...(envelope.input as object), mutationId: envelope.mutationId }
  const kind = kindByCommand.get(envelope.command)
  const execute = kind === undefined ? undefined : outboxExecutors(api)[kind]
  if (execute === undefined) {
    throw Object.assign(new Error(`unknown kernel Outbox command: ${envelope.command}`), {
      data: { code: 'BAD_REQUEST' },
    })
  }
  return Promise.resolve(execute(input as never))
}

class KernelEngineOutbox implements EngineOutbox {
  private readonly metadata = new Map<string, { baseline?: string; chained?: boolean }>()
  private readonly subscribers = new Set<(size: number) => void>()
  /**
   * WHERE "THE NETWORK CAME BACK" AND "AM I ONLINE" COME FROM (POD-2073).
   *
   * These used to be `platformOnlineEvents()` and `platformIsOnline()` read
   * straight off the module, which is the browser answer and only ever the
   * browser answer. That was invisible while this queue ran on web alone. On a
   * phone both probes are wrong in the same direction: React Native has no
   * `window` `online` event to subscribe to, so the drain-on-reconnect edge
   * never fires, and `navigator.onLine` is `undefined`, which
   * `platformIsOnline` reads as ONLINE — so an airplane-mode phone believes it
   * can send, retries on the backoff timer, and the queue never gets the one
   * event that would have drained it the moment the signal returned.
   *
   * `EngineOutboxCallbacks` already carries the platform's own answers
   * (POD-2055 WP-C2, NetInfo on native); the compatibility queue has taken them
   * since that wave. Taking them here is what makes the two drivers agree — and
   * the fallback is the same pair as before, so web is unchanged by omission.
   */
  private readonly onlineEvents: OnlineEvents | undefined
  private readonly isOnline: () => boolean
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attached = false
  /**
   * THE RECONNECT EDGE, and why it does not consult the probe (POD-2073).
   *
   * An `online` event IS the statement that connectivity returned; asking
   * `isOnline()` again straight afterwards can only subtract from it. The two
   * answers are not always in step — a browser fires `online` while
   * `navigator.onLine` is still settling, and any injected probe is a cached
   * last-known value read from a listener that has not run yet — and when they
   * disagree the probe wins by veto, so the queue sleeps through the one edge it
   * exists to wake on and the user's offline writes wait for a backoff timer
   * instead.
   *
   * The compatibility `Outbox` has always drained unconditionally on this event
   * (its `drain` has no online guard; only enqueue, attach and retry do), so
   * this is the parity that keeps the two queues answering the same way.
   */
  private readonly onOnline = (): void => void this.drainNow()

  constructor(
    private readonly kernel: KernelOutbox,
    private readonly callbacks: EngineOutboxCallbacks,
    private readonly onDegraded: (detail: unknown) => void,
    private readonly now: () => number,
  ) {
    this.onlineEvents = callbacks.onlineEvents ?? platformOnlineEvents()
    this.isOnline = callbacks.isOnline ?? platformIsOnline
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.onlineEvents?.add(this.onOnline)
    if (this.size() > 0 && this.isOnline()) queueMicrotask(() => void this.drain())
  }

  dispose(): void {
    if (!this.attached) return
    this.attached = false
    this.onlineEvents?.remove(this.onOnline)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  subscribe(listener: (size: number) => void): () => void {
    this.subscribers.add(listener)
    return () => this.subscribers.delete(listener)
  }

  size(): number {
    return this.kernel.pending().length
  }

  pending(): OutboxEntry[] {
    return this.kernel.pending().map((record) => this.toEntry(record))
  }

  awaiting(): OutboxEntry[] {
    return this.kernel
      .all()
      .filter((record) => record.state === 'applied')
      .map((record) => ({ ...this.toEntry(record), state: 'awaiting-truth' as const }))
  }

  deadLetters(): OutboxDeadLetterEntry[] {
    return this.kernel
      .deadLetters()
      .filter((record) => !shouldDiscardDeadLetter(record))
      .map((record) => ({
        entry: this.toEntry(record),
        reason: record.reason,
        parkedFrom: record.parkedFrom,
        deadLetteredAt: record.deadLetteredAt,
        attempts: record.attempts,
      }))
  }

  async enqueue<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    opts?: { baseline?: string; chained?: boolean; mutationId?: MutationId },
  ): Promise<OutboxEntry> {
    // A caller-supplied id (POD-1053: the optimistic ledger files its overlay
    // under the id before the entry exists) or one minted here.
    const mutationId = opts?.mutationId ?? (randomUUID() as MutationId)
    this.metadata.set(mutationId, {
      ...(opts?.baseline === undefined ? {} : { baseline: opts.baseline }),
      ...(opts?.chained === true ? { chained: true } : {}),
    })
    // POD-785: routed per TARGET, not into one global partition. See
    // OUTBOX_ROUTING for why the single `client-outbox` key wedged the queue.
    const route = outboxRoutingFor(kind, input, mutationId)
    try {
      const record = await this.kernel.enqueue({
        mutationId,
        command: OUTBOX_COMMANDS[kind],
        input,
        partitionKey: route.partitionKey,
        ...(route.collapseKey === undefined ? {} : { collapseKey: route.collapseKey }),
        attribution: {
          // The bound principal, entering the branded space (POD-1148): the
          // Outbox's pair is the model's `Attribution`, narrowed. `boundTo()` is
          // still a raw string because POD-1075 owns flipping that surface.
          actor: actorUser(asUserId(this.kernel.boundTo())),
          onBehalfOf: asUserId(this.kernel.boundTo()),
        },
      })
      if (this.isOnline()) void this.drain()
      return this.toEntry(record)
    } catch (error) {
      this.metadata.delete(mutationId)
      throw error
    }
  }

  retireAwaiting(mutationId: MutationId): void {
    void this.kernel.retireApplied(mutationId as MutationId).catch(this.onDegraded)
  }

  async retry(mutationId: MutationId, satisfaction: RetrySatisfaction): Promise<void> {
    await this.kernel.retry(mutationId as MutationId, satisfaction)
    if (this.isOnline()) await this.drain()
  }

  async edit(mutationId: MutationId, input: unknown): Promise<void> {
    await this.kernel.edit(mutationId as MutationId, { input })
    if (this.isOnline()) await this.drain()
  }

  async discard(mutationId: MutationId): Promise<void> {
    await this.kernel.discard(mutationId as MutationId)
    await this.kernel.purgeCancelled(mutationId as MutationId)
    this.metadata.delete(mutationId)
  }

  notifyConnected(): void {
    void this.drain()
  }

  async drain(): Promise<void> {
    if (!this.isOnline()) return
    await this.drainNow()
  }

  /** The drain itself, with the online question already answered — see
   *  `onOnline`, which answers it from the event rather than from the probe. */
  private async drainNow(): Promise<void> {
    try {
      await this.kernel.drain()
    } catch (error) {
      this.onDegraded(error)
    } finally {
      try {
        await discardAutomaticDeadLetters(this.kernel)
      } catch (error) {
        // A genuinely unwritable store stays loud. We suppress the ordinary
        // recovery UI for bookkeeping, not durability failures.
        this.onDegraded(error)
      }
      this.scheduleRetry()
    }
  }

  onEvent(event: OutboxEvent): void {
    if (event.type === 'applied') {
      const record = this.kernel.find(event.mutationId)
      if (record !== undefined) {
        const held = this.callbacks.onApplied?.(this.toEntry(record)) === true
        if (!held) void this.kernel.retireApplied(event.mutationId).catch(this.onDegraded)
      }
    } else if (event.type === 'dead-lettered') {
      const entry = this.toEntry(event.record)
      this.callbacks.onDropped?.(entry)
      if (shouldDiscardDeadLetter(event.record)) {
        if (deadLetterHandlingFor(entry.kind) !== 'discard-automatic') {
          this.callbacks.notices.error(couldNotSaveNotice(entry.kind, entry.input))
        }
      } else {
        const parked = this.deadLetters().find(
          (candidate) => candidate.entry.mutationId === event.record.mutationId,
        )
        if (parked !== undefined) {
          this.callbacks.notices.error(couldNotSaveNotice(entry.kind, entry.input))
          this.callbacks.onDeadLetter?.(parked)
        }
      }
    } else if (
      event.type === 'retired' ||
      event.type === 'retired-automatic' ||
      event.type === 'cancelled' ||
      // POD-785: a collapsed entry leaves the queue without ever being sent, so
      // its side metadata has to go with it. Omitted, this Map would be a second
      // unbounded collection growing exactly where the first one did — a read
      // receipt's baseline retained for a record that no longer exists.
      event.type === 'superseded'
    ) {
      this.metadata.delete(event.mutationId)
    }
    this.publish()
  }

  private toEntry(
    record: Pick<OutboxRecord, 'mutationId' | 'command' | 'input' | 'queuedAt'>,
  ): OutboxEntry {
    return {
      mutationId: record.mutationId,
      kind: kindFor(record),
      input: record.input,
      queuedAt: record.queuedAt,
      ...this.metadata.get(record.mutationId),
    }
  }

  private publish(): void {
    const size = this.size()
    for (const subscriber of [...this.subscribers]) subscriber(size)
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || !this.isOnline()) return
    const now = this.now()
    const next = this.kernel
      .pending()
      .filter((record) => record.state === 'queued' && record.nextAttemptAt !== undefined)
      .map((record) => record.nextAttemptAt as number)
      .sort((a, b) => a - b)[0]
    if (next === undefined) return
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        void this.drain()
      },
      Math.max(0, next - now),
    )
  }
}

/** Open one principal-bound kernel queue before React mounts. */
export async function openKernelEngineOutbox(
  options: OpenKernelEngineOutboxOptions,
): Promise<CreateEngineOutbox> {
  let adapter: KernelEngineOutbox | undefined
  const now = options.now ?? Date.now
  const kernel = await KernelOutbox.open({
    store: options.store,
    principal: options.principal,
    submit: {
      submit: async (envelope) => {
        try {
          await submit(options.api, envelope)
          return { kind: 'applied' }
        } catch (error) {
          const refusal = classifyRefusal(error)
          return refusal === undefined ? { kind: 'unreachable' } : { kind: 'rejected', refusal }
        }
      },
    },
    now,
    maxAgeMs: OUTBOX_MAX_AGE_MS,
    newMutationId: () => randomUUID() as MutationId,
    onStoreUnreadable: options.onDegraded,
    onEvent: (event) => adapter?.onEvent(event),
  })
  // Reconcile dead letters created by older builds before the runtime takes its
  // first snapshot, so stale automatic receipts never flash in recovery.
  try {
    await discardAutomaticDeadLetters(kernel)
  } catch (error) {
    // Keep booting with the automatic entry filtered from recovery, while the
    // real durability problem remains visible through the degraded-state path.
    options.onDegraded(error)
  }
  return (callbacks) => {
    if (adapter !== undefined) {
      throw new Error('kernel engine Outbox factory may only be consumed once')
    }
    adapter = new KernelEngineOutbox(kernel, callbacks, options.onDegraded, now)
    return adapter
  }
}
