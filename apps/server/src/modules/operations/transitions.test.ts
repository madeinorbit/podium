import type { Operation, OperationStep } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyStepPatch,
  deadlineBreach,
  deadlineDue,
  inFlightStep,
  nextStep,
  restartPlaceClocks,
  withPersistenceFacts,
} from './transitions'

/** The operation arithmetic on its own, where a case needs no clock and no store. */

const step = (over: Partial<OperationStep> = {}): OperationStep => ({
  id: 'first',
  state: 'running',
  ...over,
})

const operation = (steps: OperationStep[]): Operation => ({
  id: 'op_1',
  kind: 'test',
  state: 'running',
  steps,
})

describe('applyStepPatch', () => {
  it('stamps the heartbeat on every patch, and only on the step named', () => {
    const next = applyStepPatch(
      operation([step(), step({ id: 'second', state: 'pending' })]),
      'first',
      { detail: 'downloading' },
      500,
    )
    expect(next.steps?.[0]).toMatchObject({ detail: 'downloading', lastProgressAt: 500 })
    expect(next.steps?.[1]?.lastProgressAt).toBeUndefined()
  })

  it('closes a step the moment the patch finishes it', () => {
    const next = applyStepPatch(operation([step()]), 'first', { state: 'done' }, 500)
    expect(next.steps?.[0]).toMatchObject({ state: 'done', finishedAt: 500 })
  })

  it('leaves a field it has no vocabulary for exactly where it found it', () => {
    const carried = { ...step(), aFieldAddedNextYear: 'keep me' } as OperationStep
    const next = applyStepPatch(operation([carried]), 'first', { state: 'done' }, 1)
    expect((next.steps?.[0] as Record<string, unknown>).aFieldAddedNextYear).toBe('keep me')
  })

  it('keeps unknown fields nested inside progress and inside a place (POD-2136 review)', () => {
    // The frozen law reaches all the way down: a patch that does not name
    // `progress` or `places` must not disturb what a newer server wrote there.
    const rich = {
      ...step(),
      progress: { done: 1, total: 3, bytesPerSecond: 900 },
      places: [{ id: 'm_a', state: 'downloading', eta: 42 }],
    } as OperationStep
    const next = applyStepPatch(operation([rich]), 'first', { detail: 'still going' }, 7)
    const patched = next.steps?.[0] as Record<string, unknown>
    expect(patched.progress).toEqual({ done: 1, total: 3, bytesPerSecond: 900 })
    expect((patched.places as Record<string, unknown>[])[0]).toEqual({
      id: 'm_a',
      state: 'downloading',
      eta: 42,
    })
  })

  it('replaces a value the patch DOES name, rather than merging it', () => {
    // Deliberate: progress is a report of how things stand now, and merging
    // would carry an older report's field forward as though it were current.
    const rich = {
      ...step(),
      progress: { done: 1, total: 3, bytesPerSecond: 900 },
    } as OperationStep
    const next = applyStepPatch(operation([rich]), 'first', { progress: { done: 2, total: 3 } }, 7)
    expect(next.steps?.[0]?.progress).toEqual({ done: 2, total: 3 })
  })

  it('lets `extra` overrule the heartbeat — the stall case', () => {
    // Noticing a stall is not progress, so the silence clock must not restart.
    const next = applyStepPatch(
      operation([step({ lastProgressAt: 10 })]),
      'first',
      { state: 'stalled' },
      900,
      (s) => ({ ...s, stalls: 1, lastProgressAt: 10 }),
    )
    expect(next.steps?.[0]).toMatchObject({ state: 'stalled', stalls: 1, lastProgressAt: 10 })
  })
})

describe('withPersistenceFacts', () => {
  it('prefers what the operation already says over the fallback', () => {
    const kept = withPersistenceFacts(
      { ...operation([]), exclusionGroup: 'lifecycle', createdAt: 7 },
      'maintenance',
      99,
    )
    expect(kept).toMatchObject({ exclusionGroup: 'lifecycle', createdAt: 7, updatedAt: 99 })
  })

  it('falls back to the kind when nothing else names a group', () => {
    expect(withPersistenceFacts(operation([]), undefined, 1).exclusionGroup).toBe('test')
  })
})

describe('finding the step in question', () => {
  it('watches the running one and plans the next unfinished one', () => {
    const op = operation([
      step({ id: 'a', state: 'done' }),
      step({ id: 'b', state: 'running' }),
      step({ id: 'c', state: 'pending' }),
    ])
    expect(inFlightStep(op)?.id).toBe('b')
    expect(nextStep(op)?.id).toBe('b')
  })

  it('treats a skipped step as finished and a stalled one as in flight', () => {
    const op = operation([step({ id: 'a', state: 'skipped' }), step({ id: 'b', state: 'stalled' })])
    expect(nextStep(op)?.id).toBe('b')
    expect(inFlightStep(op)?.id).toBe('b')
  })
})

