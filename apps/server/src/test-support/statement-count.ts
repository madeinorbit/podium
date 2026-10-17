/**
 * PINNED STATEMENT COUNTS [POD-6149, server-data rule 8].
 *
 * An operation that runs a query per row is invisible in review and on small
 * test data. This harness runs ONE operation at a small and a large data size
 * and asserts both ran the same number of statements, and that the number is
 * the pinned constant. A query added inside a loop changes the large count and
 * fails at once; an added statement outside a loop changes the constant and
 * fails too, so the pin has to be moved on purpose, in review.
 *
 * It counts at the driver seam ({@link probeStatements}): every statement any
 * lane executes, after any statement cache and before the engine, including
 * batch members. That is the number a remote database would pay round trips
 * for, which is why it is the one pinned — not drizzle preparations, which the
 * prepared-once rule already pins (`prepared-loop-scaling.test.ts`).
 */

import { expect } from 'vitest'
import {
  probeStatements,
  type StatementObservation,
  type StatementProbeHolder,
} from '../store/executor/statement-probe'

/** What one operation ran. */
export interface StatementTally {
  /** Statements executed, batch members counted one by one. */
  readonly statements: number
  /** Statements per whitespace-folded SQL key, so a failure names the query. */
  readonly byQuery: ReadonlyMap<string, number>
}

/** Anything whose bun connection the probe can find: a `SessionStore`, or `{ db }`. */
export type ProbeTarget = StatementProbeHolder | object

/**
 * Count the statements `fn` runs on `target`'s connection.
 *
 * Only the operation's own statements: the probe is attached just before and
 * detached just after, and every statement observed in between is counted. A
 * test therefore must not leave background work (timers, unawaited writes)
 * running across the call.
 */
export async function countStatements<T>(
  target: ProbeTarget,
  fn: () => T | Promise<T>,
): Promise<{ result: T } & StatementTally> {
  const seen: StatementObservation[] = []
  const detach = probeStatements(target as StatementProbeHolder, (observation) => {
    seen.push(observation)
  })
  let result: T
  try {
    result = await fn()
  } finally {
    detach()
  }
  return { result, ...tallyOf(seen.map((observation) => observation.key)) }
}

/** A tally of statements given by their keys, one entry per execution. */
export function tallyOf(keys: readonly string[]): StatementTally {
  const byQuery = new Map<string, number>()
  for (const key of keys) byQuery.set(key, (byQuery.get(key) ?? 0) + 1)
  return { statements: keys.length, byQuery }
}

/** One operation measured at a given data size. */
export interface StatementPin<Fixture> {
  /** Named in failure messages. */
  readonly name: string
  /** Data sizes to compare. Default `[5, 200]`. */
  readonly sizes?: readonly [number, number]
  /** Build data of `size` rows. Its statements are not counted. */
  setup(size: number): Promise<Fixture>
  /** The connection to count on, read from the fixture. */
  target(fixture: Fixture): ProbeTarget
  /**
   * Count `run` some other way than on {@link target}'s connection: for an
   * operation that opens a connection of its own (the sync worker's read-only
   * snapshot), which the fixture cannot hand over before it runs [POD-6227].
   */
  count?(fixture: Fixture, run: () => unknown): Promise<{ result: unknown } & StatementTally>
  /** The operation. Only its statements are counted. */
  run(fixture: Fixture, size: number): unknown
  /** Optional result check at each size, so a pin cannot pass by doing nothing. */
  check?(result: unknown, fixture: Fixture, size: number): void | Promise<void>
  /** Release the fixture. */
  teardown?(fixture: Fixture): void | Promise<void>
}

export interface PinnedCounts {
  readonly small: StatementTally
  readonly large: StatementTally
}

