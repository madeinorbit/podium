/**
 * PINNED ROUND TRIPS [POD-6992, POD-6958 design 2.11].
 *
 * The statement pins (`statement-count.ts`) hold how many statements an operation runs.
 * On hosted Postgres the cost is the round trips: the driver calls that wait for the
 * server, about 2.6 ms each. Pipelining (BEGIN with the first statement, the workspace
 * lock, batches, root writes) folds some statements together; the rest is one round trip
 * each. This pins that second number next to the first, with the same harness: one
 * operation at a small and a large data size, both the same count, equal to the pin.
 *
 * The count is the statement probe's round-trip model (`RoundTripObservation` in
 * `store/executor/statement-probe.ts`): the Postgres driver's pipelining applied to the
 * session calls the operation made. On a SQLite store it is what the operation would
 * cost on Postgres; `store/executor/round-trip-probe.pg.test.ts` holds the model equal
 * to the wire.
 */

import { expect } from 'vitest'
import {
  probeRoundTrips,
  probeStatements,
  type RoundTripObservation,
  type StatementProbeHolder,
} from '../store/executor/statement-probe'
import {
  describeGrowth,
  measureAtSizes,
  type ProbeTarget,
  type StatementPin,
  type StatementTally,
  tallyOf,
} from './statement-count'

/** What one operation cost in round trips, and in statements beside them. */
export interface RoundTripTally {
  readonly roundTrips: number
  readonly statements: number
  /** Round trips per call, so a failure names what waited. */
  readonly byCall: ReadonlyMap<string, number>
}

/** A round trip's line in a breakdown: the call, where it ran, and its first statement. */
export function describeTrip(trip: RoundTripObservation): string {
  const where = trip.root ? 'root' : (trip.lane ?? 'tx')
  const carried = trip.statements > 1 ? `[${trip.statements}]` : ''
  return `${trip.call}${carried} (${where})${trip.key === undefined ? '' : `: ${trip.key}`}`
}

/** Count the round trips and statements `fn` costs on `target`'s store. */
export async function countRoundTrips<T>(
  target: ProbeTarget,
  fn: () => T | Promise<T>,
): Promise<{ result: T } & RoundTripTally> {
  const trips: string[] = []
  let statements = 0
  const holder = target as StatementProbeHolder
  const detachTrips = probeRoundTrips(holder, (trip) => {
    trips.push(describeTrip(trip))
  })
  const detachStatements = probeStatements(holder, () => {
    statements += 1
  })
  let result: T
  try {
    result = await fn()
  } finally {
    detachTrips()
    detachStatements()
  }
  return { result, roundTrips: trips.length, statements, byCall: tallyOf(trips).byQuery }
}

/** A round-trip tally in the statement harness's shape, round trips in its count. */
function asTally(tally: RoundTripTally): StatementTally {
  return { statements: tally.roundTrips, byQuery: tally.byCall }
}

/**
 * Assert the operation costs `expected` round trips at both sizes. Fails with every call
 * and its count at both sizes, the growing ones marked `!`, as the statement pins do.
 */
export async function expectConstantRoundTrips<Fixture>(
  pin: StatementPin<Fixture>,
  expected: number,
): Promise<{ readonly small: StatementTally; readonly large: StatementTally }> {
  if (pin.count) {
    throw new Error(
      `${pin.name}: a pin that counts on a connection of its own has no round trips here`,
    )
  }
  const counts = await measureAtSizes({
    ...pin,
    count: async (fixture, run) => {
      const counted = await countRoundTrips(pin.target(fixture), run)
      return { result: counted.result, ...asTally(counted) }
    },
  })
  const [smallSize, largeSize] = pin.sizes ?? [5, 200]
  const detail = describeGrowth(counts.small, counts.large)
  expect(
    counts.large.statements,
    `${pin.name}: ${counts.small.statements} round trips at ${smallSize} rows, ${counts.large.statements} at ${largeSize}\n${detail}`,
  ).toBe(counts.small.statements)
  expect(
    counts.small.statements,
    `${pin.name}: pinned at ${expected} round trips, made ${counts.small.statements}\n${detail}`,
  ).toBe(expected)
  return counts
}
