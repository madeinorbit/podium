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
   * Held applies, for DETERMINISTIC two-writer races. `holdNextApplies(2)` parks the
   * next two applies at their start — after both callers have read and staged, which
   * is precisely the interleaving that a sleep-based test would only sometimes hit —
   * and the returned function releases them.
   */
  private readonly waiters: (() => void)[] = []
  private holds = 0
  /**
   * Per-transaction KEYED undo: for every key a span touched, the value that key
   * held before the span first touched it (`undefined` = it was absent).
   *
   * Deliberately not a whole-store snapshot. A snapshot-restore rollback is wrong
   * whenever two transactions run against one store: restoring it would delete
   * rows another transaction committed in the meantime, which is precisely the
   * clobbering the keyed-delta design exists to prevent. The rollback has to be
   * keyed for the same reason the writes are.
   */
  private readonly spanUndo = new WeakMap<SyncSpan, Map<MutationId, OutboxRecord | undefined>>()

  holdNextApplies(n: number): () => void {
    this.holds = n
    return () => {
      this.holds = 0
      const waiting = this.waiters.splice(0, this.waiters.length)
      for (const release of waiting) release()
    }
  }

  /**
   * Record-level apply with ATOMIC precondition checking — the version-check
   * pattern ADR 6 D4.6 asks adapters for.
   *
   * `expect` is evaluated against the state the store holds AT APPLY TIME, in the
   * same step as the write, so two instances that read the same base cannot both
   * win: the loser gets `{ ok: false, conflicts }` and nothing of its mutation
   * lands. The ORDER contract a real adapter owes also holds: a first `put`
   * appends, a replacing `put` keeps its position, `remove` deletes by id, and
   * anything unmentioned is UNTOUCHED.
   */
  async apply(mutation: OutboxStoreMutation, span?: SyncSpan): Promise<OutboxApplyResult> {
    if (this.failWrite !== undefined) throw this.failWrite
    // An adapter obligation, asserted here so the in-memory instantiation holds
    // callers to it: every key the mutation touches must carry a precondition. A
    // mutation that omits one is an unconditional apply wearing a typed coat.
    const declared = new Set(mutation.expect.map((e) => e.mutationId))
    const touched = [
      ...(mutation.put ?? []).map((r) => r.mutationId),
      ...(mutation.remove ?? []),
    ].filter((id) => !declared.has(id))
    if (touched.length > 0) {
      throw new Error(`mutation touches ${touched.join(', ')} with no precondition`)
    }
    if (this.holds > 0) {
      this.holds -= 1
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    if (this.delayNextWrites > 0) {
      this.delayNextWrites -= 1
      // Yield twice, so a caller that does not serialize will interleave.
      await Promise.resolve()
      await Promise.resolve()
    }
    const conflicts = (): readonly MutationId[] =>
      (mutation.expect ?? [])
        .filter(({ mutationId, expect }) => {
          const held = this.parse().find((r) => r.mutationId === mutationId)
          return expect === 'absent' ? held !== undefined : held?.state !== expect
        })
        .map((e) => e.mutationId)
    const commit = (): OutboxApplyResult => {
      const stale = conflicts()
      if (stale.length > 0) return { ok: false, conflicts: stale }
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
      return { ok: true }
    }
    // Enroll in the span when one is supplied: the change — and its precondition
    // check — lands with the entity rows and the cursor advance, or not at all
    // (ADR 2 D10). A precondition that fails at commit ABORTS the span, because by
    // then there is no caller left to hand a conflict back to.
    const enlistable = span as
      | (SyncSpan & { enlist?: (w: () => Promise<void>, undo?: () => void) => void })
      | undefined
    if (enlistable?.enlist) {
      const key = span as SyncSpan
      let undo = this.spanUndo.get(key)
      if (!undo) {
        undo = new Map()
        this.spanUndo.set(key, undo)
      }
      const priors = undo
      enlistable.enlist(
        async () => {
          // Record each touched key's prior value FIRST — at the moment the write
          // actually lands, so it reflects what other transactions have committed
          // by then — then apply.
          const held = this.parse()
          for (const id of [
            ...(mutation.put ?? []).map((r) => r.mutationId),
            ...(mutation.remove ?? []),
          ]) {
            if (!priors.has(id))
              priors.set(
                id,
                held.find((r) => r.mutationId === id),
              )
          }
          const outcome = commit()
          if (!outcome.ok) {
            // TYPED, not generic: a commit-time conflict is an ordinary
            // concurrent-writer outcome that participants resolve by re-staging.
            throw new SyncCommitConflict([...outcome.conflicts])
          }
        },
        () => {
          const records = this.parse()
          for (const [id, prior] of priors) {
            const idx = records.findIndex((r) => r.mutationId === id)
            if (prior === undefined) {
              if (idx !== -1) records.splice(idx, 1)
            } else if (idx === -1) records.push(prior)
            else records[idx] = prior
          }
          this.snapshot = JSON.stringify(records)
        },
      )
      return { ok: true }
    }
    return commit()
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
  private readonly undos: (() => void)[] = []

  onCommit(adopt: () => void): void {
    this.commits.push(adopt)
  }

  /**
   * Adapters enroll their durable work here; it lands only if the span commits.
   * `undo` restores the participant store's PRE-SPAN state and is what makes this a
   * real unit of work: applying enrolled writes in sequence with no way to undo one
   * already applied is a partially committed transaction, which ADR 2 D10 forbids.
   */
  enlist(write: () => Promise<void>, undo?: () => void): void {
    this.writes.push(write)
    if (undo) this.undos.push(undo)
  }

  async commit(): Promise<void> {
    const applied: number[] = []
    try {
      for (let i = 0; i < this.writes.length; i++) {
        await (this.writes[i] as () => Promise<void>)()
        applied.push(i)
      }
    } catch (error) {
      // A LATE failure — a precondition that could only be checked here — must not
      // leave earlier enrolled writes applied.
      for (const undo of [...this.undos].reverse()) undo()
      throw error
    }
    // Registration order after the durable commit.
    for (const effect of this.commits) effect()
  }

  async abort(): Promise<void> {
    // Nothing to do: no enrolled write was applied, and no participant adopted
    // anything, because adoption only happens in `commit()`. Dropping the span is
    // the whole rollback.
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
