import { MobxPool } from '@podium/client-graph/pool'
import { MobileInbox } from '@podium/client-graph/mobile-triage'
import { IssueModel, SessionModel } from '@podium/client-graph/models'
import { autorun } from 'mobx'
import { cleanup, render, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ pool: null as MobxPool | null }))
vi.mock('../client/mobile-pool', () => ({ useMobilePool: () => state.pool }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push() {} }) }))
vi.mock('../components/SessionCard', () => ({
  SessionCard: ({ model, issue }: { model: { title: string }; issue?: { title: string } }) => (
    <p>
      {model.title} · {issue?.title}
    </p>
  ),
}))
const { InboxSessionRow } = await import('./InboxScreen')
afterEach(() => {
  cleanup()
  state.pool?.dispose()
  state.pool = null
})

it('mounts one displayed group without resolving other session or off-deck issue card fields', () => {
  const stamp = '2026-10-08T12:00:00Z'
  const pool = (state.pool = new MobxPool({ selectedIssueId: null, coarseNow: Date.parse(stamp) }))
  pool.apply({
    type: 'replace',
    rows: [
      ...['ask', 'work', 'idle'].map((id) => ({
        kind: 'session' as const,
        id,
        value: {
          sessionId: id,
          title: id,
          issueId: id,
          cwd: '/synthetic',
          agentKind: 'codex',
          status: 'live',
          createdAt: stamp,
          lastActiveAt: stamp,
          agentState: {
            phase: id === 'ask' ? 'needs_user' : id === 'work' ? 'working' : 'idle',
            since: stamp,
            idle: { kind: 'done' },
          },
        },
      })),
      ...['ask', 'work', 'idle'].map((id) => ({
        kind: 'issue' as const,
        id,
        value: {
          id,
          title: `Task ${id}`,
          seq: 1,
          stage: 'in_progress',
          repoPath: '/synthetic',
          createdAt: stamp,
          updatedAt: stamp,
        },
      })),
    ],
  })
  const inbox = new MobileInbox(pool),
    stop = autorun(() => {
      void inbox.groups
    })
  const displayedSessions: string[] = [],
    displayedIssues: string[] = []
  const sessionField = SessionModel.prototype.storedField,
    issueField = IssueModel.prototype.storedField
  const sessions = vi.spyOn(SessionModel.prototype, 'storedField').mockImplementation(function (
    this: SessionModel,
    field: string,
  ) {
    if (field === 'title') displayedSessions.push(this.id)
    return sessionField.call(this, field)
  })
  const issues = vi.spyOn(IssueModel.prototype, 'storedField').mockImplementation(function (
    this: IssueModel,
    field: string,
  ) {
    if (field === 'title') displayedIssues.push(this.id)
    return issueField.call(this, field)
  })
  try {
    const view = render(
      <>
        {inbox.groups.needsYou.map((id) => (
          <InboxSessionRow key={id} id={id} />
        ))}
      </>,
    )
    expect(view.container.textContent).toContain('ask · Task ask')
    expect(new Set(displayedSessions)).toEqual(new Set(['ask']))
    expect(new Set(displayedIssues)).toEqual(new Set(['ask']))
    act(() =>
      pool.apply({
        type: 'update',
        rows: [
          {
            kind: 'issue',
            id: 'ask',
            value: {
              id: 'ask',
              title: 'Live task title',
              seq: 1,
              stage: 'in_progress',
              repoPath: '/synthetic',
              createdAt: stamp,
              updatedAt: stamp,
            },
          },
        ],
      }),
    )
    expect(view.container.textContent).toContain('Live task title')
  } finally {
    sessions.mockRestore()
    issues.mockRestore()
    stop()
  }
})
