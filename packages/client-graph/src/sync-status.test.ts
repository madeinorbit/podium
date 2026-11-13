import { describe, expect, it } from 'vitest'
import {
  catchUpPercent,
  HIDDEN_SYNC,
  type StableSync,
  type SyncCondition,
  type SyncDisplay,
  type SyncReplicaSignal,
  type SyncSignals,
  stepStableSync,
  syncCondition,
  syncReviewCount,
} from './sync-status'

const replica = (patch: Partial<SyncReplicaSignal> = {}): SyncReplicaSignal => ({
  phase: 'ready',
  attempt: 1,
  blocking: false,
  error: null,
  committedSeq: null,
  targetSeq: null,
  healFromSeq: null,
  ...patch,
})
const signals = (patch: Partial<SyncSignals> = {}): SyncSignals => ({
  connection: 'ok',
  replica: replica(),
  queued: 0,
  refused: 0,
  undelivered: 0,
  ...patch,
})

describe('syncCondition', () => {
  it('is null while everything is healthy', () => {
    expect(syncCondition(signals())).toBeNull()
  })

  it('ranks offline over every other condition', () => {
    expect(
      syncCondition(
        signals({
          connection: 'down',
          replica: replica({ phase: 'error', error: 'network' }),
          queued: 3,
        }),
      ),
    ).toBe('offline')
  })

  it('ranks paused over slow, slow over catching up, catching up over sending', () => {
    expect(
      syncCondition(
        signals({ connection: 'degraded', replica: replica({ phase: 'error', error: 'format' }) }),
      ),
    ).toBe('paused')
    expect(
      syncCondition(signals({ connection: 'degraded', replica: replica({ phase: 'updating' }) })),
    ).toBe('slow')
    expect(syncCondition(signals({ replica: replica({ phase: 'saving' }), queued: 2 }))).toBe(
      'catching-up',
    )
    expect(syncCondition(signals({ queued: 2 }))).toBe('sending')
  })

  it('leaves the first sync to the full-screen loader', () => {
    expect(
      syncCondition(signals({ replica: replica({ phase: 'downloading', blocking: true }) })),
    ).toBeNull()
    expect(
      syncCondition(
        signals({ replica: replica({ phase: 'error', error: 'network', blocking: true }) }),
      ),
    ).toBeNull()
  })

  it('does not treat a warm launch that has not started walking as catching up', () => {
    expect(
      syncCondition(signals({ replica: replica({ phase: 'reconnecting', attempt: 0 }) })),
    ).toBeNull()
  })

  it('sends an auth failure to sign-in rather than showing it as paused', () => {
    expect(
      syncCondition(signals({ replica: replica({ phase: 'error', error: 'auth' }) })),
    ).toBeNull()
  })

  it('does not call an offline replica phase a catch-up', () => {
    expect(syncCondition(signals({ replica: replica({ phase: 'offline' }) }))).toBeNull()
  })
})

describe('syncReviewCount', () => {
  it('adds refused changes and undelivered messages', () => {
    expect(syncReviewCount({ refused: 2, undelivered: 3 })).toBe(5)
    expect(syncReviewCount({ refused: 0, undelivered: 0 })).toBe(0)
  })
})

describe('catchUpPercent', () => {
  it('measures distance from the catch-up start to the fixed target', () => {
    expect(catchUpPercent(replica({ healFromSeq: 100, committedSeq: 162, targetSeq: 200 }))).toBe(
      62,
    )
    expect(catchUpPercent(replica({ healFromSeq: 100, committedSeq: 200, targetSeq: 200 }))).toBe(
      100,
    )
  })

  it('never invents a number without a start or a target', () => {
    expect(catchUpPercent(replica({ committedSeq: 162, targetSeq: 200 }))).toBeNull()
    expect(catchUpPercent(replica({ healFromSeq: 100, committedSeq: 162 }))).toBeNull()
    expect(catchUpPercent(replica({ healFromSeq: 100, targetSeq: 200 }))).toBeNull()
    expect(
      catchUpPercent(replica({ healFromSeq: 200, committedSeq: 200, targetSeq: 200 })),
    ).toBeNull()
  })

  it('stays inside 0..100', () => {
    expect(catchUpPercent(replica({ healFromSeq: 100, committedSeq: 250, targetSeq: 200 }))).toBe(
      100,
    )
  })
})

