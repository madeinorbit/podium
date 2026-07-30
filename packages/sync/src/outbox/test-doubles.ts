/**
 * In-memory implementations of the Outbox ports (ADR 6 D1: "Tests / private mode
 * / hard quota session — in-memory adapter of the same port"). They are shipped
 * from the package, not hidden in a test file, because POD-373's conformance
 * suite is parameterised by instantiation and this is the instantiation CI runs.
 */

import type { MutationId } from '@podium/protocol'
import type {
  OutboxApplyResult,
  OutboxEnvelope,
  OutboxStoreMutation,
  OutboxStorePort,
  OutboxSubmitOutcome,
  OutboxSubmitPort,
  OwnedSyncSpan,
  SyncSpan,
  SyncSpanParticipant,
  SyncUnitOfWork,
} from './ports'
import { SyncCommitConflict } from './ports'
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
  /** Flip to make a write reject — ADR 6 D4.4's quota denial, which must not
   *  partially apply. */
  failWrite: unknown | undefined
  writes = 0
  /**
   * `delayNextWrites` makes writes resolve OUT OF ORDER — the probe that caught the
   * original serialization bug, where two concurrent enqueues ended with memory
   * holding [m1, m2] while durable storage held only [m1].
   */
  delayNextWrites = 0

  /**
   * Held applies, for DETERMINISTIC two-writer races. `holdNextApplies(2)` parks the
   * next two applies at their start — after both callers have read and staged, which
   * is precisely the interleaving a sleep-based test would only sometimes hit — and
   * the returned function releases them.
   */
  private readonly waiters: (() => void)[] = []
  private holds = 0
  /**
   * TRANSACTION-LOCAL staging, one entry per span: the mutations that span has
   * enrolled, in order, and nothing else.
   *
   * This replaces an earlier keyed-undo design that mutated the shared store eagerly
   * and restored prior values on abort. Keyed undo fixed snapshot clobbering across
   * DISJOINT keys and still failed two ways on overlapping ones: another
   * transaction could read this span's uncommitted write (a dirty read) and then
   * have its own committed value deleted by this span's rollback; and restoring a
   * removed record by push changed durable ORDER, which D12's FIFO depends on.
   *
   * The only fix that closes both is isolation: an aborted transaction must never
   * have touched the store at all. So enrolled mutations are staged here, validated
   * against a transaction-local view, and published only when every one of them
   * validates again under a store-wide commit lock.
   */
  private readonly staged = new WeakMap<SyncSpan, OutboxStoreMutation[]>()
  /** Serializes commits for this physical store, so two spans cannot interleave
   *  validate-and-publish. */
  private commitLock: Promise<unknown> = Promise.resolve()

  constructor(initial: readonly OutboxRecord[] = []) {
    this.snapshot = JSON.stringify(initial)
  }

  async read(): Promise<readonly OutboxRecord[]> {
    if (this.failRead !== undefined) throw this.failRead
    return this.parse()
  }

  holdNextApplies(n: number): () => void {
    this.holds = n
    return () => {
      this.holds = 0
      const waiting = this.waiters.splice(0, this.waiters.length)
      for (const release of waiting) release()
    }
  }

  /**
   * Record-level apply with ATOMIC precondition checking — the version-check pattern
   * ADR 6 D4.6 asks adapters for.
   *
   * Without a span the check and the write happen together under the commit lock.
   * With one, the mutation is STAGED and validated against a transaction-local view
   * (live records plus this span's own pending mutations, so a span reads its own
   * writes and nobody else's), then re-validated and published at commit.
   *
   * The ORDER contract a real adapter owes holds throughout: a first `put` appends, a
   * replacing `put` keeps its position, `remove` deletes by id, and anything the
   * mutation does not mention is untouched.
   */
  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult> {
    if (this.failWrite !== undefined) throw this.failWrite
    const declared = new Set(mutation.expect.map((e) => e.mutationId))
    const undeclared = [
      ...(mutation.put ?? []).map((r) => r.mutationId),
      ...(mutation.remove ?? []),
    ].filter((id) => !declared.has(id))
    if (undeclared.length > 0) {
      throw new Error(`mutation touches ${undeclared.join(', ')} with no precondition`)
    }
    if (this.holds > 0) {
      this.holds -= 1
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    if (this.delayNextWrites > 0) {
      this.delayNextWrites -= 1
      await Promise.resolve()
      await Promise.resolve()
    }
    if (!span) {
      return await this.serialize(() => {
        const records = this.parse()
        const stale = conflictsOf(mutation, records)
        if (stale.length > 0) return { ok: false, conflicts: stale }
        this.publish(applyTo(records, mutation))
        return { ok: true }
      })
    }
    const pending = this.staged.get(span)
    if (pending) {
      // Validate against what this span will have produced so far: its own writes
      // are visible to it, and only to it.
      const view = pending.reduce(applyTo, this.parse())
      const stale = conflictsOf(mutation, view)
      if (stale.length > 0) return { ok: false, conflicts: stale }
      pending.push(mutation)
      return { ok: true }
    }
    const view = this.parse()
    const stale = conflictsOf(mutation, view)
    if (stale.length > 0) return { ok: false, conflicts: stale }
    const mutations: OutboxStoreMutation[] = [mutation]
    this.staged.set(span, mutations)
    // Two-phase enrolment on the ONE span type (POD-1146). This used to reach a
    // `enlist` method that existed on the concrete span and on no interface, via a
    // cast — the unified port names the same thing, so the cast is gone and the
    // validate/publish split is now the span's own protocol rather than this
    // adapter's private arrangement.
    let publishable: OutboxRecord[] | undefined
    span.join({
      prepare: () => {
        // Re-validate every staged mutation against CURRENT truth: another span may
        // have committed while this one was open. Nothing is written until all of
        // them pass, so an abort leaves the store byte-identical — including record
        // ORDER, which a restore-by-push undo could not promise.
        //
        // This is also what serializes two concurrent spans without a lock: the
        // whole prepare→publish sequence runs with no await in it, so a second span
        // cannot compute its post-state from a base the first has already
        // superseded. A real adapter has the same obligation for the same reason —
        // an await inside the transaction would close it (ADR 6 / D10).
        let next = this.parse()
        for (const staged of mutations) {
          const conflicts = conflictsOf(staged, next)
          if (conflicts.length > 0) throw new SyncCommitConflict([...conflicts])
          next = applyTo(next, staged)
        }
        publishable = next
      },
      publish: () => {
        // Cannot fail: everything that could refuse already did, in `prepare`.
        if (publishable !== undefined) this.publish(publishable)
        this.staged.delete(span)
      },
      discard: () => {
        this.staged.delete(span)
      },
    })
    return { ok: true }
  }

  /** Seed durable state directly — for crash simulations that need the store to
   *  contain something no live Outbox put there. */
  seed(records: readonly OutboxRecord[]): void {
    this.snapshot = JSON.stringify(records)
  }

  /** What a cold start would find — i.e. what actually survived. */
  durable(): readonly OutboxRecord[] {
    return this.parse()
  }

  private publish(records: readonly OutboxRecord[]): void {
    this.snapshot = JSON.stringify(records)
    this.writes += 1
  }

  private parse(): OutboxRecord[] {
    return JSON.parse(this.snapshot) as OutboxRecord[]
  }

  /** One commit at a time per physical store. */
  private async serialize<T>(work: () => T | Promise<T>): Promise<T> {
    const run = this.commitLock.then(work, work)
    this.commitLock = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }
}