describe('deadlines', () => {
  it('is due at whichever budget expires first', () => {
    const s = step({ startedAt: 0, lastProgressAt: 100 })
    expect(deadlineDue(s, { silenceMs: 50, totalMs: 1000 }, 100)).toBe(150)
    expect(deadlineDue(s, { silenceMs: 5000, totalMs: 1000 }, 100)).toBe(1000)
  })

  it('owes nothing when its kind set no budget', () => {
    expect(deadlineDue(step({ startedAt: 0 }), undefined, 0)).toBeUndefined()
    expect(deadlineDue(step({ startedAt: 0 }), {}, 0)).toBeUndefined()
  })

  it('reports silence only once the budget is actually spent', () => {
    const s = step({ startedAt: 0, lastProgressAt: 0 })
    expect(deadlineBreach(s, { silenceMs: 100 }, 99).kind).toBe('none')
    expect(deadlineBreach(s, { silenceMs: 100 }, 100).kind).toBe('silence')
  })

  it('prefers the total breach when both are over — the one with no retry wins', () => {
    // Otherwise a step that had already used its whole allowance would earn a
    // retry on its way out, and the total budget would mean nothing.
    const s = step({ startedAt: 0, lastProgressAt: 0 })
    expect(deadlineBreach(s, { silenceMs: 100, totalMs: 200 }, 500).kind).toBe('total')
  })

  it('measures silence from the last progress and the total from the start', () => {
    const breach = deadlineBreach(step({ startedAt: 0, lastProgressAt: 400 }), {}, 500)
    expect(breach).toMatchObject({ silentMs: 100, elapsedMs: 500, kind: 'none' })
  })
})

/**
 * PER-PLACE SILENCE (POD-2167). The step's own clock is stamped by any accepted
 * report, so for a step acting on several places at once it says only "somebody
 * spoke" — and a wave's healthy members will keep saying it right up until the
 * moment the wave ends. These cases are the arithmetic that replaces it.
 */
describe('a step is as silent as its quietest place', () => {
  const withPlaces = (
    places: Array<{ id: string; lastProgressAt?: number }>,
    over: Partial<OperationStep> = {},
  ): OperationStep => step({ startedAt: 0, lastProgressAt: 900, places, ...over })

  it('is judged on the OLDEST place, not on whoever spoke last', () => {
    // The step's own clock says 900 — a busy machine reporting a moment ago.
    // The one that stopped at 100 is what the budget is about.
    const s = withPlaces([{ id: 'busy', lastProgressAt: 900 }, { id: 'silent', lastProgressAt: 100 }])
    expect(deadlineDue(s, { silenceMs: 500 }, 900)).toBe(600)
    expect(deadlineBreach(s, { silenceMs: 500 }, 900)).toMatchObject({
      kind: 'silence',
      silentMs: 800,
    })
  })

  it('names the places whose own clocks ran out, and only those', () => {
    const s = withPlaces([
      { id: 'busy', lastProgressAt: 900 },
      { id: 'silent', lastProgressAt: 100 },
      { id: 'alsoSilent', lastProgressAt: 200 },
    ])
    expect(deadlineBreach(s, { silenceMs: 500 }, 900).places).toEqual(['silent', 'alsoSilent'])
  })

  it('ignores a place that makes no claim — a turn that has not come is not silence', () => {
    // `pending` and arrived places carry no stamp, which is how the kind says
    // the step is not waiting on them. Counting them would stall a healthy wave
    // the moment it grew larger than its own concurrency.
    const s = withPlaces([{ id: 'notYet' }, { id: 'busy', lastProgressAt: 900 }])
    expect(deadlineBreach(s, { silenceMs: 500 }, 900).kind).toBe('none')
  })

  it('falls back to the step when no place claims anything at all', () => {
    const s = withPlaces([{ id: 'notYet' }], { lastProgressAt: 100 })
    expect(deadlineDue(s, { silenceMs: 500 }, 900)).toBe(600)
    expect(deadlineBreach(s, { silenceMs: 500 }, 900).kind).toBe('silence')
  })

  it('names nobody on a total breach — that one is about the step', () => {
    const s = withPlaces([{ id: 'silent', lastProgressAt: 100 }])
    expect(deadlineBreach(s, { silenceMs: 500, totalMs: 800 }, 900)).toMatchObject({
      kind: 'total',
      places: [],
    })
  })
})

describe('restartPlaceClocks', () => {
  it('restarts the places the step is waiting on and invents no claim for the rest', () => {
    const places = [{ id: 'busy', lastProgressAt: 100 }, { id: 'notYet' }]
    expect(restartPlaceClocks(places, 900)).toEqual([
      { id: 'busy', lastProgressAt: 900 },
      { id: 'notYet' },
    ])
  })

  it('has nothing to say about a step with no places', () => {
    expect(restartPlaceClocks(undefined, 900)).toBeUndefined()
  })
})
