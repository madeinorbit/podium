import { describe, expect, it } from 'vitest'
import { buildActivityFeed, formatIssueEvent, type IssueEvent } from './issue-activity'

const ev = (over: Partial<IssueEvent>): IssueEvent => ({
  id: 1,
  ts: '2026-07-07T00:00:00.000Z',
  kind: 'issue.created',
  subject: 'i-1',
  repoPath: '/r',
  payload: {},
  ...over,
})

describe('formatIssueEvent', () => {
  it('labels issue.created', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.created' }))).toEqual({
      icon: 'created',
      text: 'created',
    })
  })

  it('labels issue.stage_changed with the human stage label', () => {
    expect(
      formatIssueEvent(ev({ kind: 'issue.stage_changed', payload: { to: 'review' } })),
    ).toEqual({ icon: 'moved', text: 'moved to Review' })
  })

  it('falls back to the raw stage when the target is unknown', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.stage_changed', payload: { to: 'weird' } }))).toEqual(
      { icon: 'moved', text: 'moved to weird' },
    )
  })

  // A row stored under the pre-POD-1074 spelling reads back as its canonical
  // ending, so the activity feed and the status menu say the same word.
  it('labels issue.closed with the reason, canonicalized', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.closed', payload: { reason: 'wontfix' } }))).toEqual({
      icon: 'closed',
      text: 'closed (cancelled)',
    })
  })

  it('defaults the close reason to done when absent', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.closed', payload: {} }))).toEqual({
      icon: 'closed',
      text: 'closed (done)',
    })
  })

  it('labels issue.started', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.started' }))).toEqual({
      icon: 'started',
      text: 'agent started',
    })
  })

  it('labels issue.session_attached', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.session_attached' }))).toEqual({
      icon: 'attached',
      text: 'agent attached',
    })
  })

  it('labels issue.cleaned', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.cleaned' }))).toEqual({
      icon: 'cleaned',
      text: 'worktree cleaned',
    })
  })

  it('labels issue.needs_human and its cleared counterpart', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.needs_human' }))).toEqual({
      icon: 'flagged',
      text: 'flagged for a human',
    })
    expect(formatIssueEvent(ev({ kind: 'issue.needs_human_cleared' }))).toEqual({
      icon: 'cleared',
      text: 'human flag cleared',
    })
  })

  it('labels issue.ready as unblocked', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.ready' }))).toEqual({
      icon: 'ready',
      text: 'unblocked',
    })
  })

  it('labels issue.integration, surfacing a blocked stop', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.integration', payload: { integrated: 3 } }))).toEqual(
      { icon: 'integration', text: 'integration ran' },
    )
    expect(formatIssueEvent(ev({ kind: 'issue.integration', payload: { blockedAt: 12 } }))).toEqual(
      { icon: 'integration', text: 'integration blocked at #12' },
    )
  })

  it('hides UI-sync and per-user read bookkeeping events', () => {
    for (const kind of ['issue.state', 'issue.panel', 'issue.read', 'issue.unread']) {
      expect(formatIssueEvent(ev({ kind })), kind).toBeNull()
    }
  })

  it('describes curation events as meaningful transitions', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.pinned', payload: { pinned: true } }))).toEqual({
      icon: 'generic',
      text: 'pinned',
    })
    expect(formatIssueEvent(ev({ kind: 'issue.pinned', payload: { pinned: false } }))).toEqual({
      icon: 'generic',
      text: 'unpinned',
    })
    expect(formatIssueEvent(ev({ kind: 'issue.archived' }))).toEqual({
      icon: 'generic',
      text: 'archived',
    })
    expect(formatIssueEvent(ev({ kind: 'issue.auto_archived' }))).toEqual({
      icon: 'generic',
      text: 'automatically archived',
    })
    expect(
      formatIssueEvent(
        ev({ kind: 'issue.snoozed', payload: { until: '2026-07-10T09:30:00.000Z' } }),
      ),
    ).toEqual({
      icon: 'generic',
      text: `snoozed until ${new Date('2026-07-10T09:30:00.000Z').toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    })
    expect(formatIssueEvent(ev({ kind: 'issue.unsnoozed' }))).toEqual({
      icon: 'generic',
      text: 'unsnoozed',
    })
  })

  it('renders an unknown kind generically, and marks it minor (POD-591)', () => {
    // Still rendered — a future event type is never silently dropped — but
    // flagged so a flood of them collapses instead of burying the transitions.
    expect(formatIssueEvent(ev({ kind: 'issue.snoozed_until' }))).toEqual({
      icon: 'generic',
      text: 'snoozed until',
      minor: true,
    })
  })

  it('never marks a known transition minor — those are what the feed is for', () => {
    for (const kind of [
      'issue.created',
      'issue.stage_changed',
      'issue.closed',
      'issue.started',
      'issue.session_attached',
      'issue.cleaned',
      'issue.needs_human',
      'issue.needs_human_cleared',
      'issue.ready',
      'issue.integration',
      'issue.pinned',
      'issue.archived',
      'issue.auto_archived',
      'issue.snoozed',
      'issue.unsnoozed',
    ]) {
      expect(formatIssueEvent(ev({ kind }))?.minor, kind).toBeUndefined()
    }
  })

  it('tolerates a null/non-object payload', () => {
    expect(formatIssueEvent(ev({ kind: 'issue.closed', payload: null }))).toEqual({
      icon: 'closed',
      text: 'closed (done)',
    })
  })
})

describe('buildActivityFeed', () => {
  const comments = [
    { author: 'me', body: 'first', createdAt: '2026-07-07T00:00:02.000Z' },
    { author: 'agent', body: 'later', createdAt: '2026-07-07T00:00:06.000Z' },
  ]
  const events: IssueEvent[] = [
    ev({ id: 10, kind: 'issue.created', ts: '2026-07-07T00:00:01.000Z' }),
    ev({ id: 11, kind: 'issue.state', ts: '2026-07-07T00:00:03.000Z' }),
    ev({
      id: 12,
      kind: 'issue.stage_changed',
      ts: '2026-07-07T00:00:04.000Z',
      payload: { to: 'review' },
    }),
  ]

  it('interleaves comments and events in chronological order', () => {
    const feed = buildActivityFeed(comments, events)
    expect(feed.map((i) => (i.kind === 'comment' ? `c:${i.body}` : `e:${i.line.text}`))).toEqual([
      'e:created',
      'c:first',
      'e:moved to Review',
      'c:later',
    ])
  })

  it('drops hidden events from the feed', () => {
    const feed = buildActivityFeed([], [
      ...events,
      ev({ id: 13, kind: 'issue.read', ts: '2026-07-07T00:00:05.000Z' }),
      ev({ id: 14, kind: 'issue.unread', ts: '2026-07-07T00:00:06.000Z' }),
    ])
    expect(feed.some((i) => i.kind === 'event' && i.line.text === 'issue.state')).toBe(false)
    expect(feed).toHaveLength(2)
  })

  it('gives every item a stable unique id', () => {
    const feed = buildActivityFeed(comments, events)
    const ids = feed.map((i) => i.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
