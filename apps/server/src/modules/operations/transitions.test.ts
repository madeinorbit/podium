import type { Operation, OperationStep } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyStepPatch,
  deadlineBreach,
  deadlineDue,
  inFlightStep,
  nextStep,
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
