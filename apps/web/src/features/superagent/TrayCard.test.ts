import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import { trayStateSegments } from './TrayCard'

const git = (over: Partial<NonNullable<ReturnType<typeof makeIssue>['gitState']>>) =>
  ({
    updatedAt: 't',
    branch: 'pod-105',
    shared: false,
    dirtyFiles: 0,
    ...over,
  }) as NonNullable<ReturnType<typeof makeIssue>['gitState']>

describe('trayStateSegments (§2.3-v3 machine-set state line)', () => {
  it('renders stage · ⎇ branch · N ahead · clean from real gitState fields only', () => {
    const segments = trayStateSegments(makeIssue({ stage: 'review', gitState: git({ ahead: 2 }) }))
    expect(segments).toEqual([
      { text: 'review' },
      { text: '⎇ pod-105' },
      { text: '2 ahead' },
      { text: 'clean' },
    ])
  })

  it('marks dirty files as a warning and prefers the attributed count on shared checkouts', () => {
    expect(trayStateSegments(makeIssue({ gitState: git({ dirtyFiles: 3 }) })).at(-1)).toEqual({
      text: '3 dirty',
      warn: true,
    })
    // Shared checkout with an attributed set: the task's own dirty count wins.
    expect(
      trayStateSegments(
        makeIssue({ gitState: git({ shared: true, dirtyFiles: 9, dirtyOwn: 1, ahead: 4 }) }),
      ),
    ).toEqual([
      { text: 'in progress' },
      { text: '⎇ pod-105' },
      // ahead is a merge-axis fact — suppressed on shared checkouts.
      { text: '1 dirty', warn: true },
    ])
  })

  it('degrades to the stage alone: no gitState, or a first probe still running', () => {
    expect(trayStateSegments(makeIssue({ stage: 'in_progress' }))).toEqual([
      { text: 'in progress' },
    ])
    expect(
      trayStateSegments(
        makeIssue({ gitState: git({ computing: true, updatedAt: '', branch: null }) }),
      ),
    ).toEqual([{ text: 'in progress' }])
  })
})
