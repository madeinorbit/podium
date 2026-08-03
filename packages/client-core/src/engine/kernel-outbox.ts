/**
 * Engine adapter for the real sync-kernel Outbox.
 *
 * Web opens this adapter before mounting the engine, then every transition is
 * performed by the kernel state machine against the replica's IndexedDB store.
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
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  platformIsOnline,
  platformOnlineEvents,
} from '../outbox'
import { reasonSummary } from '../outbox-recovery-copy'
import {
  type CreateEngineOutbox,
  type EngineOutbox,
  type EngineOutboxCallbacks,
  OUTBOX_COMMANDS,
  type OutboxKinds,
  outboxRoutingFor,
} from './wiring'

export interface OpenKernelEngineOutboxOptions {
  readonly store: OutboxStorePort
  readonly principal: string
  readonly api: PodiumClientApi
  readonly onDegraded: (detail: unknown) => void
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

function submit(api: PodiumClientApi, envelope: OutboxEnvelope): Promise<unknown> {
  const input = { ...(envelope.input as object), mutationId: envelope.mutationId }
  switch (envelope.command) {
    case 'pins.set':
      return api.pins.set.mutate(input as never)
    case 'tabs.setOrder':
      return api.tabs.setOrder.mutate(input as never)
    case 'layout.set':
      return api.layout.set.mutate(input as never)
    case 'layout.clear':
      return api.layout.clear.mutate(input as never)
    case 'settings.updatePersonal':
      return api.settings.updatePersonal.mutate(input as never)
    case 'sessions.resumeAndSend':
      return api.sessions.resumeAndSend.mutate(input as never)
    case 'sessions.rename':
      return api.sessions.rename.mutate(input as never)
    case 'sessions.setArchived':
      return api.sessions.setArchived.mutate(input as never)
    case 'sessions.setWorkState':
      return api.sessions.setWorkState.mutate(input as never)
    case 'snoozes.set':
      return api.snoozes.set.mutate(input as never)
    case 'snoozes.clear':
      return api.snoozes.clear.mutate(input as never)
    case 'sessions.markRead':
      return api.sessions.markRead.mutate(input as never)
    case 'sessions.markUnread':
      return api.sessions.markUnread.mutate(input as never)
    case 'issues.markRead':
      return api.issues.markRead.mutate(input as never)
    case 'issues.markUnread':
      return api.issues.markUnread.mutate(input as never)
    case 'issues.setTucked':
      return api.issues.setTucked.mutate(input as never)
    default:
      throw Object.assign(new Error(`unknown kernel Outbox command: ${envelope.command}`), {
        data: { code: 'BAD_REQUEST' },
      })
  }
}

class KernelEngineOutbox implements EngineOutbox {
  private readonly metadata = new Map<string, { baseline?: string; chained?: boolean }>()
  private readonly subscribers = new Set<(size: number) => void>()
  private readonly onlineEvents = platformOnlineEvents()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attached = false
  private readonly onOnline = (): void => void this.drain()

  constructor(
    private readonly kernel: KernelOutbox,
    private readonly callbacks: EngineOutboxCallbacks,
    private readonly onDegraded: (detail: unknown) => void,
  ) {}

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.onlineEvents?.add(this.onOnline)
    if (this.size() > 0 && platformIsOnline()) queueMicrotask(() => void this.drain())
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
    return this.kernel.deadLetters().map((record) => ({
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
    opts?: { baseline?: string; chained?: boolean },
  ): Promise<OutboxEntry> {
    const mutationId = randomUUID() as MutationId
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
      if (platformIsOnline()) void this.drain()
      return this.toEntry(record)
    } catch (error) {
      this.metadata.delete(mutationId)
      throw error
    }
  }

  retireAwaiting(mutationId: string): void {
    void this.kernel.retireApplied(mutationId as MutationId).catch(this.onDegraded)
  }

  async retry(mutationId: string, satisfaction: RetrySatisfaction): Promise<void> {
    await this.kernel.retry(mutationId as MutationId, satisfaction)
    if (platformIsOnline()) await this.drain()
  }

  async edit(mutationId: string, input: unknown): Promise<void> {
    await this.kernel.edit(mutationId as MutationId, { input })
    if (platformIsOnline()) await this.drain()
  }

  async discard(mutationId: string): Promise<void> {
    await this.kernel.discard(mutationId as MutationId)
    await this.kernel.purgeCancelled(mutationId as MutationId)
    this.metadata.delete(mutationId)
  }

  notifyConnected(): void {
    void this.drain()
  }

  async drain(): Promise<void> {
    if (!platformIsOnline()) return
    try {
      await this.kernel.drain()
    } catch (error) {
      this.onDegraded(error)
    } finally {
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
      const parked = this.deadLetters().find(
        (candidate) => candidate.entry.mutationId === event.record.mutationId,
      )
      if (parked !== undefined) {
        this.callbacks.notices.error(
          `A queued change (${entry.kind}) needs your attention — ${reasonSummary(parked.reason.code)}`,
        )
        this.callbacks.onDeadLetter?.(parked)
      }
    } else if (
      event.type === 'retired' ||
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
    if (this.retryTimer !== null || !platformIsOnline()) return
    const now = Date.now()
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
    now: Date.now,
    maxAgeMs: OUTBOX_MAX_AGE_MS,
    newMutationId: () => randomUUID() as MutationId,
    onStoreUnreadable: options.onDegraded,
    onEvent: (event) => adapter?.onEvent(event),
  })
  return (callbacks) => {
    if (adapter !== undefined) {
      throw new Error('kernel engine Outbox factory may only be consumed once')
    }
    adapter = new KernelEngineOutbox(kernel, callbacks, options.onDegraded)
    return adapter
  }
}
