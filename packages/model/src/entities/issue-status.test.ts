import { describe, expect, it } from 'vitest'
import {
  ALL_ISSUE_STATUSES,
  canonicalIssueCloseReason,
  ISSUE_STATUS_LABELS,
  issueStatusIntent,
  issueStatusLabel,
  issueStatusMenuEntries,
  issueStatusOf,
  issueStatusOutcome,
  issueStatusValueOf,
  isTerminalIssueStatus,
  PICKABLE_ISSUE_STATUSES,
  parseIssueStatusValue,
} from './issue-status'

describe('close-reason canonicalization', () => {
  // The whole point of POD-1074: `wontfix` was our cancelled, under a word
  // nobody picked on purpose.
  it('reads the legacy spellings as cancelled', () => {
    expect(canonicalIssueCloseReason('wontfix')).toBe('cancelled')
    expect(canonicalIssueCloseReason('WontFix')).toBe('cancelled')
    expect(canonicalIssueCloseReason('canceled')).toBe('cancelled')
    expect(canonicalIssueCloseReason("won't fix")).toBe('cancelled')
  })

  it('passes the vocabulary through unchanged', () => {
    expect(canonicalIssueCloseReason('done')).toBe('done')
    expect(canonicalIssueCloseReason('cancelled')).toBe('cancelled')
    expect(canonicalIssueCloseReason('duplicate')).toBe('duplicate')
    expect(canonicalIssueCloseReason('superseded')).toBe('superseded')
  })

  // Null is a real answer, not a failure: the row IS closed and the caller
  // keeps the raw word rather than flattening it to "Done".
  it('returns null for a word outside the vocabulary', () => {
    expect(canonicalIssueCloseReason('shipped')).toBeNull()
    expect(canonicalIssueCloseReason('')).toBeNull()
    expect(canonicalIssueCloseReason(undefined)).toBeNull()
    expect(canonicalIssueCloseReason(null)).toBeNull()
  })
})

describe('status projection', () => {
  it('lets a recognized close reason win over the done stage', () => {
    expect(issueStatusOf({ stage: 'done', closedReason: 'cancelled' })).toBe('cancelled')
    expect(issueStatusOf({ stage: 'done', closedReason: 'wontfix' })).toBe('cancelled')
    expect(issueStatusOf({ stage: 'done', closedReason: 'duplicate' })).toBe('duplicate')
    expect(issueStatusOf({ stage: 'done', closedReason: 'done' })).toBe('done')
  })

  it('reads an open row as its stage', () => {
    expect(issueStatusOf({ stage: 'in_progress' })).toBe('in_progress')
    expect(issueStatusOf({ stage: 'review', closedReason: null })).toBe('review')
  })

  it('reads an unrecognized reason as closed, and shows the raw word', () => {
    expect(issueStatusOf({ stage: 'done', closedReason: 'shipped' })).toBe('done')
    expect(issueStatusLabel({ stage: 'done', closedReason: 'shipped' })).toBe('Shipped')
    expect(issueStatusLabel({ stage: 'done', closedReason: 'wontfix' })).toBe('Cancelled')
    expect(issueStatusLabel({ stage: 'planning' })).toBe('Planning')
  })
})

describe('outcome axis', () => {
  // What decides a glyph's colour: only `done` earns the success tick.
  it('separates completed from cancelled', () => {
    expect(issueStatusOutcome('done')).toBe('completed')
    expect(issueStatusOutcome('cancelled')).toBe('cancelled')
    expect(issueStatusOutcome('duplicate')).toBe('cancelled')
    expect(issueStatusOutcome('superseded')).toBe('cancelled')
    expect(issueStatusOutcome('review')).toBe('open')
  })

  it('calls every non-open status terminal', () => {
    const terminal = ALL_ISSUE_STATUSES.filter(isTerminalIssueStatus)
    expect(terminal).toEqual(['done', 'cancelled', 'duplicate', 'superseded'])
  })

  it('labels every status', () => {
    for (const status of ALL_ISSUE_STATUSES) expect(ISSUE_STATUS_LABELS[status]).toBeTruthy()
  })
})

describe('applying a picked status', () => {
  it('routes the lanes at a stage patch and the endings at a close', () => {
    expect(issueStatusIntent('review')).toEqual({ kind: 'stage', stage: 'review' })
    // Picking Done IS a close — it records a reason and runs the close guard.
    expect(issueStatusIntent('done')).toEqual({ kind: 'close', reason: 'done' })
    expect(issueStatusIntent('cancelled')).toEqual({ kind: 'close', reason: 'cancelled' })
  })

  it('refuses the two statuses a status control does not own', () => {
    expect(issueStatusIntent('proposed')).toBeNull()
    expect(issueStatusIntent('shipping')).toBeNull()
  })

  it('round-trips a menu value', () => {
    expect(parseIssueStatusValue(issueStatusValueOf({ stage: 'planning' }))).toEqual({
      kind: 'stage',
      stage: 'planning',
    })
    expect(
      parseIssueStatusValue(issueStatusValueOf({ stage: 'done', closedReason: 'duplicate' })),
    ).toEqual({ kind: 'close', reason: 'duplicate' })
  })

  // Menus emitted `close:wontfix` before POD-1074; a queued or bookmarked one
  // must still land, as cancelled.
  it('parses the legacy menu value', () => {
    expect(parseIssueStatusValue('close:wontfix')).toEqual({ kind: 'close', reason: 'cancelled' })
  })

  it('rejects a value it does not recognize', () => {
    expect(parseIssueStatusValue('stage:nonsense')).toBeNull()
    expect(parseIssueStatusValue('close:nonsense')).toBeNull()
    expect(parseIssueStatusValue('planning')).toBeNull()
  })
})

describe('the status menu', () => {
  it('offers the lanes, then the endings, with one rule between them', () => {
    const entries = issueStatusMenuEntries()
    expect(entries.map((entry) => entry.status)).toEqual([...PICKABLE_ISSUE_STATUSES])
    expect(entries.filter((entry) => entry.startsGroup).map((entry) => entry.status)).toEqual([
      'done',
    ])
  })

  it('names the endings as states, never as operations', () => {
    const labels = issueStatusMenuEntries().map((entry) => entry.label)
    expect(labels).toEqual([
      'Backlog',
      'Planning',
      'In Progress',
      'Review',
      'Done',
      'Cancelled',
      'Duplicate',
    ])
    expect(labels.some((label) => label.startsWith('Close'))).toBe(false)
    expect(labels).not.toContain('Wontfix')
  })

  it('gives every ending a hint and no lane one', () => {
    for (const entry of issueStatusMenuEntries()) {
      expect(entry.hint === undefined).toBe(!entry.terminal)
    }
  })
})
