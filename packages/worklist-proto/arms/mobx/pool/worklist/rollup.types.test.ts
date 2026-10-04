/**
 * POD-4571 (Mb3) — the roll-up combines have no store handle, proved at
 * compile time, and they compose correctly, proved at run time.
 *
 * COMPILE TIME. `aggregate` receives exactly `{ own, children: Aggregate[] }`
 * and `unitsOf` exactly `{ children: { own, below }[] }`, and every value
 * that flows through them is plain data (booleans, numbers, strings, nested
 * plain records, arrays of them): no function, no Map or Set, no class
 * instance, so nothing reachable from an input can read a row or a relation.
 * Each `// @ts-expect-error` is a negative control (a store handle passed
 * beside the inputs, a store passed as a child, a function smuggled into an
 * aggregate): if the signature ever widens to accept it, the directive is
 * unused and `bun run typecheck -- --filter @podium/worklist-proto` fails.
 *
 * RUN TIME. The combine is order-free and composes: combining a subtree in
 * one step or level by level gives the same value (so an ancestor may reuse
 * a child's cached result), and a root reads the verdict for ITS kind from a
 * child's aggregate (an offer-only ask under a finished root is not waiting,
 * audit §3.3).
 */

import { describe, expect, it } from 'vitest'
import type { SliceIssue, SliceSession } from '@podium/client-graph/shared/slice-types'
import { combineSidebarSessions, NO_SIDEBAR_SESSIONS, sidebarSessionFacts } from '@podium/client-graph/worklist/sidebar-row'
import {
  type Aggregate,
  aggregate,
  askingOf,
  EMPTY_OWN,
  NO_UNIT,
  NO_UNITS,
  PENDING_UNIT,
  type PhaseFlags,
  type ProgressFacts,
  phaseOf,
  seatVerdictOf,
  type UnitOwn,
  type Units,
  type unitOwnOf,
  unitsOf,
  withSeat,
} from '@podium/client-graph/worklist/rollup'

// ------------------------------------------------------------ type helpers

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** True when `T` is plain data all the way down. */
type PlainData<T> = T extends string | number | boolean | null | undefined
  ? true
  : T extends (...args: never[]) => unknown
    ? false
    : T extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | WeakMap<object, unknown>
      ? false
      : T extends readonly (infer E)[]
        ? PlainData<E>
        : T extends object
          ? false extends { [K in keyof T]-?: PlainData<T[K]> }[keyof T]
            ? false
            : true
          : false

function assertType<T extends true>(): T | undefined {
  return undefined
}

// The exact inputs: nothing beside `own` and `children`.
assertType<
  Equal<
    Parameters<typeof aggregate>[0],
    { readonly own: Aggregate; readonly children: readonly Aggregate[] }
  >
>()
assertType<
  Equal<
    Parameters<typeof unitsOf>[0],
    { readonly children: readonly { readonly own: UnitOwn; readonly below: Units }[] }
  >
>()
assertType<Equal<Parameters<typeof aggregate>['length'], 1>>()
// A cold child gives progress exactly R-ROLL's own-row fields (coordinator condition 4).
assertType<Equal<ProgressFacts, Pick<SliceIssue, 'stage' | 'closedReason'>>>()
assertType<Equal<Parameters<typeof unitOwnOf>[0], ProgressFacts>>()
// Everything that flows through them is plain data.
assertType<PlainData<Aggregate>>()
assertType<PlainData<PhaseFlags>>()
assertType<PlainData<UnitOwn>>()
assertType<PlainData<Units>>()
assertType<PlainData<ReturnType<typeof aggregate>>>()
assertType<PlainData<ReturnType<typeof unitsOf>>>()
// The helper itself says no to a store-shaped value (so the lines above can fail).
// @ts-expect-error a function is not plain data
assertType<PlainData<{ read: () => unknown }>>()
// @ts-expect-error a Map is not plain data
assertType<PlainData<{ issues: Map<string, unknown> }>>()

interface StoreHandle {
  issues: Map<string, unknown>
  relations: { many(from: string, id: string, relation: string): Iterable<string> }
}
const store: StoreHandle = { issues: new Map(), relations: { many: () => [] } }

function negativeControls(): void {
  // @ts-expect-error no store beside the inputs
  aggregate({ own: EMPTY_OWN, children: [], store })
  // @ts-expect-error a store is not a child aggregate
  aggregate({ own: EMPTY_OWN, children: [store] })
  // @ts-expect-error an aggregate carries no function
  aggregate({ own: { ...EMPTY_OWN, read: () => store.issues }, children: [] })
  // @ts-expect-error no store beside the progress inputs
  unitsOf({ children: [], store })
  // @ts-expect-error a child's progress is values, not a relation reader
  unitsOf({ children: [{ own: NO_UNIT, below: NO_UNITS, relations: store.relations }] })
}
void negativeControls

// ------------------------------------------------------------ run time

function session(patch: Partial<SliceSession>): SliceSession {
  return {
    sessionId: 's',
    status: 'live',
    agentKind: 'claude-code',
    lastActiveAt: '2026-09-20T11:58:00Z',
    ...patch,
  } as SliceSession
}

const working = seatVerdictOf(
  session({ agentState: { phase: 'working', since: '2026-09-20T11:00:00Z' } }),
)
const offerOnly = seatVerdictOf(
  session({
    offer: { createdAt: '2026-09-20T11:40:00Z' },
    agentState: { phase: 'idle', idle: { kind: 'done' } },
  } as Partial<SliceSession>),
)
const question = seatVerdictOf(
  session({ agentState: { phase: 'idle', idle: { kind: 'question' } } } as Partial<SliceSession>),
)
const ended = seatVerdictOf(session({ agentState: { phase: 'ended' } } as Partial<SliceSession>))