/** Run `pin` at both sizes and return both tallies, asserting nothing. */
export async function measureAtSizes<Fixture>(pin: StatementPin<Fixture>): Promise<PinnedCounts> {
  const [smallSize, largeSize] = pin.sizes ?? [5, 200]
  const once = async (size: number): Promise<StatementTally> => {
    const fixture = await pin.setup(size)
    try {
      const run = () => pin.run(fixture, size)
      const counted = pin.count
        ? await pin.count(fixture, run)
        : await countStatements(pin.target(fixture), run)
      await pin.check?.(counted.result, fixture, size)
      return counted
    } finally {
      await pin.teardown?.(fixture)
    }
  }
  return { small: await once(smallSize), large: await once(largeSize) }
}

/** The queries whose count differs between two tallies, for a failure message. */
export function describeGrowth(small: StatementTally, large: StatementTally): string {
  const keys = new Set([...small.byQuery.keys(), ...large.byQuery.keys()])
  const lines: string[] = []
  for (const key of keys) {
    const a = small.byQuery.get(key) ?? 0
    const b = large.byQuery.get(key) ?? 0
    lines.push(`${a === b ? ' ' : '!'} ${a} -> ${b}  ${key}`)
  }
  return lines.sort().join('\n')
}

/**
 * Assert the operation runs `expected` statements at both sizes.
 *
 * Fails with every query and its count at both sizes, the growing ones marked
 * `!`, so the failure names the loop instead of only a number.
 */
export async function expectConstantStatements<Fixture>(
  pin: StatementPin<Fixture>,
  expected: number,
): Promise<PinnedCounts> {
  const counts = await measureAtSizes(pin)
  const [smallSize, largeSize] = pin.sizes ?? [5, 200]
  const detail = describeGrowth(counts.small, counts.large)
  expect(
    counts.large.statements,
    `${pin.name}: ${counts.small.statements} statements at ${smallSize} rows, ${counts.large.statements} at ${largeSize}\n${detail}`,
  ).toBe(counts.small.statements)
  expect(
    counts.small.statements,
    `${pin.name}: pinned at ${expected} statements, ran ${counts.small.statements}\n${detail}`,
  ).toBe(expected)
  return counts
}

/**
 * Prove a pin ARMED [POD-6227]: the same pin with a query per row planted on
 * the operation's own path must fail it.
 *
 * A pin passes trivially when its fixture's size never reaches the rows the
 * operation walks, or when the operation runs outside the counted window.
 * `plant` installs a spy on something the operation calls (a repository read,
 * a handler) that also runs one statement per row of the fixture, and returns
 * its restore. The pin must then fail with the growth message, which names a
 * size-dependent count, so the planted loop ran inside the window and the
 * fixture's size reached it.
 */
export async function expectArmed<Fixture>(
  pin: StatementPin<Fixture>,
  expected: number,
  plant: (fixture: Fixture, size: number) => () => void,
): Promise<void> {
  const planted: StatementPin<Fixture> = {
    ...pin,
    name: `${pin.name} (planted per-row loop)`,
    run: async (fixture, size) => {
      const restore = plant(fixture, size)
      try {
        return await pin.run(fixture, size)
      } finally {
        restore()
      }
    },
    // The planted loop is the point; a result check could fail first for a
    // reason that says nothing about the pin.
    check: undefined,
  }
  const [smallSize, largeSize] = pin.sizes ?? [5, 200]
  await expect(expectConstantStatements(planted, expected)).rejects.toThrow(
    new RegExp(`statements at ${smallSize} rows, \\d+ at ${largeSize}\\n`),
  )
}

/**
 * Stop the Shipping scheduler and finish its recovery pass before counting
 * [POD-6183]. A registry starts a 2-second scheduler tick when it is created
 * and a recovery pass when the host daemon connects, and awaits neither. At
 * the large size the setup outlasts one interval, so their order reads fell
 * inside the counted window on some runs and not others. The operations these
 * pins count never ship, so a fixture stops the timer and awaits one pass
 * (which runs after the connect pass on the executor's queue).
 */
export async function quietShipping(reg: {
  readonly shipping: { dispose(): void; reconcile(): Promise<void> }
}): Promise<void> {
  reg.shipping.dispose()
  await reg.shipping.reconcile()
}
