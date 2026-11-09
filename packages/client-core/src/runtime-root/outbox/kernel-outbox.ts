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
import { actorUser, asUserId, MESSAGE_ID_PREFIX } from '@podium/model'
import { SyncSubmitReply } from '@podium/protocol'
import {
  type AuthorityRefusal,
  type CoveringCursor,
  Outbox as KernelOutbox,
  OUTBOX_MAX_AGE_MS,
  type OutboxEnvelope,
  type OutboxEvent,
  type OutboxRecord,
  type OutboxStorePort,
  type OutboxSubmitOutcome,
  type RetrySatisfaction,
  revisionOf,
} from '@podium/sync/outbox'
import type { Cursor, OptimisticOverlayPort } from '@podium/sync/replica'
import type { PodiumClientApi } from '../../api'
import { randomUUID } from '../../id'
import {
  classifyRefusal,
  type OnlineEvents,
  type OutboxDeadLetterEntry,
  type OutboxEntry,
  platformIsOnline,
  platformOnlineEvents,
} from '../../outbox'
import { couldNotSaveNotice, sessionGoneNotice } from '../../outbox-recovery-copy'
import { type RecordRevisionChain, recordRevisionChainFor } from '../../record-revisions'
import {
  isRecordOutboxKind,
  loadRecordDeclarations,
  recordOutboxKindOfCommand,
  recordWireInput,
} from '../../records'
import { outboxOverlayPort } from '../../replica-assembly/outbox-overlay'
import { LEGACY_OUTBOX_COMMANDS, type LegacyOutboxKind } from './legacy-outbox-kinds'
import {
  type CreateEngineOutbox,
  deadLetterHandlingFor,
  type EngineOutbox,
  type EngineOutboxCallbacks,
  isMissingSyncSubmit,
  OUTBOX_COMMAND_MAX_AGE_MS,
  OUTBOX_COMMANDS,
  type OutboxExecutorHooks,
  type OutboxKinds,
  outboxCommandOf,
  outboxExecutors,
  outboxRoutingFor,
  readOutboxReply,
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
  /**
   * The replica's COMMITTED cursor, or null before its first install (POD-6277).
   *
   * An applied entry waits for the replica to hold the truth its receipt names.
   * The replica retires it in the commit that gets there; this answers the other
   * order — the frame committed first, and the reply lands after it — so the
   * entry retires the moment its reply does. Late-bound because the queue opens
   * before the replica it confirms against. Omitted (a queue without a replica),
   * an entry with a receipt waits for `confirmThrough` or the overlay port.
   */
  readonly confirmedThrough?: () => Cursor | null
}

/**
 * The queue's factory, carrying the two ways the replica confirms its entries
 * (POD-6277). Still callable as `CreateEngineOutbox`, so a caller that has no
 * replica is unchanged.
 */
export type KernelEngineOutboxFactory = CreateEngineOutbox & {
  /** The replica's overlay port: retires what one replica commit covers, in it. */
  readonly overlay: OptimisticOverlayPort
  /**
   * Retire what a cursor the replica has ALREADY committed covers. For the
   * replica at rest — at open, before any frame — and after a commit that raced
   * an entry's reply. A delta never compares across epochs, so this never retires
   * a receipt from another epoch; the next install does.
   */
  confirmThrough(cursor: Cursor): Promise<readonly MutationId[]>
}

/** How long a server that lacked `sync.submit` is believed to still lack it.
 *  Bounded, so a server upgraded under an open app is found again. */
const LEGACY_SERVER_RECHECK_MS = 10 * 60_000

/** A queued kind: one this build queues, or a retired one an older build
 *  queued that still drains (LEGACY, `./legacy-outbox-kinds.ts`). */
type KernelKind = keyof OutboxKinds | LegacyOutboxKind

const fixedKindByCommand = new Map<string, KernelKind>([
  ...Object.entries(OUTBOX_COMMANDS).map(
    ([kind, command]) => [command.name, kind as keyof OutboxKinds] as const,
  ),
  // LEGACY(remove-after: 2027-03): the retired plain-edit commands, so an
  // older build's queued read mark or snooze still drains (POD-6404).
  ...Object.entries(LEGACY_OUTBOX_COMMANDS).map(
    ([kind, command]) => [command.name, kind as LegacyOutboxKind] as const,
  ),
])

