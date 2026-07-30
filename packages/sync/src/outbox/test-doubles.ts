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
  SyncSpan,
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
  /**
   * Model a real adapter's ASYNCHRONOUS transaction by yielding between computing
   * the post-state and publishing it. Without this the double's commit is
   * synchronous end to end, which hides whether the commit lock does anything — a
   * real IndexedDB or SQLite transaction has that gap, so a test that needs the lock
   * to matter turns this on.
   */
  slowCommits = false

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
    const enlistable = span as SyncSpan & { enlist?: (w: () => Promise<void>) => void }
    enlistable.enlist?.(async () => {
      this.staged.delete(span)
      await this.serialize(async () => {
        // Re-validate every staged mutation against CURRENT truth: another span may
        // have committed while this one was open. Nothing is written until all of
        // them pass, so an abort leaves the store byte-identical — including record
        // ORDER, which a restore-by-push undo could not promise.
        let next = this.parse()
        for (const staged of mutations) {
          const conflicts = conflictsOf(staged, next)
          if (conflicts.length > 0) throw new SyncCommitConflict([...conflicts])
          next = applyTo(next, staged)
        }
        if (this.slowCommits) await Promise.resolve()
        this.publish(next)
      })
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
  private readonly writes: (() => Promise<void>)[] = []

  onCommit(adopt: () => void): void {
    this.commits.push(adopt)
  }

  /**
   * Adapters enroll their durable work here; it lands only if the span commits.
   * There is no undo hook, and there must not be one: a participant store stages
   * its mutations and publishes them only after all of them validate, so an aborted
   * span never wrote anything to un-write. Rollback by restoring prior values is
   * what let one span's abort delete another span's committed row.
   */
  enlist(write: () => Promise<void>): void {
    this.writes.push(write)
  }

  async commit(): Promise<void> {
    // Each enrolled publisher validates ALL of its store's staged mutations and
    // publishes them in one step, so a failure anywhere leaves that store untouched.
    for (const write of this.writes) await write()
    // Registration order after the durable commit.
    for (const effect of this.commits) effect()
  }

  async abort(): Promise<void> {
    // Dropping the span IS the whole rollback: nothing was published, because
    // participants stage until commit, and nothing was adopted, because adoption
    // only happens in `commit()`.
    this.writes.length = 0
    this.commits.length = 0
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
