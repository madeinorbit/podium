import type { IssueWire, SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { buildWorkSections } from '../lib/work-sections'

const issue = (partial: Partial<IssueWire> & Pick<IssueWire, 'id' | 'repoPath' | 'stage'>) =>
  ({
    seq: 1,
    title: partial.id,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessions: [],
    archived: false,
    pinned: false,
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
    expect(sections[0]?.data.map((row) => row.issue.id)).toEqual(['active'])
    expect(sections[0]?.data[0]?.sessions.map((row) => row.sessionId)).toEqual(['agent'])
  })

  it('keeps a backlog issue visible while it owns a live agent', () => {
    const backlog = issue({ id: 'backlog', repoPath: '/src/podium', stage: 'backlog' })
    const agent = session({ sessionId: 'agent', issueId: 'backlog' })

    expect(buildWorkSections([backlog], [agent])[0]?.data[0]?.issue.id).toBe('backlog')
  })
})
