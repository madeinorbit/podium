import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './service'
import { issueTestPlumbing } from './service/test-plumbing'
import { SessionStore } from '../../store'

// POD-723: allWire() memoizes each issue's built wire payload, keyed by that
// issue's own inputs (a generation counter bumped on any issue-side mutation +
// its member sessions' issue-relevant projections). A session-driven publish that
// only touches SOME issues' members must rebuild only those and reuse the rest.
function harness(sessions: SessionMeta[]) {
  const store = new SessionStore(':memory:')
  const broadcast = vi.fn()
  const deps: IssueDeps = {
    store,
    listSessions: () => sessions,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: { defaultParentBranch: '', mergeStyle: 'ff-only', autoRebaseBeforeMerge: true },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    ...issueTestPlumbing((msg) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    now: () => '2026-06-30T00:00:00.000Z',
  }
  return { store, svc: new IssueService(deps) }
}

const member = (sessionId: string, issueId: string, workState?: string): SessionMeta =>
  ({
    sessionId,
    agentKind: 'claude-code',
    title: 't',
    cwd: '/repo/w',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    archived: false,
    issueId,
    ...(workState ? { workState } : {}),
  }) as unknown as SessionMeta

describe('POD-723 dirty-scoped issue wire rebuild', () => {
  it('rebuilds only the issue whose member changed; reuses the cached payload for the rest', () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions)
    const i1 = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    const i2 = svc.create({ repoPath: '/repo', title: 'two', startNow: false }).id
    sessions.push(member('sess-1', i1, 'planning'))
    sessions.push(member('sess-2', i2, 'planning'))

    const first = svc.allWire()
    const w1a = first.find((w) => w.id === i1)!
    const w2a = first.find((w) => w.id === i2)!

    // A session-driven change on issue 1's member only (no issue-side mutation, so
    // the memo generation is stable — the classic publishIssues() re-derivation).
    sessions[0]!.workState = 'testing'

    const second = svc.allWire()
    const w1b = second.find((w) => w.id === i1)!
    const w2b = second.find((w) => w.id === i2)!

    // Issue 2 was untouched: same cached instance, no rebuild.
    expect(w2b).toBe(w2a)
    // Issue 1 rebuilt fresh and reflects the member's new work state.
    expect(w1b).not.toBe(w1a)
    expect(w1b.sessions[0]!.workState).toBe('testing')
  })

  it('an issue-row change republishes that issue (fresh payload)', () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions)
    const i1 = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    sessions.push(member('sess-1', i1))

    const w1a = svc.allWire().find((w) => w.id === i1)!
    svc.setLabels(i1, ['urgent'])
    const w1b = svc.allWire().find((w) => w.id === i1)!

    expect(w1b).not.toBe(w1a)
    expect(w1b.labels).toContain('urgent')
  })

  it('a member joining an issue rebuilds it (membership is part of the key)', () => {
    const sessions: SessionMeta[] = []
    const { svc } = harness(sessions)
    const i1 = svc.create({ repoPath: '/repo', title: 'one', startNow: false }).id
    const i2 = svc.create({ repoPath: '/repo', title: 'two', startNow: false }).id
    sessions.push(member('sess-2', i2))

    const w1a = svc.allWire().find((w) => w.id === i1)!
    // A new session attaches to issue 1 — no issue-side mutation.
    sessions.push(member('sess-1', i1))
    const w1b = svc.allWire().find((w) => w.id === i1)!

    expect(w1b).not.toBe(w1a)
    expect(w1b.sessions.map((s) => s.sessionId)).toContain('sess-1')
  })
})