// The own part places its seats' ids (POD-5423); `withSeat` folds flags and facts.
const one = (...seats: ReturnType<typeof seatVerdictOf>[]): Aggregate =>
  aggregate({
    own: { ...seats.reduce(withSeat, EMPTY_OWN), sessionIds: seats.map((seat) => seat.id as string) },
    children: [],
  })

describe('the roll-up combine', () => {
  it('borrows composed sidebar facts through a sessionless branch', () => {
    const facts = sidebarSessionFacts(session({ agentState: { phase: 'working', nativeSubagentCount: 3 } }))
    const before = structuredClone(facts)
    expect(combineSidebarSessions(NO_SIDEBAR_SESSIONS, facts)).toBe(facts)
    expect(combineSidebarSessions(facts, NO_SIDEBAR_SESSIONS)).toBe(facts)
    const exited = sidebarSessionFacts(session({ status: 'exited', agentState: { phase: 'ended', workingMsTotal: 20 } }))
    const combined = combineSidebarSessions(facts, exited)
    expect(combined.fleet).toBe(facts.fleet)
    expect(combined.totalMs).toBe(20)
    expect(facts).toEqual(before)
  })

  it('reads the root verdict from a child: an offer-only ask waits under an open root only', () => {
    const child = one(offerOnly)
    const root = aggregate({ own: EMPTY_OWN, children: [child] })
    expect(askingOf(root, false)).toBe(true)
    expect(phaseOf(root, false)).toBe('waiting')
    // The same cached child under a finished root: the offer is retired.
    expect(askingOf(root, true)).toBe(false)
    expect(phaseOf(root, true)).toBe('done')
    // A real question waits under either.
    const asked = aggregate({ own: EMPTY_OWN, children: [one(question)] })
    expect(askingOf(asked, true)).toBe(true)
  })

  it('composes level by level exactly as in one step, in any order', () => {
    const leaves = [one(working), one(offerOnly), one(ended), one(question)]
    const flat = aggregate({ own: EMPTY_OWN, children: leaves })
    const nested = aggregate({
      own: EMPTY_OWN,
      children: [
        aggregate({ own: EMPTY_OWN, children: [leaves[3] as Aggregate, leaves[0] as Aggregate] }),
        aggregate({ own: EMPTY_OWN, children: [leaves[2] as Aggregate, leaves[1] as Aggregate] }),
      ],
    })
    // Attention and recency compose independently of order; the UI payload
    // retains the caller's sibling order, as buildUnifiedRows does.
    const { sessionIds: flatSeats, sidebarFacts: flatSidebar, ...flatFacts } = flat
    const { sessionIds: nestedSeats, sidebarFacts: _nestedSidebar, ...nestedFacts } = nested
    expect(nestedFacts).toEqual(flatFacts)
    const reversed = aggregate({ own: EMPTY_OWN, children: [...leaves].reverse() })
    const { sessionIds: reversedSeats, sidebarFacts: _reversedSidebar, ...reversedFacts } = reversed
    expect(reversedFacts).toEqual(flatFacts)
    expect(flatSeats).toEqual([working, offerOnly, ended, question].map(seat => seat.id))
    expect(nestedSeats).toEqual([question, working, ended, offerOnly].map(seat => seat.id))
    expect(reversedSeats).toEqual([question, ended, offerOnly, working].map(seat => seat.id))
    const ordered = aggregate({ own: EMPTY_OWN, children: [
      aggregate({ own: EMPTY_OWN, children: leaves.slice(0, 2) }),
      aggregate({ own: EMPTY_OWN, children: leaves.slice(2) }),
    ] })
    expect(ordered.sidebarFacts).toEqual(flatSidebar)
  })

  it('waiting > working > done > queued, and only a finished row is done (spec §3.9)', () => {
    expect(phaseOf(one(working), false)).toBe('working')
    expect(phaseOf(one(ended), false)).toBe('queued')
    expect(phaseOf(one(ended), true)).toBe('done')
    expect(phaseOf(one(), true)).toBe('done')
    expect(phaseOf(one(), false)).toBe('queued')
    // §3.9 A: s1 working on A, s2 waiting (offer) on B under A.
    const a = aggregate({ own: one(working), children: [one(offerOnly)] })
    expect(phaseOf(a, false)).toBe('waiting')
    expect(a.working).toBe(true)
    expect(askingOf(a, false)).toBe(true)
  })

  it('sums pending markers and progress units up the chain', () => {
    const cold = { ...EMPTY_OWN, pending: 1 }
    expect(
      aggregate({ own: cold, children: [aggregate({ own: cold, children: [] })] }).pending,
    ).toBe(2)
    const unit: UnitOwn = { member: true, unit: true, done: true, solo: true, cold: false }
    const below = unitsOf({ children: [{ own: unit, below: NO_UNITS }] })
    expect(
      unitsOf({
        children: [
          { own: NO_UNIT, below },
          { own: unit, below: NO_UNITS },
        ],
      }),
    ).toEqual({
      members: 2,
      units: 2,
      done: 2,
      pending: 0,
      staffed: false,
      progress: { done: 2, run: 0, review: 0, stall: 0, block: 0, wait: 0 },
    })
    // A cold child is only its marker: its counts and anything handed as its
    // closure stay out until it lands, and the markers below sum up.
    const partial = unitsOf({
      children: [
        { own: PENDING_UNIT, below },
        { own: unit, below: { ...NO_UNITS, pending: 2 } },
      ],
    })
    expect(partial).toEqual({ members: 1, units: 1, done: 1, pending: 3,
      staffed: false, progress: { done: 1, run: 0, review: 0, stall: 0, block: 0, wait: 0 } })
  })
})
