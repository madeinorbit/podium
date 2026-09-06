/**
 * THE AWAITED FOLLOW-UP, PINNED [POD-3467, spec §3.3 mechanism 2, rules 49/51a].
 *
 * `PostCommitFollowUpPort` replaced `PostCommitEffectPort` because visibility
 * preparation may now yield: `Authority.broadcast` awaits `prepareBatch` before
 * a single subscriber is told anything. Widening the port bought exactly one
 * guarantee — A FAILING FINALIZATION SURFACES INSTEAD OF VANISHING — and a
 * guarantee nothing measures is a comment. Every case here is written so that
 * DROPPING AN AWAIT on the path
 *
 *     finalize → postCommit(step) → broadcast → prepareBatch
 *
 * turns it red. The awaits are load-bearing in both wirings, so both are
 * covered: unset `postCommit` (every client replica, where the follow-up runs
 * inline and the commit itself must reject) and a wired drain (the server,
 * where the failure surfaces out of the drain the transaction waits for).
 *
 * WHY A PREPARATION FAILURE AND NOT A SUBSCRIBER ONE. A subscriber throw is
 * deliberately isolated — the rows are already durable and one bad listener must
 * not fail a committed write. Preparation sits OUTSIDE that isolation on
 * purpose: an unresolved right is not a delivery that went wrong, it is a
 * question that was never answered, and answering it by delivering the row is
 * the unsafe direction. That asymmetry is what these cases hold in place.
 */

import { describe, expect, it } from 'vitest'
import { Authority } from './authority'
import type { ChangeLogReadRow, ScopedChange, StagedChangeSpec } from './change-lifecycle'
import type { ChangeLogStore } from '../change-log'
import {
  DeviceGradeNoAnchors,
  DeviceGradeUnscopedPolicy,
  DEVICE_GRADE_PRINCIPAL,
} from '../feed/visibility'
import type { EntityRef, FeedVisibilityPolicy, VisibilityAnchorPort } from '../feed/visibility'

/** The in-memory log of `authority.test.ts`, narrowed to what these cases need:
 *  they are about the BROADCAST side of a commit, so the transaction is a
 *  pass-through and rollback is somebody else's suite. */
function memoryStore() {
  const rows: ChangeLogReadRow[] = []
  let nextSeq = 1
  const store: ChangeLogStore = {
    async appendChanges(batch) {
      const seqs: number[] = []
      for (const r of batch) {
        rows.push({ seq: nextSeq, ...r })
        seqs.push(nextSeq)
        nextSeq += 1
      }
      return seqs
    },
    maxChangeSeq: async () => nextSeq - 1,
    minChangeSeq: async () => rows[0]?.seq ?? null,
    changesSince: async (cursor) => rows.filter((r) => r.seq > cursor),
    planChangePrune: async () => ({ thresholdSeq: 0 }),
    pruneChangeBatch: async () => 0,
    latestChangeStates: async () => rows,
  }
  return store
}

const upsert = (id: string): StagedChangeSpec => ({
  entity: 'session',
  entityId: id,
  op: 'upsert',
  value: { id },
})

const PREPARATION_FAILED = 'the visibility state could not be read'

/** An anchor port whose edge lookup REJECTS — the yielding half of preparation
 *  failing, which is the whole reason the port had to be widened. */
class UnreachableAnchors implements VisibilityAnchorPort {
  async visibilityEdge(): Promise<never> {
    throw new Error(PREPARATION_FAILED)
  }

  async currentValueOf(): Promise<undefined> {
    return undefined
  }
}

/** Rejects for the FIRST pass only, so a later batch can prove the tail was not
 *  poisoned by the failed one. */
class AnchorsFailingOnce implements VisibilityAnchorPort {
  private failed = false

  async visibilityEdge(): Promise<null> {
    if (!this.failed) {
      this.failed = true
      throw new Error(PREPARATION_FAILED)
    }
    return null
  }

  async currentValueOf(): Promise<undefined> {
    return undefined
  }
}

/**
 * Holds the FIRST pass's edge lookup open until it is released, and answers at
 * once after that. The gate is the only way to make two passes overlap now that
 * every step between them is a microtask: without it a later pass cannot get far
 * enough to overtake an earlier one, and an ordering case built on the old
 * synchronous reentrancy would pass whether the pipe ordered anything or not.
 */
class GatedAnchors implements VisibilityAnchorPort {
  private gate: Promise<void> | null