/** Drives the machine through a timeline of raw changes, honouring every deadline it asks for. */
function run(
  changes: ReadonlyArray<readonly [number, SyncCondition | null]>,
  until: number,
): Array<readonly [number, SyncDisplay]> {
  let state: StableSync = HIDDEN_SYNC
  let raw: SyncCondition | null = null
  let nextAt: number | null = null
  const seen: Array<readonly [number, SyncDisplay]> = []
  const queue = [...changes]
  const step = (now: number) => {
    const out = stepStableSync(state, raw, now)
    if (out.state.shown !== state.shown) seen.push([now, out.state.shown])
    state = out.state
    nextAt = out.nextAt
  }
  for (;;) {
    const change = queue[0]
    const due: number | null = nextAt
    if (change && (due === null || change[0] <= due)) {
      queue.shift()
      raw = change[1]
      step(change[0])
    } else if (due !== null && due <= until) {
      step(due)
    } else break
  }
  return seen
}

describe('stepStableSync', () => {
  it('never shows a catch-up shorter than the enter delay', () => {
    expect(
      run(
        [
          [0, 'catching-up'],
          [900, null],
        ],
        10_000,
      ),
    ).toEqual([])
  })

  it('holds a borderline catch-up for the minimum, then confirms', () => {
    expect(
      run(
        [
          [0, 'catching-up'],
          [1700, null],
        ],
        10_000,
      ),
    ).toEqual([
      [1500, 'catching-up'],
      [2100, 'up-to-date'],
      [3700, null],
    ])
  })

  it('shows a slow catch-up after the wait and confirms when it ends', () => {
    expect(
      run(
        [
          [0, 'catching-up'],
          [5200, null],
        ],
        10_000,
      ),
    ).toEqual([
      [1500, 'catching-up'],
      [5200, 'up-to-date'],
      [6800, null],
    ])
  })

  it('shows a failure at once', () => {
    expect(run([[0, 'paused']], 10_000)).toEqual([[0, 'paused']])
  })

  it('hands one condition to the next without a gap', () => {
    expect(
      run(
        [
          [0, 'offline'],
          [3000, 'sending'],
          [3400, null],
        ],
        10_000,
      ),
    ).toEqual([
      [1200, 'offline'],
      [3000, 'sending'],
      [3600, 'up-to-date'],
      [5200, null],
    ])
  })

  it('keeps the old condition until its minimum hold is over', () => {
    expect(
      run(
        [
          [0, 'paused'],
          [100, 'catching-up'],
        ],
        10_000,
      ),
    ).toEqual([
      [0, 'paused'],
      [600, 'catching-up'],
    ])
  })

  it('hides a recovered slow link without a confirmation', () => {
    expect(
      run(
        [
          [0, 'slow'],
          [2000, null],
        ],
        10_000,
      ),
    ).toEqual([
      [1200, 'slow'],
      [2000, null],
    ])
  })

  it('lets a confirmation run out while a new condition is still waiting', () => {
    expect(
      run(
        [
          [0, 'catching-up'],
          [2000, null],
          [2500, 'sending'],
        ],
        10_000,
      ),
    ).toEqual([
      [1500, 'catching-up'],
      [2100, 'up-to-date'],
      [3700, null],
      [4000, 'sending'],
    ])
  })

  it('restarts the wait when the condition flaps off and on before showing', () => {
    expect(
      run(
        [
          [0, 'sending'],
          [1000, null],
          [1200, 'sending'],
        ],
        10_000,
      ),
    ).toEqual([[2700, 'sending']])
  })
})
