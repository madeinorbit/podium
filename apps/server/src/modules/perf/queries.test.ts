/**
 * THE `loop` SECTION OF `perf.snapshot` (loop-profile-levels design §7.2).
 *
 * The composition is in the query rather than in the `PerfRegistry` — the
 * registry is a hot-path recorder that owns neither the accounting handle nor
 * the hosts service — so the query is where the two properties live and where
 * they have to be pinned:
 *
 *  - at level `off` there IS no accounting handle, and the section is ABSENT
 *    rather than zeroed. A zeroed section claims a perfectly idle server, which
 *    is a measurement nobody took.
 *  - the fleet's minutes are read at CALL time, not captured when the family
 *    bundle was built, because every host metrics push changes them.
 */

import type { LoopMinuteWire, MachineId } from '@podium/model'
import type { LoopAccountingHandle, LoopAccountingSnapshot } from '@podium/runtime/loop-accounting'
import { describe, expect, it } from 'vitest'
import type { PerfState } from './commands'
import { PERF_QUERIES } from './queries'
import { PerfRegistry } from './registry'

const WINDOW = {
  at: 1_800_000_060_000,
  utilizationPct: 81,
  blockedMs: 40,
  stalls: 1,
  stallMaxMs: 40,
  heapUsedBytes: 1,
  rssBytes: 2,
  selfCostMs: 0.3,
}

const MINUTE = {
  at: '2026-09-10T12:01:00.000Z',
  component: 'server' as const,
  level: 'accounting' as const,
  utilizationPct: 81,
  blockedPct: 4,
  stalls: 1,
  stallP50Ms: 10,
  stallP99Ms: 20,
  stallMaxMs: 40,
  heapUsedBytes: 1,
  rssBytes: 2,
  selfCostPct: 0.1,
}

const DAEMON_MINUTE: LoopMinuteWire = { ...MINUTE, component: 'daemon' }

/** An accounting handle whose rings are whatever the test says they are. The
 *  real one needs a timer and `/proc`; what this query does with it is select. */
const handleWith = (snapshot: LoopAccountingSnapshot): LoopAccountingHandle =>
  ({
    snapshot: () => snapshot,
    stop: () => {},
    attribute: () => {},
    delaySnapshot: () => ({ p50: 0, p99: 0, max: 0 }),
    latestWindow: () => undefined,
    latestMinute: () => undefined,
  }) as unknown as LoopAccountingHandle

const stateWith = (over: Partial<PerfState> = {}): PerfState => ({
  perf: new PerfRegistry(),
  loopMinutes: () => ({}),
  ...over,
})

const snapshotOf = (state: PerfState) => PERF_QUERIES.snapshot.run(state, {})

describe('perf.snapshot loop section', () => {
  it('omits the section entirely when nothing is accounting', () => {
    const snapshot = snapshotOf(
      // Level `off`: the composition root passes no handle, because at `off`
      // `startLoopAccounting` installs no timer and there is no handle to pass.
      stateWith({
        loopMinutes: () => ({ 'box-1': DAEMON_MINUTE }) as Record<MachineId, LoopMinuteWire>,
      }),
    )
    expect(snapshot).not.toHaveProperty('loop')
    // The timings are unaffected — this section is additive.
    expect(snapshot.rpc).toEqual({})
    expect(snapshot.byPrincipal).toEqual({})
  })

  it("reports this server's rings and every daemon's latest minute", () => {
    const snapshot = snapshotOf(
      stateWith({
        loopAccounting: handleWith({
          level: 'accounting',
          component: 'server',
          windows: [WINDOW],
          minutes: [MINUTE],
        }),
        loopMinutes: () =>
          ({ 'box-1': DAEMON_MINUTE, 'box-2': DAEMON_MINUTE }) as Record<MachineId, LoopMinuteWire>,
      }),
    )
    expect(snapshot.loop).toEqual({
      level: 'accounting',
      server: { windows: [WINDOW], minutes: [MINUTE] },
      daemons: { 'box-1': DAEMON_MINUTE, 'box-2': DAEMON_MINUTE },
    })
  })

  it('reports an empty daemon map, not an absent section, when only the server is accounting', () => {
    // A single-machine install whose daemon has not completed its first minute.
    // The section is PRESENT — this server did measure — and `daemons` is empty,
    // which says "nobody has reported", not "nothing was measured anywhere".
    const snapshot = snapshotOf(
      stateWith({
        loopAccounting: handleWith({
          level: 'attribution',
          component: 'server',
          windows: [],
          minutes: [],
        }),
      }),
    )
    expect(snapshot.loop).toEqual({
      level: 'attribution',
      server: { windows: [], minutes: [] },
      daemons: {},
    })
  })

  it('reads the fleet minutes on every call, not once when the bundle was built', () => {
    // The hosts service map keeps changing under this query: a value captured at
    // service-selection time would report the fleet as it was at the first read
    // and never move again.
    let minutes: Record<string, LoopMinuteWire> = {}
    const state = stateWith({
      loopAccounting: handleWith({
        level: 'accounting',
        component: 'server',
        windows: [],
        minutes: [],
      }),
      loopMinutes: () => minutes as Record<MachineId, LoopMinuteWire>,
    })
    expect(snapshotOf(state).loop?.daemons).toEqual({})
    minutes = { 'box-1': DAEMON_MINUTE }
    expect(snapshotOf(state).loop?.daemons).toEqual({ 'box-1': DAEMON_MINUTE })
  })
})