/** The kernel kind one wire command is queued as. Every `records.<kind>.<op>`
 *  a generic record write is sent as (POD-6392) comes from the declarations,
 *  which the outbox's open has loaded (POD-6423). */
const kindByCommand = {
  get: (name: string): KernelKind | undefined =>
    fixedKindByCommand.get(name) ?? recordOutboxKindOfCommand(name),
}

/** The chat sends, whose mutationId IS the message id the server stores and
 *  the daemon types under (POD-4763) — so it takes a message id's shape. */
const MESSAGE_COMMANDS = new Set<string>([
  OUTBOX_COMMANDS.sendText.name,
  OUTBOX_COMMANDS.resumeAndSend.name,
])

/** A fresh id for one command's entry: a message id for a chat send, a UUID
 *  for everything else. */
function mintMutationId(command: Pick<OutboxRecord['command'], 'name'>): MutationId {
  return (
    MESSAGE_COMMANDS.has(command.name) ? `${MESSAGE_ID_PREFIX}${randomUUID()}` : randomUUID()
  ) as MutationId
}

function kindFor(record: Pick<OutboxRecord, 'command'>): KernelKind {
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
 * (`outboxExecutors`, wiring.ts). The route to an OLDER server, without
 * `sync.submit`: it answers with the bare result and no receipt.
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
 *
 * LEGACY(remove-after: 2027-03): servers without `sync.submit` take the old per-command routes and reply with no receipt, so the entry retires on the reply (plan Decision 4). Removing it leaves an app newer than its server unable to write.
 */
function submitPerKind(
  api: PodiumClientApi,
  envelope: OutboxEnvelope,
  hooks: OutboxExecutorHooks,
): Promise<unknown> {
  const kind = kindByCommand.get(envelope.command)
  const execute = kind === undefined ? undefined : outboxExecutors(api, hooks)[kind]
  if (execute === undefined) {
    throw Object.assign(new Error(`unknown kernel Outbox command: ${envelope.command}`), {
      data: { code: 'BAD_REQUEST' },
    })
  }
  return Promise.resolve(execute(commandInput(envelope) as never))
}

/** The command's input as the server reads it: the entry's id and any recovery
 *  revision ride inside it. Recovery supplies its opt-in revision on the envelope;
 *  it must override any older input copy, while ordinary absolute intents stay
 *  token-free. */
function commandInput(envelope: OutboxEnvelope): Record<string, unknown> {
  return {
    ...(envelope.input as object),
    ...revisionOf(envelope),
    mutationId: envelope.mutationId,
  }
}

/** The command's input on `sync.submit`. A record write's entry names its record
 *  kind, which the command's name already carries, so that key stays home. The
 *  per-kind executors take the entry whole: they name the command from it. */
function submitInput(kind: KernelKind, envelope: OutboxEnvelope): Record<string, unknown> {
  // Effect contracts are strict. Their mutationId belongs on the envelope,
  // unlike the legacy per-command inputs commandInput prepares for executors.
  if (kind === 'effectCreate' || kind === 'effectDismiss') {
    return envelope.input as Record<string, unknown>
  }
  const input = commandInput(envelope)
  return isRecordOutboxKind(kind) ? recordWireInput(input) : input
}

/**
 * A record write's input with its revision chained onto this device's own
 * applied predecessor of the same record (POD-6403, `../record-revisions.ts`).
 * A recovery's envelope revision is the user's choice on fresh truth: it stays.
 */
function chainedInput(
  chain: RecordRevisionChain,
  kind: KernelKind,
  envelope: OutboxEnvelope,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (envelope.expectedRevision !== undefined) return input
  const against = chain.sendAgainst(kind, envelope.input as object)
  return against === undefined ? input : { ...input, expectedRevision: against }
}

/** What one submit came back with, whichever route carried it. */
type Answered =
  | { readonly kind: 'applied'; readonly result: unknown; readonly receipt?: CoveringCursor }
  | { readonly kind: 'rejected'; readonly refusal: AuthorityRefusal }

/**
 * Send one envelope to the sync write entry point, in ONE call (ADR 12 D2), and
 * read its reply: the command's result, read by its kind, and the receipt the
 * entry waits on. Falls back to the per-kind routes for a server (or a client)
 * without `sync.submit`.
 */
async function submitEnvelope(
  api: PodiumClientApi,
  envelope: OutboxEnvelope,
  hooks: OutboxExecutorHooks,
  legacy: { recheckAt: number },
  now: () => number,
): Promise<Answered> {
  const kind = kindByCommand.get(envelope.command)
  const syncSubmit = api.sync?.submit
  if (kind !== undefined && syncSubmit !== undefined && now() >= legacy.recheckAt) {
    const chain = recordRevisionChainFor(api)
    let raw: unknown
    try {
      raw = await syncSubmit.mutate({
        mutationId: envelope.mutationId,
        command: envelope.command,
        version: envelope.version,
        input: chainedInput(chain, kind, envelope, submitInput(kind, envelope)),
        ...revisionOf(envelope),
        ...(envelope.confirmed === true ? { confirmed: true as const } : {}),
      })
    } catch (error) {
      if (!isMissingSyncSubmit(error)) throw error
      legacy.recheckAt = now() + LEGACY_SERVER_RECHECK_MS
      raw = undefined
    }
    if (raw !== undefined) {
      // A reply we cannot read is a transport failure (thrown, so retried), never
      // a guess at what the server did.
      const reply = SyncSubmitReply.parse(raw)
      if (reply.outcome === 'rejected') return { kind: 'rejected', refusal: reply.refusal }
      if (envelope.expectedRevision === undefined) {
        chain.applied(kind, envelope.input as object, reply.result)
      }
      return {
        kind: 'applied',
        result: readOutboxReply(
          kind as keyof OutboxKinds,
          envelope.input as never,
          reply.result,
          hooks,
        ),
        receipt: reply.receipt,
      }
    }
  }
  // The entry point is missing (or this kind has no record of it): the per-kind
  // route, without probing the entry point again.
  return {
    kind: 'applied',
    result: await submitPerKind(api, envelope, { ...hooks, syncSubmitMissing: true }),
  }
}

/**
 * What the Authority said to the attempt in flight, held until the kernel's
 * event for that attempt reports it (POD-4762). The kernel stores only the
 * normalized refusal reason; the raw cause and the answer a chat bubble shows
 * ("queued behind this turn") live here until the commit resolves the attempt.
 */
type Answers = Map<string, { readonly reply?: unknown; readonly cause?: unknown }>

class KernelEngineOutbox implements EngineOutbox {
  private readonly localWrites = new Set<Promise<unknown>>()
  /**
   * Queued entries an in-flight enqueue may collapse (POD-4554). The kernel
   * removes a superseded record before its event fires, so what it carried is
   * captured here, under the enqueue that could collapse it, for
   * `onSuperseded`. Empty outside an enqueue, and never filled while nobody
   * observes supersedes (the scan is not the production write path's cost).
   */
  private readonly collapsible = new Map<string, OutboxEntry>()
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
  /** Wakes the queue when its next entry ages out, online or not (POD-4762). */
  private expiryTimer: ReturnType<typeof setTimeout> | null = null
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
    private readonly answers: Answers,
  ) {
    this.onlineEvents = callbacks.onlineEvents ?? platformOnlineEvents()
    this.isOnline = callbacks.isOnline ?? platformIsOnline
  }

  attach(): void {
    if (this.attached) return
    this.attached = true
    this.onlineEvents?.add(this.onOnline)
    if (this.size() > 0 && this.isOnline()) queueMicrotask(() => void this.drain())
    this.scheduleExpiry()
  }

  dispose(): void {
    if (!this.attached) return
    this.attached = false
    this.onlineEvents?.remove(this.onOnline)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
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

  enqueue<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    opts?: { mutationId?: MutationId },
  ): Promise<OutboxEntry> {
    return this.trackLocalWrite(this.enqueueDurably(kind, input, opts))
  }

  private trackLocalWrite<T>(commit: Promise<T>): Promise<T> {
    this.localWrites.add(commit)
    void commit.then(
      () => this.localWrites.delete(commit),
      () => this.localWrites.delete(commit),
    )
    return commit
  }

  async flushLocalWrites(): Promise<void> {
    while (this.localWrites.size > 0) await Promise.all(this.localWrites)
  }

  private async enqueueDurably<K extends keyof OutboxKinds & string>(
    kind: K,
    input: OutboxKinds[K],
    opts?: { mutationId?: MutationId },
  ): Promise<OutboxEntry> {
    // A caller-supplied id (POD-1053: the optimistic ledger files its overlay
    // under the id before the entry exists) or one minted here.
    const command = outboxCommandOf(kind, input)
    const mutationId = opts?.mutationId ?? mintMutationId(command)
    // POD-785: routed per TARGET, not into one global partition. See
    // OUTBOX_ROUTING for why the single `client-outbox` key wedged the queue.
    const route = outboxRoutingFor(kind, input, mutationId)
    const candidates =
      route.collapseKey === undefined ||
      this.callbacks.onSuperseded === undefined ||
      this.callbacks.observingSupersede?.() === false
        ? []
        : this.kernel
            .pending()
            .filter((r) => r.state === 'queued' && r.collapseKey === route.collapseKey)
    for (const record of candidates) this.collapsible.set(record.mutationId, this.toEntry(record))
    try {
      const record = await this.kernel.enqueue({
        mutationId,
        command,
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
    } finally {
      for (const record of candidates) this.collapsible.delete(record.mutationId)
    }
  }

  async retry(mutationId: MutationId, satisfaction: RetrySatisfaction): Promise<void> {
    await this.trackLocalWrite(this.kernel.retry(mutationId as MutationId, satisfaction))
    if (this.isOnline()) await this.drain()
  }

  async edit(mutationId: MutationId, input: unknown): Promise<void> {
    await this.trackLocalWrite(this.kernel.edit(mutationId as MutationId, { input }))
    if (this.isOnline()) await this.drain()
  }

  async discard(mutationId: MutationId): Promise<void> {
    await this.trackLocalWrite(this.kernel.discard(mutationId as MutationId))
    await this.kernel.purgeCancelled(mutationId as MutationId)
    // A cancelled entry releases its partition (R1, ADR 3 amendment 2). When it
    // was a queued head backing off, what was written behind it goes now rather
    // than at the next unrelated drain trigger.
    if (this.isOnline()) void this.drain()
  }

  /** A send resolved undelivered because its session was deleted (POD-4660):
   *  the entry is done, so say so rather than let it vanish. */
  sessionGone(input: OutboxKinds['resumeAndSend']): void {
    this.callbacks.notices.error(sessionGoneNotice(input.text))
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
      const answer = this.answers.get(event.mutationId)
      this.answers.delete(event.mutationId)
      this.callbacks.onSettled?.(event.mutationId, { kind: 'applied', reply: answer?.reply })
    } else if (event.type === 'dead-lettered') {
      const answer = this.answers.get(event.record.mutationId)
      this.answers.delete(event.record.mutationId)
      this.callbacks.onSettled?.(event.record.mutationId, {
        kind: 'not-sent',
        reason: event.record.reason,
        cause: answer?.cause,
      })
    }
    if (event.type === 'applied') {
      // Announced, not retired: the entry keeps painting until the replica holds
      // the truth that covers it (ADR 12). `openKernelEngineOutbox` confirms it
      // against the replica's cursor straight after this. An entry the replica
      // confirmed before its reply is already gone here, as a terminal reply is.
      const record = this.kernel.find(event.mutationId)
      if (record !== undefined) this.callbacks.onApplied?.(this.toEntry(record))
    } else if (event.type === 'dead-lettered') {
      const entry = this.toEntry(event.record)
      this.callbacks.onDropped?.(entry, event.record.reason)
      if (shouldDiscardDeadLetter(event.record)) {
        if (deadLetterHandlingFor(entry.kind, entry.input) !== 'discard-automatic') {
          this.callbacks.notices.error(
            couldNotSaveNotice(entry.kind, entry.input, event.record.reason),
          )
        }
      } else {
        const parked = this.deadLetters().find(
          (candidate) => candidate.entry.mutationId === event.record.mutationId,
        )
        if (parked !== undefined) {
          this.callbacks.notices.error(
            couldNotSaveNotice(entry.kind, entry.input, event.record.reason),
          )
          this.callbacks.onDeadLetter?.(parked)
        }
      }
    } else if (event.type === 'superseded') {
      this.callbacks.onSuperseded?.(event.mutationId, this.collapsible.get(event.mutationId))
    }
    // Queue membership moved (a new entry, a re-issue, a park, a retirement), so
    // the next expiry instant may have too.
    if (event.type !== 'sending' && event.type !== 'accepted') this.scheduleExpiry()
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
    }
  }

  private publish(): void {
    const size = this.size()
    for (const subscriber of [...this.subscribers]) subscriber(size)
  }

  /**
   * GIVE UP ON TIME, ONLINE OR NOT (POD-4762). The kernel ages an entry out only
   * when something sweeps, and the drain — the only sweeper while running — is
   * exactly what an offline client never does. With a 14-day age that gap was
   * invisible (the sweep at the next boot was early enough); with a chat send's
   * two minutes it is the whole behaviour: "not sent — retry" has to appear
   * while the person is still looking at the bubble.
   */
  private scheduleExpiry(): void {
    if (!this.attached) return
    if (this.expiryTimer !== null) clearTimeout(this.expiryTimer)
    this.expiryTimer = null
    const at = this.kernel.nextExpiryAt()
    if (at === undefined) return
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimer = null
        void this.kernel
          .sweepExpired()
          .then((expired) => {
            // An expired entry is parked, a definitive outcome that releases
            // its partition (R1): drain what was waiting behind it.
            if (expired.length > 0 && this.isOnline()) void this.drain()
          })
          .catch(this.onDegraded)
          .finally(() => this.scheduleExpiry())
      },
      // `isAgedOut` is strict: an entry is still sendable AT its expiry instant.
      Math.max(0, at - this.now() + 1),
    )
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
): Promise<KernelEngineOutboxFactory> {
  let adapter: KernelEngineOutbox | undefined
  const now = options.now ?? Date.now
  // Notices shown once per id in this session. A verdict commit that did not
  // land requeues with backoff and re-POSTs the same id (the Authority
  // dedupes it by receipt without re-running); without this the same-session
  // retry would toast "Message not sent" twice for one message. The terminal
  // flag is still set on every verdict — only the toast is deduped, never the
  // retirement. Per kernel (per boot): a reload that replays a stale durable
  // copy is a different session with its own notice, which is correct — but
  // after the requeue fix above that reload replay should not happen, so this
  // Set stays small (one entry per dead message, a few per boot) and needs no
  // eviction.
  const noticedGone = new Set<string>()
  const answers: Answers = new Map()
  const legacy = { recheckAt: 0 }
  // The record declarations load beside the queue (POD-6423): every queued
  // record write is read, sent and painted through them, and nothing reaches
  // this queue's records before both have opened.
  const declarationsLoaded = loadRecordDeclarations()
  // Awaited below; a queue that fails to open first must not leave it unhandled.
  declarationsLoaded.catch(() => {})
  const kernel = await KernelOutbox.open({
    store: options.store,
    principal: options.principal,
    submit: {
      submit: async (envelope) => {
        // A terminal reply resolves its entry FOR GOOD (POD-4690): the verdict
        // retires in its own commit, so no later drain can re-read the entry
        // and POST it again. The executor reports these through hooks (it owns
        // the reading of the reply); the flag here only carries that reading
        // to the kernel's terminal outcome.
        //
        // The announcement waits for the commit (this issue): the hook fires on
        // the reply, but the retire lands an async store commit later, and a
        // reload between the two re-reads `sending`, reconciles it back to
        // `queued`, and POSTs the dead message again behind a queued banner.
        // `onCommitted` runs strictly after durability, so navigating away on
        // the notice can never race the commit it announces. A commit that
        // never lands announces nothing; the retry announces on its own
        // landing instead (deduped below, still once per id per session).
        const terminal = {
          resolved: false,
          goneInput: undefined as OutboxKinds['resumeAndSend'] | undefined,
        }
        try {
          const answer = await submitEnvelope(
            options.api,
            envelope,
            {
              sessionGone: (input) => {
                terminal.resolved = true
                terminal.goneInput = input
              },
              stoppedSend: () => {
                terminal.resolved = true
              },
            },
            legacy,
            now,
          )
          if (answer.kind === 'rejected') {
            return { kind: 'rejected', refusal: answer.refusal } satisfies OutboxSubmitOutcome
          }
          // Kept only while the entry is still here: one the replica confirmed
          // while this reply was on the wire has already settled, and its answer
          // would never be collected.
          if (kernel.find(envelope.mutationId) !== undefined) {
            answers.set(envelope.mutationId, { reply: answer.result })
          }
          const receipt = answer.receipt === undefined ? {} : { receipt: answer.receipt }
          if (!terminal.resolved) {
            return { kind: 'applied', ...receipt } satisfies OutboxSubmitOutcome
          }
          const goneInput = terminal.goneInput
          return {
            kind: 'applied',
            retire: true,
            ...receipt,
            onCommitted: goneInput
              ? () => {
                  if (!noticedGone.has(envelope.mutationId)) {
                    noticedGone.add(envelope.mutationId)
                    adapter?.sessionGone(goneInput)
                  }
                }
              : undefined,
          } satisfies OutboxSubmitOutcome
        } catch (error) {
          const refusal = classifyRefusal(error)
          if (refusal === undefined) return { kind: 'unreachable' }
          answers.set(envelope.mutationId, { cause: error })
          return { kind: 'rejected', refusal }
        }
      },
    },
    now,
    maxAgeMs: OUTBOX_MAX_AGE_MS,
    commandMaxAgeMs: OUTBOX_COMMAND_MAX_AGE_MS,
    newMutationId: mintMutationId,
    onStoreUnreadable: options.onDegraded,
    onEvent: (event) => {
      adapter?.onEvent(event)
      if (event.type === 'applied') confirmApplied(event.mutationId)
    },
  })
  await declarationsLoaded
  /** Entries left the queue by confirmation: what waited behind them goes now
   *  (a retirement frees a partition but starts no drain, POD-6275). */
  const drainAfterRetire = (ids: readonly MutationId[]): void => {
    if (ids.length > 0) void adapter?.drain()
  }
  const confirmThrough = async (cursor: Cursor): Promise<readonly MutationId[]> => {
    const retired = await kernel.confirm({ confirmed: [], through: cursor, install: false })
    drainAfterRetire(retired)
    return retired
  }
  /**
   * An entry's reply was just recorded. With a receipt it retires as soon as the
   * replica's committed cursor covers it — at once when the covering frame came
   * first (ADR 12 Review Focus 2). Without one the server had no `sync.submit`,
   * and the reply retires it (plan Decision 4).
   */
  function confirmApplied(mutationId: MutationId): void {
    const record = kernel.find(mutationId)
    if (record?.state !== 'applied') return
    if (record.receipt === undefined) {
      // LEGACY(remove-after: 2027-03): a reply from a server without `sync.submit` carries no receipt, so it retires on the reply as before. Removing it leaves such entries applied until the next confirmation or boot.
      retireIfApplied(kernel, mutationId, options.onDegraded)
      return
    }
    const cursor = options.confirmedThrough?.() ?? null
    if (cursor === null) return
    void confirmThrough(cursor).catch(options.onDegraded)
  }
  // Reconcile dead letters created by older builds before the runtime takes its
  // first snapshot, so stale automatic receipts never flash in recovery.
  try {
    await discardAutomaticDeadLetters(kernel)
  } catch (error) {
    // Keep booting with the automatic entry filtered from recovery, while the
    // real durability problem remains visible through the degraded-state path.
    options.onDegraded(error)
  }
  const create: CreateEngineOutbox = (callbacks) => {
    if (adapter !== undefined) {
      throw new Error('kernel engine Outbox factory may only be consumed once')
    }
    adapter = new KernelEngineOutbox(kernel, callbacks, options.onDegraded, now, answers)
    return adapter
  }
  return Object.assign(create, {
    overlay: outboxOverlayPort(kernel, { onRetired: drainAfterRetire }),
    confirmThrough,
  })
}

/**
 * Retire an applied entry unless something else already did. The replica's
 * confirmation can land between the check and this write, so an entry that is
 * gone by then is not an error either.
 */
function retireIfApplied(
  kernel: KernelOutbox,
  mutationId: MutationId,
  onDegraded: (detail: unknown) => void,
): void {
  if (kernel.find(mutationId)?.state !== 'applied') return
  void kernel.retireApplied(mutationId).catch((error) => {
    if (kernel.find(mutationId)?.state === 'applied') onDegraded(error)
  })
}
