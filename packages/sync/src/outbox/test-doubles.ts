/**
 * In-memory implementations of the Outbox ports (ADR 6 D1: "Tests / private mode
 * / hard quota session — in-memory adapter of the same port"). They are shipped
 * from the package, not hidden in a test file, because POD-373's conformance
 * suite is parameterised by instantiation and this is the instantiation CI runs.
 */

import type { MutationId } from '@podium/protocol'
import type {
  OutboxEnvelope,
  OutboxStoreMutation,
  OutboxStorePort,
  OutboxSubmitOutcome,
  OutboxSubmitPort,
  SyncSpan,
  SyncUnitOfWork,
} from './ports'
import type { OutboxRecord } from './records'

/**
 * A durable store you can crash and reopen.
 *
 * Records go in and out through a JSON round-trip on purpose: a real adapter
 * stores bytes, so anything that only survives by object identity (a class
 * instance, a `Map`, an `undefined`-valued key) fails here the same way it would
 * fail on device — which is the class of bug ADR 6 D4 exists to catch.
 */
export class InMemoryOutboxStore implements OutboxStorePort {
  private snapshot: string
  /** Flip to make `read` reject: ADR 2 D7's "genuinely unreadable" store, the
   *  one case where user work is lost and the loss must be loud. */
  failRead: unknown | undefined
  /** Flip to make `write` reject — ADR 6 D4.4's quota denial, which must not
   *  partially apply. */
  failWrite: unknown | undefined
  writes = 0

  constructor(initial: readonly OutboxRecord[] = []) {
    this.snapshot = JSON.stringify(initial)
  }

  async read(): Promise<readonly OutboxRecord[]> {
    if (this.failRead !== undefined) throw this.failRead
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }

  /**
   * `delayNextWrites` makes the store resolve writes OUT OF ORDER — the probe that
   * caught the original serialization bug, where two concurrent enqueues ended
   * with memory holding [m1, m2] while durable storage held only [m1].
   */
  delayNextWrites = 0

  /**
   * Record-level apply, with the ORDER contract a real adapter owes: a first
   * `put` appends, a replacing `put` keeps its position, `remove` deletes by id,
   * and anything unmentioned is UNTOUCHED. That last clause is the whole point —
   * it is what stops a writer holding a stale base from deleting another writer's
   * rows.
   */
  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<void> {
    if (this.failWrite !== undefined) throw this.failWrite
    const commit = (): void => {
      const records = this.parse()
      for (const id of mutation.remove ?? []) {
        const idx = records.findIndex((r) => r.mutationId === id)
        if (idx !== -1) records.splice(idx, 1)
      }
      for (const record of mutation.put ?? []) {
        const idx = records.findIndex((r) => r.mutationId === record.mutationId)
        if (idx === -1) records.push(record)
        else records[idx] = record
      }
      this.snapshot = JSON.stringify(records)
      this.writes += 1
    }
    if (this.delayNextWrites > 0) {
      this.delayNextWrites -= 1
      // Yield twice, so a caller that does not serialize will interleave.
      await Promise.resolve()
      await Promise.resolve()
    }
    // Enroll in the span when one is supplied: the change lands with the entity
    // rows and the cursor advance, or not at all (ADR 2 D10).
    const enlistable = span as
      | (SyncSpan & { enlist?: (w: () => Promise<void>) => void })
      | undefined
    if (enlistable?.enlist) {
      enlistable.enlist(async () => commit())
      return
    }
    commit()
  }

  /** Seed durable state directly — for crash simulations that need the store to
   *  contain something no live Outbox put there. */
  seed(records: readonly OutboxRecord[]): void {
    this.snapshot = JSON.stringify(records)
  }

  private parse(): OutboxRecord[] {
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }

  /** What a cold start would find — i.e. what actually survived. */
  durable(): readonly OutboxRecord[] {
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }
}

