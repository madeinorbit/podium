/**
 * One CLIENT per principal: the real `Replica`, the real `Outbox`, and the real
 * storage ports of whichever instantiation is under test. Nothing here is a double —
 * the doubles live in the instantiation and in the authority.
 *
 * ─── THE ONE THING A READER MUST KNOW ────────────────────────────────────────
 *
 * There is exactly ONE commit path, and that is the point. `client.replica.receive`
 * commits the entity operations, the cursor and the deduplicated retirement batch in
 * ONE `unitOfWork.transact`, over BOTH kernels' REAL store ports.
 *
 * It was not always reachable. Until POD-1158 the Replica opened its own span and
 * committed it synchronously, so the async Outbox could never enrol: the span had
 * settled before `retireAllApplied` reached `span.join`, the cursor advanced anyway,
 * and the confirmed entry stayed durable and stuck in `applied`. This suite found that
 * — against both real kernels, on the normal path, with no crash injected — and the
 * fix is what lets every case below run through the kernel's own path rather than
 * through an integrator-shaped imitation of it. The defect itself is pinned by name in
 * `../unit-of-work-seam.test.ts`.
 *
 * So there is no second path here and no degraded mode to account for. A per-write
 * fallback on the durable path IS the D10 non-compliance; the Replica now refuses that
 * configuration at construction, so this harness cannot express it even by accident.
 *
 * What a commit retires is decided by evidence only: the envelope provenance it
 * applied, deduplicated and in feed order (ADR 2 D8), and the cursor it certifies
 * against each applied entry's receipt (ADR 12). Value comparison is never used:
 * that would be the replica arbitrating.
 */

import type { MutationId } from '@podium/model'
import { Outbox } from '../outbox/outbox'
import type { OutboxEvent, OutboxSubmitPort } from '../outbox/ports'
import type { ConfirmationEvidence, OutboxAttribution, OutboxRecord } from '../outbox/records'
import type { OptimisticOverlayPort, PendingMutation, RetirementEvidence } from '../replica/overlay'
import { Replica } from '../replica/replica'
import type { DeltaFrame, EntityRecord, ReplicaEvent, ServerFrame } from '../replica/types'
import type { ConformanceAuthority, ConformancePrincipal } from './authority'
import { attributionOf, keyOf, requireHuman } from './authority'
import type { ConformanceStorage, ConformanceStorageView } from './instantiation'

/** D10's age ceiling. ADR 3 D10 owns the value; the suite only needs it to be finite. */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

