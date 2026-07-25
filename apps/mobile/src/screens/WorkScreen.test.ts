import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildWorkSections } from '../lib/work-sections'

const issue = (
  partial: Partial<IssueWire> & Pick<IssueWire, 'id' | 'repoPath' | 'stage'>,
) =>
  ({
    seq: 1,
    title: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessions: [],
    archived: false,
    pinned: false,
    audience: 'human',
    ...partial,
  }) as IssueWire

const session = (partial: Partial<SessionMeta> & Pick<SessionMeta, 'sessionId' | 'issueId'>) =>
  ({
    agentKind: 'codex',
    archived: false,
    headless: false,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }) as SessionMeta

describe('buildWorkSections', () => {
  it('groups active issues by repo and nests only their visible agents', () => {
    const active = issue({ id: 'active', repoPath: '/src/podium', stage: 'in_progress' })
    const backlog = issue({ id: 'backlog', repoPath: '/src/podium', stage: 'backlog' })
    const proposed = issue({ id: 'proposed', repoPath: '/src/other', stage: 'proposed' })
    const agent = session({ sessionId: 'agent', issueId: 'active' })
    const shell = session({ sessionId: 'shell', issueId: 'active', agentKind: 'shell' })

    const sections = buildWorkSections([active, backlog, proposed], [agent, shell])

    expect(sections).toHaveLength(1)
    expect(sections[0]?.title).toBe('podium')
    expect(sections[0]?.data.map((row) => row.issue.id)).toEqual(['active', 'backlog'])
    expect(sections[0]?.data[0]?.sessions.map((row) => row.sessionId)).toEqual(['agent'])
  })

  it('keeps a backlog issue visible while it owns a live agent', () => {
    const backlog = issue({ id: 'backlog', repoPath: '/src/podium', stage: 'backlog' })
    const agent = session({ sessionId: 'agent', issueId: 'backlog' })

    expect(buildWorkSections([backlog], [agent])[0]?.data[0]?.issue.id).toBe('backlog')
  })

  it('puts pinned issues in a Pinned band and orders by sortKey', () => {
    const sections = buildWorkSections(
      [
        issue({
          id: 'b',
          repoPath: '/src/podium',
          stage: 'in_progress',
          sortKey: 'r',
          createdAt: '2026-01-03T00:00:00.000Z',
        }),
        issue({
          id: 'a',
          repoPath: '/src/podium',
          stage: 'in_progress',
          sortKey: 'c',
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        issue({
          id: 'pin',
          repoPath: '/src/other',
          stage: 'in_progress',
          pinned: true,
          sortKey: 'm',
        }),
      ],
      [],
    )

    expect(sections.map((s) => s.title)).toEqual(['Pinned', 'podium'])
    expect(sections[0]?.data.map((r) => r.issue.id)).toEqual(['pin'])
    expect(sections[1]?.data.map((r) => r.issue.id)).toEqual(['a', 'b'])
  })

  it('holds finished work open for tuck, then folds it into Closed', () => {
    const now = Date.parse('2026-07-20T12:00:00.000Z')
    const finished = issue({
      id: 'done',
      repoPath: '/src/podium',
      stage: 'done',
      closedReason: 'done',
      closedAt: '2026-07-20T11:00:00.000Z',
    })

    const open = buildWorkSections([finished], [], { now })
    expect(open[0]?.data[0]?.awaitsTuck).toBe(true)
    expect(open[0]?.closed).toEqual([])

    const tucked = buildWorkSections([finished], [], {
      now,
      tuckedIds: new Set(['done']),
    })
    expect(tucked[0]?.data).toEqual([])
    expect(tucked[0]?.closed.map((r) => r.issue.id)).toEqual(['done'])
  })

  it('nests sessions by recency and omits shell/headless/archived', () => {
    const work = issue({ id: 'work', repoPath: '/src/podium', stage: 'in_progress' })
    const [section] = buildWorkSections(
      [work],
      [
        session({ sessionId: 'old', issueId: 'work', lastActiveAt: '2026-07-20T12:00:00.000Z' }),
        session({
          sessionId: 'new',
          issueId: 'work',
          lastActiveAt: '2026-07-21T12:00:00.000Z',
        }),
        session({ sessionId: 'shell', issueId: 'work', agentKind: 'shell' }),
        session({ sessionId: 'headless', issueId: 'work', headless: true }),
        session({ sessionId: 'archived', issueId: 'work', archived: true }),
      ],
    )
    expect(section?.data[0]?.sessions.map((s) => s.sessionId)).toEqual(['new', 'old'])
  })

  it('hides agent-audience issues from top-level work navigation', () => {
    const sections = buildWorkSections(
      [
        issue({ id: 'human', repoPath: '/src/podium', stage: 'in_progress' }),
        issue({
          id: 'agent',
          repoPath: '/src/podium',
          stage: 'in_progress',
          audience: 'agent',
        }),
      ],
      [],
    )
    expect(sections[0]?.data.map((r) => r.issue.id)).toEqual(['human'])
  })
})