  constructor(gate: Promise<void>) {
    this.gate = gate
  }

  async visibilityEdge(): Promise<null> {
    const gate = this.gate
    this.gate = null
    if (gate) await gate
    return null
  }

  async currentValueOf(): Promise<undefined> {
    return undefined
  }
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

interface Wiring {
  visibility?: FeedVisibilityPolicy
  anchors?: VisibilityAnchorPort
  postCommit?: (step: () => Promise<void>, label: string) => void
}

function build(wiring: Wiring = {}) {
  const store = memoryStore()
  return new Authority({
    store,
    now: () => 1000,
    transact: async (fn) => await fn(),
    visibility: wiring.visibility ?? new DeviceGradeUnscopedPolicy(),
    anchors: wiring.anchors ?? new DeviceGradeNoAnchors(),
    ...(wiring.postCommit === undefined ? {} : { postCommit: wiring.postCommit }),
  })
}

/**
 * The server's drain, in the one respect these cases are about: mechanism 2
 * steps are AWAITED, and the first failure is what the transaction's caller
 * sees (`PostCommitRunner.drain`, apps/server). Reproduced rather than imported
 * because packages/sync does not depend on apps/server — and a double that
 * resolved without awaiting would make every case here vacuous, which is
 * precisely the mutation under test.
 */
function followUpDrain() {
  const steps: { step: () => Promise<void>; label: string }[] = []
  return {
    port: (step: () => Promise<void>, label: string) => void steps.push({ step, label }),
    labels: () => steps.map((s) => s.label),
    async drain(): Promise<void> {
      let failure: unknown
      while (steps.length > 0) {
        const entry = steps.shift() as (typeof steps)[number]
        try {
          await entry.step()
        } catch (error) {
          failure ??= error
        }
      }
      if (failure) throw failure
    },
  }
}

function collect(authority: Authority, into: ScopedChange[][]): void {
  authority.subscribe(DEVICE_GRADE_PRINCIPAL, (delivery) => {
    if (delivery.kind === 'batch') into.push([...delivery.changes])
  })
}

describe('a failing finalization surfaces instead of vanishing', () => {
  it('rejects the commit itself when no drain is wired', async () => {
    // WOULD CATCH: `await this.broadcast(...)` in `finalize`'s inline arm, or
    // `await delivery` in `broadcast`, becoming a bare call. Both leave the
    // rejection on a promise the tail already swallowed, and this commit
    // resolves 'committed' with nobody ever told and nobody ever informed.
    const authority = build({ anchors: new UnreachableAnchors() })
    const seen: ScopedChange[][] = []
    collect(authority, seen)

    await expect(
      authority.commit({ write: async () => 'ok', changes: () => [upsert('s1')] }),
    ).rejects.toThrow(PREPARATION_FAILED)
    expect(seen, 'no subscriber may be told from a pass that could not be prepared').toEqual([])
  })

  it('rejects a capture the same way', async () => {
    // `capture` and `reconcile` reach `finalize` by their own routes; the
    // guarantee is the path's, not one entry point's.
    const authority = build({ anchors: new UnreachableAnchors() })
    await expect(authority.capture([upsert('s1')])).rejects.toThrow(PREPARATION_FAILED)
  })

  it('surfaces through the drain when one is wired', async () => {
    // WOULD CATCH: the registered step dropping its own `await this.broadcast`.
    // The step would resolve, the drain would find nothing to report, and the
    // transaction would commit clean over a delivery pass that never ran.
    const drain = followUpDrain()
    const authority = build({ anchors: new UnreachableAnchors(), postCommit: drain.port })

    const outcome = await authority.commit({
      write: async () => 'ok',
      changes: () => [upsert('s1')],
    })

    // The write DID commit — the rows are durable and this is not a rollback.
    expect(outcome.outcome).toBe('committed')
    expect(drain.labels()).toEqual(['authority-broadcast'])
    await expect(drain.drain()).rejects.toThrow(PREPARATION_FAILED)
  })

  it('lets the next batch through after a failed one', async () => {
    // The tail must order passes, not inherit their failures: `broadcastTail`
    // takes the caught branch precisely so one unresolved pass does not deny
    // every pass after it.
    const authority = build({ anchors: new AnchorsFailingOnce() })
    const seen: ScopedChange[][] = []
    collect(authority, seen)

    await expect(authority.capture([upsert('s1')])).rejects.toThrow(PREPARATION_FAILED)
    await authority.capture([upsert('s2')])

    expect(seen.map((batch) => batch.map((c) => c.entityId))).toEqual([['s2']])
  })
})

/**
 * RULE 49 — the visibility snapshot, and WHICH WAY IT DRIFTS.
 *
 * `prepareBatch` reads the policy and the edges ONCE and every principal in the
 * pass is judged against that one reading. A snapshot that outlived its pass
 * would drift in exactly one direction: it would still say `visible` for a
 * grant that has since been revoked, and it would say it to a subscriber whose
 * right to the row is gone. That is the PERMITTING direction, so the snapshot
 * is resolved per pass and a preparation that cannot answer denies the pass.
 */
describe('the visibility snapshot never outlives its pass', () => {
  /** A policy whose batch snapshot is taken at prepare time, from state that
   *  can move between passes — a revocation, modelled at the seam it has to be
   *  observed through. */
  class RevocableSnapshotPolicy implements FeedVisibilityPolicy {
    readonly grade = 'device-unscoped' as const
    readonly prepared: number[] = []
    private revoked = false

    revoke(): void {
      this.revoked = true
    }

    async forBatch(refs: readonly EntityRef[]): Promise<FeedVisibilityPolicy> {
      this.prepared.push(refs.length)
      const visible = !this.revoked
      return { grade: this.grade, decide: () => ({ visible, reason: 'substrate' }) }
    }

    decide() {
      // Unreachable through a prepared pass, and deliberately the OPPOSITE
      // answer: if a pass ever fell back to the unprepared policy, these cases
      // would say so rather than agreeing by coincidence.
      return { visible: false, reason: 'substrate' } as const
    }
  }

  it('re-resolves the snapshot for every pass, so a revocation between them is observed', async () => {
    // WOULD CATCH a snapshot hoisted out of the pass — memoised on the
    // Authority, or prepared once for the tail rather than once per batch. The
    // second pass would answer from the first pass's rights and deliver a row
    // to a principal whose grant is gone.
    const policy = new RevocableSnapshotPolicy()
    const authority = build({ visibility: policy })
    const seen: ScopedChange[][] = []
    collect(authority, seen)

    await authority.capture([upsert('s1')])
    policy.revoke()
    await authority.capture([upsert('s2')])

    expect(policy.prepared, 'one preparation per pass, neither shared nor skipped').toEqual([1, 1])
    expect(seen.map((batch) => batch.map((c) => c.entityId))).toEqual([['s1'], []])
  })

  it('denies the whole pass rather than delivering part of it', async () => {
    // FAIL CLOSED, across principals: preparation is outside the per-subscriber
    // try/catch, so an unanswerable right cannot reach the first subscriber and
    // then stop at the second.
    const authority = build({ anchors: new UnreachableAnchors() })
    const first: ScopedChange[][] = []
    const second: ScopedChange[][] = []
    collect(authority, first)
    collect(authority, second)

    await expect(authority.capture([upsert('s1')])).rejects.toThrow(PREPARATION_FAILED)

    expect(first).toEqual([])
    expect(second).toEqual([])
  })
})

/**
 * THE ORDERED PIPE, UNDER THE PROMISE TAIL.
 *
 * `authority.test.ts` still owns the reentrancy case this pipe was built for,
 * but that fixture stopped DISCRIMINATING when the store went async: with every
 * step between two passes now a microtask, a reentrant commit can no longer
 * overtake the batch that caused it whether the tail chains or not, so the case
 * passes either way. It is kept — it is a real scenario and it must not regress
 * — and this is the case that measures the property, by holding the first pass's
 * preparation open so a second pass has somewhere to overtake it.
 */
describe('the broadcast tail keeps passes in append order', () => {
  it('delivers an overlapping batch behind the one still preparing', async () => {
    // WOULD CATCH `broadcast` starting its pass directly instead of chaining on
    // `broadcastTail`: the second batch prepares while the first is still gated,
    // reaches the subscriber first, and a delta client that applies
    // `seq !== cursor + 1 → heal` heals forever against a log that returns the
    // same rows in the same order.
    const gate = deferred()
    const authority = build({ anchors: new GatedAnchors(gate.promise) })
    const seen: ScopedChange[][] = []
    collect(authority, seen)

    const first = authority.capture([upsert('s1')])
    const second = authority.capture([upsert('s2')])
    gate.release()
    await Promise.all([first, second])

    expect(seen.map((batch) => batch.map((c) => c.entityId))).toEqual([['s1'], ['s2']])
  })
})