/**
 * A real unit of work over the in-memory store — POD-369's amendment 3: the
 * in-memory adapter implements the same `SyncUnitOfWork` as the durable ones, so
 * the conformance suite exercises the atomic path rather than the degraded
 * one-transaction-per-write fallback.
 *
 * `enrolled` collects every write in the span and applies them together, so a
 * failure anywhere in the body leaves the store exactly as it was and the
 * participants' `onAbort` reverts run.
 */
export class InMemoryUnitOfWork implements SyncUnitOfWork {
  /** Spans opened, for asserting that participants shared ONE transaction. */
  spans = 0
  /** Set to make the durable commit fail, e.g. a quota denial mid-span. */
  failCommit: unknown | undefined
  private depth = 0
  private current: InMemorySpan | undefined

  async transact<T>(body: (span: SyncSpan) => Promise<T>): Promise<T> {
    // Nested calls JOIN the ambient span rather than opening a second one.
    if (this.current) return await body(this.current)
    const span = new InMemorySpan()
    this.current = span
    this.spans += 1
    this.depth += 1
    try {
      const result = await body(span)
      if (this.failCommit !== undefined) throw this.failCommit
      await span.commit()
      return result
    } catch (error) {
      await span.abort()
      throw error
    } finally {
      this.depth -= 1
      if (this.depth === 0) this.current = undefined
    }
  }
}

class InMemorySpan implements SyncSpan {
  private readonly commits: (() => void)[] = []
  private readonly aborts: (() => void)[] = []
  private readonly writes: (() => Promise<void>)[] = []

  onCommit(effect: () => void): void {
    this.commits.push(effect)
  }

  onAbort(revert: () => void): void {
    this.aborts.push(revert)
  }

  /** Adapters enroll their durable work here; it lands only if the span commits. */
  enlist(write: () => Promise<void>): void {
    this.writes.push(write)
  }

  async commit(): Promise<void> {
    for (const write of this.writes) await write()
    // Registration order after the durable commit.
    for (const effect of this.commits) effect()
  }

  async abort(): Promise<void> {
    // Reverse order after the durable abort. No enrolled write was applied.
    for (const revert of [...this.aborts].reverse()) revert()
  }
}

/**
 * A scripted Authority.
 *
 * `respond` is a FUNCTION of the envelope and the attempt count, and the fake
 * holds no capability from the client: that is how the double mirrors ADR 3 D8 /
 * amendment D16 — rights are resolved live, at apply time, by the Authority, and
 * the envelope the client sends carries nothing that could pre-empt the
 * decision. A test revokes rights simply by changing the responder's mind
 * between drains.
 */
export class ScriptedAuthority implements OutboxSubmitPort {
  readonly envelopes: OutboxEnvelope[] = []
  private readonly attemptsById = new Map<string, number>()

  constructor(
    private respond: (
      envelope: OutboxEnvelope,
      attempt: number,
    ) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>,
  ) {}

  /** Swap the policy mid-test — e.g. un-share a collaborator while a client is
   *  offline with queued writes (readiness §2, the central multi-user risk). */
  reprogram(
    respond: (
      envelope: OutboxEnvelope,
      attempt: number,
    ) => OutboxSubmitOutcome | Promise<OutboxSubmitOutcome>,
  ): void {
    this.respond = respond
  }

  attempts(mutationId: MutationId): number {
    return this.attemptsById.get(mutationId) ?? 0
  }

  async submit(envelope: OutboxEnvelope): Promise<OutboxSubmitOutcome> {
    this.envelopes.push(envelope)
    const attempt = (this.attemptsById.get(envelope.mutationId) ?? 0) + 1
    this.attemptsById.set(envelope.mutationId, attempt)
    return await this.respond(envelope, attempt)
  }
}

/** A hand-cranked clock. Fixed sleeps flake; advancing time explicitly does not. */
export class ManualClock {
  constructor(private t = 1_700_000_000_000) {}
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}

/** Sequential ids, so a test can assert on an exact re-issued id. */
export const sequentialMutationIds = (prefix = 'm'): (() => MutationId) => {
  let n = 0
  return () => {
    n += 1
    return `${prefix}${n}` as MutationId
  }
}
