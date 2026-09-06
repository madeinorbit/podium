/**
 * THE MUTABLE-STATE MODELS, over an injected async persistence function that
 * parks on a barrier [POD-3248, spec §3.6, method step 14a].
 *
 * These are the failures the compiler cannot see at the flip. The ones that
 * need a write to be IN FLIGHT — parked between "the row was staged" and "the
 * row committed" — park it, because that gap does not exist today and those
 * sites are correct only because it does not: the persistence function is a
 * barrier the test releases by hand.
 *
 * The REFUSAL tests are deliberately sequential and say so where they stand:
 * a stale pinned version and a failed mutex holder are contracts about what a
 * caller may do AFTER a completed write, and parking one would prove nothing
 * the sequential form does not. Each case names the site shape it stands for.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { barrier, type Harness, openHarness, settle } from './harness'
import {
  DraftRegistry,
  LeasedState,
  StaleRevisionError,
  StaleVersionError,
  VersionedMutex,
} from './state-models'

interface IssueRow {
  readonly id: string
  readonly stage: string
  readonly revision: number
}

let harness: Harness | undefined
afterEach(async () => {
  const current = harness
  harness = undefined
  await current?.close()
})

describe('draft-then-install', () => {
  it('refuses the second install when the row moved while its write was in flight', async () => {
    // THE SITE: `issues/service/crud.ts` mutates the process-owned issue row,
    // persists, and restores the old values by assignment on failure. With an
    // await in the middle, two updates both read the same row, both mutate it,
    // and the loser's restore writes the WINNER's row back to a stale value —
    // silently, with both callers told they succeeded.
    const parked = [barrier(), barrier()]
    let persists = 0
    const registry = new DraftRegistry<IssueRow>(async (_id, next) => {
      const at = persists++
      await (parked[at] as ReturnType<typeof barrier>).wait()
      if (next.stage === 'never') throw new Error('unreachable')
    })
    registry.seed('i1', { id: 'i1', stage: 'review', revision: 1 })

    const first = registry.update('i1', (row) => ({ ...row, stage: 'shipping' }))
    const second = registry.update('i1', (row) => ({ ...row, stage: 'done' }))

    // Both read revision 1 before either persisted.
    expect(registry.snapshot('i1')).toEqual({ id: 'i1', stage: 'review', revision: 1 })

    parked[0]?.release()
    await first
    expect(registry.snapshot('i1')).toEqual({ id: 'i1', stage: 'shipping', revision: 2 })

    parked[1]?.release()
    await expect(second).rejects.toBeInstanceOf(StaleRevisionError)
    // The winner's row survives intact: the loser never touched it.
    expect(registry.snapshot('i1')).toEqual({ id: 'i1', stage: 'shipping', revision: 2 })
  })

  it('leaves the installed row untouched while the failing write is in flight, and after', async () => {
    // The rollback case, with nothing to roll back: the shared object was never
    // mutated, so there is no restore-by-assignment to get wrong. The write is
    // parked so the claim covers the gap as well as the outcome — a draft
    // installed eagerly would be observable HERE and restored by the time the
    // rejection arrives.
    const parked = barrier()
    const registry = new DraftRegistry<IssueRow>(async () => {
      await parked.wait()
      throw new Error('write failed')
    })
    const seeded = { id: 'i1', stage: 'review', revision: 1 }
    registry.seed('i1', seeded)
    const failing = registry.update('i1', (row) => ({ ...row, stage: 'shipping' }))

    await parked.reached()
    await settle()
    expect(registry.snapshot('i1'), 'nothing is installed while the write is in flight').toBe(
      seeded,
    )

    parked.release()
    await expect(failing).rejects.toThrow('write failed')
    expect(registry.snapshot('i1')).toBe(seeded)
  })
})

describe('write-lease-before-read', () => {
  it('keeps an in-memory read from observing a parked write, and never from missing it', async () => {
    // THE SITE: the aggregates in `relay.ts`'s SessionRegistry and the frame
    // caches — read outside any lease today because nothing could interleave.
    // The mirror is installed in the post-commit tail of the write's own lease,
    // so "committed" and "visible in memory" are one step.
    harness = openHarness()
    const parked = barrier()
    const state = new LeasedState<{ count: number }>(harness.executor, { count: 0 })
    const observed: number[] = []

    const write = state.update(
      (value) => ({ count: value.count + 1 }),
      async () => {
        await parked.wait()
      },
    )
    const read = state.read((value) => {
      observed.push(value.count)
    })

    await parked.reached()
    await settle()
    expect(observed, 'the read must be queued behind the open write').toEqual([])

    parked.release()
    await Promise.all([write, read])
    expect(observed).toEqual([1])
    expect(await state.read((value) => value.count)).toBe(1)
  })

  it('does not install the mirror when an ENCLOSING transaction rolls back', async () => {
    // The case that separates "install in the post-commit tail" from "assign
    // once the persist resolves", which look identical from a queued reader:
    // the update is a savepoint under somebody else's span, the span fails
    // after it, and the mirror must go down with it. Assigning at persist time
    // leaves the process holding a value no committed row backs.
    harness = openHarness()
    const state = new LeasedState<{ count: number }>(harness.executor, { count: 0 })
    const parked = barrier()
    const observed: number[] = []

    const failing = harness.executor.transact(async () => {
      await state.update(
        (value) => ({ count: value.count + 1 }),
        async () => {
          await parked.wait()
        },
      )
      throw new Error('enclosing span failed')
    })
    const read = state.read((value) => observed.push(value.count))

    await parked.reached()
    await settle()
    expect(observed, 'the reader is queued behind the enclosing span').toEqual([])

    parked.release()
    await expect(failing).rejects.toThrow('enclosing span failed')
    await read
    expect(observed, 'the mirror never went up for the queued reader').toEqual([0])
    expect(await state.read((value) => value.count)).toBe(0)
  })

  it('does not install the mirror when the write rolls back, in flight or after', async () => {
    harness = openHarness()
    const state = new LeasedState<{ count: number }>(harness.executor, { count: 0 })
    const parked = barrier()
    const observed: number[] = []

    const failing = state.update(
      (value) => ({ count: value.count + 1 }),
      async () => {
        await parked.wait()
        throw new Error('write failed')
      },
    )
    const read = state.read((value) => observed.push(value.count))

    await parked.reached()
    await settle()
    expect(observed, 'the reader is queued behind the failing write').toEqual([])

    parked.release()
    await expect(failing).rejects.toThrow('write failed')
    await read
    expect(observed).toEqual([0])
    expect(await state.read((value) => value.count)).toBe(0)
  })
})

describe('versioned mutex', () => {
  it('serialises mutations that have no transaction to hang off', async () => {
    // THE SITE: process-owned state with no database write of its own — a
    // registry rebuilt from several sources, a scheduler's in-memory plan.
    const mutex = new VersionedMutex()
    const parked = barrier()
    let value = 0
    const order: string[] = []

    const first = mutex.run(async () => {
      order.push('first:start')
      await parked.wait()
      value += 1
      order.push('first:end')
    })
    const second = mutex.run(async () => {
      order.push('second:start')
      // Reads the FIRST mutation's result, not the value it was queued with.
      value *= 10
      order.push('second:end')
    })

    await parked.reached()
    await settle()
    expect(order).toEqual(['first:start'])

    parked.release()
    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    expect(value).toBe(10)
    expect(mutex.version).toBe(2)
  })

  it('refuses a caller whose decision was taken at an older version', async () => {
    // DELIBERATELY SEQUENTIAL: the contract is about a decision taken before a
    // COMPLETED write, so the pinned version is stale by the time it is offered.
    // Parking a write here would prove nothing this does not.
    const mutex = new VersionedMutex()
    const pinned = mutex.version
    await mutex.run(async () => undefined)
    await expect(mutex.runIfUnchanged(pinned, async () => 'applied')).rejects.toBeInstanceOf(
      StaleVersionError,
    )
    expect(await mutex.runIfUnchanged(mutex.version, async () => 'applied')).toBe('applied')
  })

  it('does not poison the queue when one holder fails', async () => {
    // DELIBERATELY SEQUENTIAL: what is under test is the state of the tail AFTER
    // a holder has already failed.
    const mutex = new VersionedMutex()
    await expect(
      mutex.run(async () => {
        throw new Error('holder failed')
      }),
    ).rejects.toThrow('holder failed')
    expect(await mutex.run(async () => 'next')).toBe('next')
  })
})