/** Which of a mutation's preconditions do not hold against `records`. */
const conflictsOf = (
  mutation: OutboxStoreMutation,
  records: readonly OutboxRecord[],
): readonly MutationId[] =>
  mutation.expect
    .filter(({ mutationId, expect }) => {
      const held = records.find((r) => r.mutationId === mutationId)
      return expect === 'absent' ? held !== undefined : held?.state !== expect
    })
    .map((e) => e.mutationId)

/** Apply one record-level mutation, preserving insertion order. */
const applyTo = (
  records: readonly OutboxRecord[],
  mutation: OutboxStoreMutation,
): OutboxRecord[] => {
  const next = [...records]
  for (const id of mutation.remove ?? []) {
    const idx = next.findIndex((r) => r.mutationId === id)
    if (idx !== -1) next.splice(idx, 1)
  }
  for (const record of mutation.put ?? []) {
    const idx = next.findIndex((r) => r.mutationId === record.mutationId)
    if (idx === -1) next.push(record)
    else next[idx] = record
  }
  return next
}

/**
 * A real unit of work over the in-memory store — POD-369's amendment 3: the
 * in-memory adapter implements the same `SyncUnitOfWork` as the durable ones, so
 * the conformance suite exercises the atomic path rather than the degraded
 * one-transaction-per-write fallback.
 *
 * Enrolled writes are collected and applied together, so a failure anywhere in
 * the body leaves the store exactly as it was — and because participants adopt
 * only from `onCommit`, an abort needs no participant callback at all.
 */
