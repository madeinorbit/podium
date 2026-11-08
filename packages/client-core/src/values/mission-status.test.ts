import { sessionWorkingFact } from '@podium/model/browser'
import { describe, expect, it } from 'vitest'
import { missionTaskBucket, tallyMissionBuckets } from './mission'

describe('mission task counts', () => {
  it.each([
    ['closed wins over working', { stage: 'done' }, true, true, 'done'],
    [
      'explicit close wins over shipping',
      { stage: 'shipping', closedReason: 'done' },
      true,
      true,
      'done',
    ],
    ['cancelled is excluded', { stage: 'done', closedReason: 'cancelled' }, true, true, null],
    ['duplicate is excluded', { stage: 'done', closedReason: 'duplicate' }, false, false, null],
    ['superseded is excluded', { stage: 'done', closedReason: 'superseded' }, true, false, null],
    ['proposal is excluded while computing', { stage: 'proposed' }, true, true, null],
    ['shipping works without a session', { stage: 'shipping' }, false, false, 'working'],
    ['backlog with a computing session', { stage: 'backlog' }, true, true, 'working'],
    ['review with a computing session', { stage: 'review' }, true, true, 'working'],
    ['backlog without history', { stage: 'backlog' }, false, false, 'todo'],
    ['blocked backlog without history', { stage: 'backlog', blocked: true }, false, false, 'todo'],
    ['blocked started work', { stage: 'in_progress', blocked: true }, true, false, 'waiting'],
    ['backlog with ended history', { stage: 'backlog' }, true, false, 'waiting'],
    ['planning without crew', { stage: 'planning' }, false, false, 'waiting'],
    ['review without crew', { stage: 'review' }, false, false, 'waiting'],
  ] as const)('%s', (_name, issue, started, working, expected) => {
    expect(missionTaskBucket(issue, started, working)).toBe(expected)
  })

  it.each([
    ['live', 'working', true],
    ['live', 'compacting', true],
    ['starting', 'idle', true],
    ['live', 'idle', false],
    ['live', 'needs_user', false],
    ['live', 'errored', false],
    ['hibernated', 'working', false],
    ['exited', 'working', false],
    ['live', 'ended', false],
  ] as const)('%s / %s uses the execution fact', (status, phase, working) => {
    const computes = sessionWorkingFact({ status, agentState: { phase } })
    expect(computes).toBe(working)
    expect(missionTaskBucket({ stage: 'in_progress' }, true, computes)).toBe(
      working ? 'working' : 'waiting',
    )
  })

  it('counts tasks once, excluding abandoned and proposed work', () => {
    expect(
      tallyMissionBuckets(['done', 'working', 'waiting', 'todo', null] as const, (x) => x),
    ).toEqual({ total: 4, done: 1, working: 1, waiting: 1, todo: 1 })
  })
})
