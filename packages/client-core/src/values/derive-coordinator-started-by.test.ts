// M6 coordinator elevate + started-by issue nesting (POD-902).
import { asSessionId, type UnbrandIds } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SessionView, SessionViewInput } from '../session-values'
import { elevateCoordinatorSession, type IssueNavigationModel, isCoordinatorSession, isDraftAgentVessel, orderTabs } from './index'

const NOW = Date.parse('2026-07-06T12:00:00.000Z')
const HOUR = 3_600_000

function sess(id: string, over: Partial<SessionViewInput> = {}): SessionView {
  return {
    sessionId: id,
    cwd: '/r/a',
    createdAt: new Date(NOW - 24 * HOUR).toISOString(),
    lastActiveAt: new Date(NOW - HOUR).toISOString(),
    agentKind: 'claude-code',
    status: 'live',
    busy: false,
    archived: false,
    title: id,
    ...over,
  } as unknown as SessionView
}

function issue(over: Partial<UnbrandIds<IssueNavigationModel>> = {}): IssueNavigationModel {
  return {
    id: 'i1',
    repoPath: '/r/a',
    seq: 1,
    title: 'Issue',
    description: '',
    stage: 'in_progress',
    worktreePath: null,
    branch: null,
    parentBranch: 'main',
    defaultAgent: 'claude-code',
    blockedByNotes: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-20T00:00:00.000Z',
    archived: false,
    needsHuman: false,
    intentOrigin: 'human' as const,
    audience: 'human' as const,
    isDraftVessel: false,
    childCount: 0,
    childDoneCount: 0,
    ...over,
  } as unknown as IssueNavigationModel
}

describe('elevateCoordinatorSession / isCoordinatorSession', () => {
  it('moves the coordinator to the front; no-op when unset or missing', () => {
    const a = sess('a')
    const b = sess('b')
    const c = sess('c')
    expect(elevateCoordinatorSession([a, b, c], asSessionId('b')).map((s) => s.sessionId)).toEqual([
      'b',
      'a',
      'c',
    ])
    expect(elevateCoordinatorSession([a, b, c], undefined)).toEqual([a, b, c])
    expect(elevateCoordinatorSession([a, b, c], asSessionId('gone'))).toEqual([a, b, c])
    expect(elevateCoordinatorSession([a, b, c], asSessionId('a')).map((s) => s.sessionId)).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('isCoordinatorSession matches the issue field', () => {
    const iss = issue({ coordinatorSessionId: 'coord' })
    expect(isCoordinatorSession(iss, asSessionId('coord'))).toBe(true)
    expect(isCoordinatorSession(iss, asSessionId('other'))).toBe(false)
    expect(isCoordinatorSession(issue(), asSessionId('coord'))).toBe(false)
  })

  it('orderTabs elevates coordinator ahead of arrival order', () => {
    const a = sess('a')
    const b = sess('b')
    const c = sess('c')
    const ordered = orderTabs([a, b, c], undefined, asSessionId('b'))
    expect(ordered.map((s) => s.sessionId)).toEqual(['b', 'a', 'c'])
  })
})

describe('isDraftAgentVessel', () => {
  it('returns false for a newly inserted normalized issue without a draft flag', () => {
    const fresh = issue()
    // The new-issue replay inserts a sparse projection before any draft flag
    // is present. The sidebar predicate must still produce a boolean.
    Reflect.deleteProperty(fresh, 'isDraftVessel')
    expect(isDraftAgentVessel(fresh, [sess('w')])).toBe(false)
  })

  it('is a draft with agents and no worktree of its own', () => {
    const draft = issue({ isDraftVessel: true })
    const worker = sess('w')
    expect(isDraftAgentVessel(draft, [worker])).toBe(true)
    // A draft that earned a worktree is real work; so is any non-draft; and an
    // agentless draft has no agent row to collapse into.
    expect(isDraftAgentVessel({ ...draft, worktreePath: '/r/a/wt' }, [worker])).toBe(false)
    expect(isDraftAgentVessel(issue(), [worker])).toBe(false)
    expect(isDraftAgentVessel(draft, [])).toBe(false)
  })
})