export class InMemoryUnitOfWork implements SyncUnitOfWork {
  /** Spans opened, for asserting that participants shared ONE transaction. */
  spans = 0
  /** Set to make the durable commit fail, e.g. a quota denial mid-span. */
  failCommit: unknown | undefined
  /** Independent transactions run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()

  /**
   * Run one transaction. Independent calls are SERIALIZED — a call that arrives while
   * another body is suspended waits for it rather than joining it.
   *
   * There is deliberately no ambient "current span" to join. That was a real bug: a
   * process-wide current flag cannot tell lexical NESTING from an unrelated
   * CONCURRENT caller, so any `transact` reaching it mid-body was silently absorbed
   * into someone else's transaction — reporting success before durability and then
   * losing the acknowledged work when that unrelated transaction aborted. A
   * browser-portable unit of work cannot infer nesting from ambient state, which is
   * exactly why joining is expressed by THREADING THE SPAN explicitly
   * (`retireApplied(id, span)` → `store.apply(delta, span)`) instead.
   */
  async transact<T>(body: (span: SyncSpan) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const span = new InMemorySpan()
      this.spans += 1
      try {
        // `body` sees the span NARROWED to `SyncSpan`: participants enrol, and only
        // this opener settles.
        const result = await body(span)
        if (this.failCommit !== undefined) throw this.failCommit
        span.commit()
        return result
      } catch (error) {
        span.abort()
        throw error
      }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return await run
  }
}

/**
 * The unit of work's own span. `implements OwnedSyncSpan` and not `SyncSpan`: the
 * OPENER settles, and `transact` is the opener — the body only ever sees it
 * narrowed to `SyncSpan`, so no participant can commit or abort somebody else's
 * transaction (POD-1146).
 */
class InMemorySpan implements OwnedSyncSpan {
  private readonly participants: SyncSpanParticipant[] = []
  private readonly adoptions: (() => void)[] = []
  private state: 'open' | 'discarded' | 'published' = 'open'

  /**
   * Adapters enrol their durable work here; it lands only if the span commits.
   * `discard` drops a PRIVATE draft nobody has observed — it is not the abort hook
   * `onCommit` deliberately lacks, and it cannot make memory disagree with durable
   * truth in either direction. Rollback by restoring prior values is what let one
   * span's abort delete another span's committed row; staging until publish is what
   * replaced it.
   */
  join(participant: SyncSpanParticipant): void {
    if (this.state !== 'open') throw new Error('cannot join a span that has already settled')
    if (!this.participants.includes(participant)) this.participants.push(participant)
  }

  onCommit(adopt: () => void): void {
    if (this.state !== 'open') throw new Error('cannot enrol in a span that has already settled')
    this.adoptions.push(adopt)
  }

  commit(): void {
    if (this.state !== 'open') throw new Error('span already settled')
    try {
      // Every participant validates ALL of its store's staged mutations here, so a
      // refusal anywhere leaves every store untouched.
      for (const participant of this.participants) participant.prepare?.()
    } catch (error) {
      this.discardAll()
      throw error
    }
    this.state = 'published'
    for (const participant of this.participants) participant.publish()
    // Registration order, after the durable commit.
    for (const adopt of this.adoptions) adopt()
  }

  abort(): void {
    // Idempotent, so the `catch (…) { span.abort() }` idiom is always safe after a
    // vetoed commit, which is the normal error path.
    if (this.state === 'discarded') return
    if (this.state === 'published') throw new Error('cannot abort a span that already published')
    this.discardAll()
  }

  private discardAll(): void {
    // Dropping the span IS the whole rollback: nothing was published, because
    // participants stage until publish, and nothing was adopted, because adoption
    // only happens on commit.
    this.state = 'discarded'
    for (const participant of this.participants) participant.discard?.()
    this.adoptions.length = 0
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