/** A hand-cranked clock. A fixed sleep before an assertion is a bug, not a wait. */
export class Clock {
  constructor(private t = 1_700_000_000_000) {}
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

export interface ConformanceClient {
  readonly principal: ConformancePrincipal
  readonly replica: Replica
  readonly outbox: Outbox
  readonly view: ConformanceStorageView
  readonly replicaEvents: ReplicaEvent[]
  readonly outboxEvents: OutboxEvent[]
  /** Fresh instances over the SAME storage — a power loss, not a restart. */
  recover(): Promise<ConformanceClient>
}

export interface ClientOptions {
  readonly authority: ConformanceAuthority
  readonly storage: ConformanceStorage
  readonly principal: ConformancePrincipal
  readonly clock: Clock
  /** Shared across recoveries, so a re-issued id is never a repeat of a retired one. */
  readonly newMutationId: () => MutationId
  /**
   * The submit transport, when a case needs a server that behaves differently: a
   * write the authority suppressed as a no-op, or a reply that arrives late.
   * Default: the authority's own transport, with the receipt `sync.submit` replies
   * with ({@link withReceipt}).
   */
  readonly submit?: OutboxSubmitPort
}

/**
 * Build (or rebuild) one principal's client over the given storage.
 *
 * Called again after a crash with the same `storage`, which is what makes the
 * recovery assertions honest: whatever the new kernels can see is exactly what
 * committed, never what a surviving object still held in memory.
 */
export async function openClient(options: ClientOptions): Promise<ConformanceClient> {
  const { authority, storage, principal, clock } = options
  await authority.resolveIdentity()
  const view = storage.viewFor(requireHuman(principal))
  const replicaEvents: ReplicaEvent[] = []
  const outboxEvents: OutboxEvent[] = []
  const storeUnreadable: unknown[] = []

  const outbox = await Outbox.open({
    store: view.outbox,
    submit: options.submit ?? withReceipt(authority, authority.transportFor(principal)),
    principal: requireHuman(principal),
    now: clock.now,
    maxAgeMs: MAX_AGE_MS,
    newMutationId: options.newMutationId,
    // REQUIRED by the port, and the suite needs it: ADR 2 D7 names an unreadable
    // outbox store as the SOLE case where user work is lost, and the loss must be
    // loud. Collecting it here is what lets a case assert the report happened rather
    // than assert that nothing crashed.
    onStoreUnreadable: (error) => {
      storeUnreadable.push(error)
    },
    onEvent: (event) => {
      outboxEvents.push(event)
    },
  })

  const overlay: OptimisticOverlayPort = {
    pending: (entity, entityId) =>
      outbox
        .pending()
        .filter((record) => record.partitionKey === keyOf(entity, entityId))
        .map(
          (record): PendingMutation => ({
            mutationId: record.mutationId,
            entity,
            entityId,
            command: record.command,
            // A4 — a provisional row an agent created is owned by its human, with the
            // agent as actor. Carried through, never synthesised: the Replica must not
            // be able to invent an attribution it was not handed.
            attribution: {
              onBehalfOf: record.attribution.onBehalfOf,
              actor: record.attribution.actor,
            },
          }),
        ),
    // Identity reducer. Nothing in this suite tests the overlay's arithmetic —
    // POD-372 owns that — so the faithful translation of "no change" is a `value`
    // effect carrying the unchanged base, NOT `no-reducer`, which would mean
    // something different (render as pending, change nothing) and quietly alter what
    // every scoped case exercises.
    reduce: (base) => ({ kind: 'value', value: base }),
    // Both halves are the outbox's own coverage rule (POD-6275), so they cannot
    // disagree about what a commit covers: `covers` decides, from memory, whether
    // the Replica opens a unit of work at all, and `retire` does the retiring
    // inside it.
    covers: (evidence) => outbox.isConfirmable(confirmationOf(evidence)),
    // RETURNED, not fired and forgotten. The Replica awaits this inside
    // `SyncUnitOfWork.transact`'s body, so the retirement enrols in the SAME
    // transaction as the entity operations and the cursor advance (ADR 2 D10). This
    // return value is the whole seam: before POD-1158 `retire` was `void`, and an
    // async store had no instant at which it could enrol.
    //
    // `confirm` covers an in-flight entry its provenance names (applied, then
    // retired), an applied entry whose receipt the cursor reaches, and, for an
    // install, a receipt from another epoch. All of it lands in this one draft.
    retire: async (evidence, span) => {
      await outbox.confirm(confirmationOf(evidence), span)
    },
  }

  const replica = new Replica({
    store: view.cache,
    authority: authority.portFor(principal),
    overlay,
    // The transaction boundary, owned by the physical store rather than by the
    // Replica. Required whenever an overlay is present: an overlay means a
    // multi-region commit is reachable, and one with no boundary is the D10
    // non-compliance, refused at construction.
    unitOfWork: storage.unitOfWork,
    onEvent: (event) => {
      replicaEvents.push(event)
    },
  })

  const client: ConformanceClient & {
    settle(): Promise<void>
    storeUnreadable: readonly unknown[]
  } = {
    principal,
    replica,
    outbox,
    view,
    replicaEvents,
    outboxEvents,
    storeUnreadable,
    /**
     * Drain everything in flight. `Replica.settled()` now covers the whole commit,
     * retirement included, because the retirement is enrolled in the replica's own
     * transaction — so a refused commit surfaces HERE as a rejection rather than
     * disappearing into a side array nobody awaits.
     */
    settle: async () => {
      await replica.settled()
    },
    recover: async () => await openClient(options),
  }
  return client
}

/**
 * The authority's transport, with the receipt the sync entry point replies with
 * (ADR 12 Decisions 1 and 2): the change-log head right after the call's commit.
 *
 * Without it every applied entry in this suite would be a receipt-less LEGACY entry,
 * which any confirmation retires, and the suite would exercise only the fallback
 * rule. The authority applies synchronously inside `submit`, so the head read after
 * it is exactly the call's covering seq.
 */
export function withReceipt(
  authority: ConformanceAuthority,
  inner: OutboxSubmitPort,
): OutboxSubmitPort {
  return {
    submit: async (envelope) => {
      const outcome = await inner.submit(envelope)
      if (outcome.kind !== 'applied') return outcome
      const receipt = { feedId: authority.feedId, epoch: authority.epoch, seq: authority.head() }
      return { ...outcome, receipt }
    },
  }
}

/** The narrowed handle most cases use. */
export type Client = Awaited<ReturnType<typeof openClient>> & {
  settle(): Promise<void>
  storeUnreadable: readonly unknown[]
}

/**
 * The mutation ids one retirement batch names, in order, absent ones dropped.
 *
 * The cast is through `unknown` because `MutationId` is a compile-time BRAND and these
 * ids arrived over the wire as plain strings — `ChangeProvenance.mutationId` is
 * declared `string` for exactly that reason. There is no run-time check a brand could
 * be given, so the honest spelling is one narrow, commented cast here rather than an
 * `as never` at each of the four call sites.
 */
export const mutationIdsOf = (
  matches: readonly { readonly mutationId?: MutationId; readonly causationId?: string }[],
): readonly MutationId[] =>
  matches
    .map((match) => match.mutationId ?? match.causationId)
    .filter((id): id is string => id !== undefined) as unknown as readonly MutationId[]

/**
 * The Replica's report of one commit, as the outbox's evidence. The two shapes are
 * the same facts on either side of the direction lint: the replica may not import
 * the outbox, so the integrator translates.
 */
export const confirmationOf = (evidence: RetirementEvidence): ConfirmationEvidence => ({
  confirmed: mutationIdsOf(evidence.matches),
  through: evidence.through,
  install: evidence.install,
})

/** The command every case enqueues. `offline-eligible` is the only enqueueable class. */
export function command(name = 'issues.close'): {
  readonly name: string
  readonly version: number
  readonly delivery: 'offline-eligible'
} {
  return { name, version: 1, delivery: 'offline-eligible' }
}

export interface WriteRequest {
  readonly entity: string
  readonly entityId: string
  readonly value: unknown
  readonly attribution?: OutboxAttribution
  readonly commandName?: string
}

/** Enqueue one write, attributed from the client's own principal unless overridden. */
export async function enqueueWrite(
  client: ConformanceClient,
  request: WriteRequest,
): Promise<OutboxRecord> {
  return await client.outbox.enqueue({
    command: command(request.commandName),
    input: { entity: request.entity, entityId: request.entityId, value: request.value },
    attribution: request.attribution ?? attributionOf(client.principal),
    partitionKey: keyOf(request.entity, request.entityId),
  })
}

/** What the replica's cache actually holds, as `entity:entityId` keys. */
export const sliceOf = (client: ConformanceClient): readonly string[] =>
  client.replica
    .entities()
    .map((record: EntityRecord) => keyOf(record.entity, record.entityId))
    .sort()

/** The next certified frame for this client, derived from its CURRENT cursor. */
export function nextFrame(authority: ConformanceAuthority, client: ConformanceClient): DeltaFrame {
  const cursor = client.replica.cursor
  return authority.frameFor(client.principal, cursor?.seq ?? 0)
}

/**
 * Pump the client until its cursor reaches the authority's head, or fail loudly.
 *
 * BOUNDED BY CONSTRUCTION (POD-1140): `Replica.settled()`'s own 50-drain guard is
 * defeated by microtask starvation, and a suite that loops on convergence without a
 * counter reproduces the failure where the whole lane emitted zero bytes and hung.
 * The bound is generous and the message names the state, so a real
 * non-terminating ladder reads as a defect rather than as a timeout.
 */
export async function pumpUntilCaughtUp(
  authority: ConformanceAuthority,
  client: Client,
  rounds = 20,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (client.replica.cursor?.seq === authority.head()) return
    const frame: ServerFrame = nextFrame(authority, client)
    await client.replica.receive(frame)
    await client.settle()
  }
  throw new Error(
    `did not catch up in ${rounds} rounds: cursor=${JSON.stringify(client.replica.cursor)} head=${authority.head()} posture=${client.replica.posture}`,
  )
}
