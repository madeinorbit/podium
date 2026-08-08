/**
 * The board card's state line (POD-591).
 *
 * The line is `overflow-hidden` and never wraps, so RANK is the whole design:
 * what falls off the end must always be the least important thing on the card.
 * These assert the ranking itself, and that the Display-menu toggles still
 * change what the card says.
 */
import { describe, expect, it } from 'vitest'
import { makeIssue } from '@/lib/test-issue'
import {
  aheadCount,
  cardAge,
  issueCardStateSlots,
  issueStateWord,
  liveAgentCount,
} from './issue-card'
import { DEFAULT_DISPLAY } from './issues-display'

const badges = DEFAULT_DISPLAY.badges
const off = { labels: false, type: false, estimate: false, due: false, sessions: false }

describe('issueCardStateSlots — rank', () => {
  it('puts a deleted tombstone ahead of everything else about the row', () => {
    const issue = makeIssue({
      deletedAt: '2026-07-01T00:00:00.000Z',
      needsHuman: true,
      blocked: true,
    })
    expect(issueCardStateSlots(issue, { badges }).map((s) => s.kind)[0]).toBe('deleted')
  })

  it('ranks needs-you above blocked, blocked above live, live above merge', () => {
    const issue = makeIssue({
      needsHuman: true,
      blocked: true,
      sessionSummary: { total: 3, byPhase: { working: 2 } },
      gitState: {
        updatedAt: '2026-07-01T00:00:00.000Z',
        branch: 'issue/1',
        shared: false,
        ahead: 4,
        dirtyFiles: 0,
      },
    })
    expect(issueCardStateSlots(issue, { badges }).map((s) => s.kind)).toEqual([
      'needs-human',
      'blocked',
      'live',
      'merge',
    ])
  })

  it('ranks every state fact above the Display-menu badges', () => {
    const issue = makeIssue({
      needsHuman: true,
      labels: ['ui'],
      estimateMin: 30,
      dueAt: '2026-08-01T00:00:00.000Z',
    })
    const kinds = issueCardStateSlots(issue, { badges }).map((s) => s.kind)
    expect(kinds.indexOf('needs-human')).toBeLessThan(kinds.indexOf('labels'))
    expect(kinds).toEqual(['needs-human', 'labels', 'due', 'estimate'])
  })

  it('keeps type OFF the state line — it is identity, and it costs a whole row', () => {
    const bug = makeIssue({ type: 'bug' })
    expect(issueCardStateSlots(bug, { badges })).toEqual([])
  })

  it('says nothing about a task that has nothing to say', () => {
    expect(issueCardStateSlots(makeIssue({}), { badges: off })).toEqual([])
  })
})

describe('issueCardStateSlots — the Display toggles still change the card', () => {
  const issue = makeIssue({ labels: ['ui', 'perf'], estimateMin: 30 })

  it('drops each badge when its toggle is off', () => {
    expect(issueCardStateSlots(issue, { badges: off })).toEqual([])
  })

  it('keeps them when it is on', () => {
    expect(issueCardStateSlots(issue, { badges }).map((s) => s.kind)).toEqual([
      'labels',
      'estimate',
    ])
  })

  it('collapses labels past the dot cap into an overflow count', () => {
    const many = makeIssue({ labels: ['a', 'b', 'c', 'd', 'e'] })
    const slot = issueCardStateSlots(many, { badges }).find((s) => s.kind === 'labels')
    expect(slot).toMatchObject({ kind: 'labels', overflow: 2 })
    if (slot?.kind === 'labels') expect(slot.labels).toHaveLength(3)
  })
})

describe('liveAgentCount', () => {
  it('counts only sessions actually computing — attached-but-still is not live', () => {
    expect(
      liveAgentCount(makeIssue({ sessionSummary: { total: 5, byPhase: { idle: 4, working: 1 } } })),
    ).toBe(1)
    expect(liveAgentCount(makeIssue({ sessionSummary: { total: 5, byPhase: { idle: 5 } } }))).toBe(
      0,
    )
    expect(liveAgentCount(makeIssue({}))).toBe(0)
  })
})

describe('aheadCount', () => {
  const git = {
    updatedAt: '2026-07-01T00:00:00.000Z',
    branch: 'issue/1',
    dirtyFiles: 0,
  }

  it('reads the merge axis when there is one', () => {
    expect(aheadCount(makeIssue({ gitState: { ...git, shared: false, ahead: 7 } }))).toBe(7)
  })

  it('is zero on a shared checkout, where the merge axis is meaningless', () => {
    expect(aheadCount(makeIssue({ gitState: { ...git, shared: true, ahead: 7 } }))).toBe(0)
  })

  it('is zero when the probe has not run', () => {
    expect(aheadCount(makeIssue({}))).toBe(0)
  })
})

describe('issueStateWord — the one word a dense row has space for', () => {
  it('takes the top of the same ranked list the card walks', () => {
    expect(issueStateWord(makeIssue({ needsHuman: true }))).toEqual({
      text: 'needs you',
      tone: 'attention',
    })
    expect(
      issueStateWord(makeIssue({ sessionSummary: { total: 2, byPhase: { working: 2 } } })),
    ).toEqual({ text: '2 working', tone: 'live' })
  })

  it('is null when the row has nothing to say, so the suffix teaches something', () => {
    expect(issueStateWord(makeIssue({}))).toBeNull()
  })

  it('ignores the Display badges — a row is not a card', () => {
    expect(issueStateWord(makeIssue({ type: 'bug', labels: ['ui'] }))).toBeNull()
  })
})

describe('cardAge', () => {
  const now = Date.parse('2026-07-10T12:00:00.000Z')
  it('steps through the units the board scans by', () => {
    expect(cardAge('2026-07-10T11:59:30.000Z', now)).toBe('now')
    expect(cardAge('2026-07-10T11:20:00.000Z', now)).toBe('40m')
    expect(cardAge('2026-07-10T00:00:00.000Z', now)).toBe('12h')
    expect(cardAge('2026-07-07T12:00:00.000Z', now)).toBe('3d')
    expect(cardAge('2026-06-10T12:00:00.000Z', now)).toBe('4w')
    expect(cardAge('2024-07-10T12:00:00.000Z', now)).toBe('2y')
  })

  it('renders nothing for an unparseable stamp rather than NaN', () => {
    expect(cardAge('not-a-date', now)).toBe('')
  })
})
