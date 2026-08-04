/**
 * THE BOOT DRAFT SWEEP READS THE SESSION LIST ONCE, NOT ONCE PER DRAFT (POD-1638).
 *
 * `listSessions()` is not a cheap accessor: it is the reader-scoped session
 * PROJECTION, and building it runs an authorization check and a display-ref
 * resolution per session — each of which hits SQLite. Live attribution caught
 * `SELECT * FROM issues WHERE id = ?` running 37121 times in ONE second, and the
 * caller stacks named this sweep: `reapLeakedDrafts` loops over every draft and
 * `reapIfEmptyDraft` rebuilt the whole projection inside that loop, so the cost
 * was drafts x sessions. On the live instance that is a multi-second freeze of
 * the server's single event loop, with no request traffic at all.
 *
 * WHAT IS ASSERTED IS THE CONSERVED QUANTITY — how many times the sweep asks for
 * the list — not how long it takes. A duration assertion would move with the
 * machine and pass on a fast one while the defect was still there.
 *
 * Every count assertion is paired with a BEHAVIOUR assertion on the same fixture
 * (which drafts survived, which were reaped, which sessions were detached), so a
 * sweep that got fast by no longer reaping anything fails here.
 */

import { asSessionId, type SessionMeta } from '@podium/model'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../../store'
import { type IssueDeps, IssueService } from './index'
import { issueTestPlumbing } from './test-plumbing'

const REPO = '/home/u/repo'

const sess = (id: string, issueId: string | null, status = 'live'): SessionMeta =>
  ({
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: 't',
    cwd: REPO,
    status,
    issueId,
    archived: false,
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    agentState: { phase: 'working', since: 't', nativeSubagentCount: 0 },
  }) as unknown as SessionMeta

function harness(sessions: SessionMeta[]) {
  const store = new SessionStore(':memory:')
  store.repos.addRepo(REPO, 'm-host')
  const listSessions = vi.fn(() => sessions)
  const setSessionIssueId = vi.fn((sessionId: string, issueId: string | null) => {
    const s = sessions.find((x) => x.sessionId === sessionId)
    if (s) (s as { issueId: string | null }).issueId = issueId
  })
  const broadcast = vi.fn()
  const deps = {
    store,
    listSessions,
    setSessionIssueId,
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: asSessionId('s1'), machine: 'm' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast,
    ...issueTestPlumbing((msg: unknown) => broadcast(msg)),
    setSessionArchived: vi.fn(),
    clearSessionOffer: vi.fn(),
    onWorktreesChanged: vi.fn(),
    now: () => '2026-06-30T00:00:00.000Z',
  } as unknown as IssueDeps
  return { store, svc: new IssueService(deps), listSessions, setSessionIssueId }
}

describe('reapLeakedDrafts session-list cost', () => {
  it('reads the session list once for a sweep over many drafts', () => {
    const { svc, listSessions } = harness([])
    const drafts = Array.from({ length: 25 }, () =>
      svc.createDraftFor(REPO, 'claude-code', undefined),
    )
    expect(drafts).toHaveLength(25)
    listSessions.mockClear()

    const reaped = svc.reapLeakedDrafts()
    // Captured BEFORE the behaviour assertions below: `svc.list()` reads the
    // session list too, and folding that into the sweep's count would compare
    // two different things.
    const readsFor25 = listSessions.mock.calls.length

    // Behaviour: every leaked empty draft is gone. Without this a sweep that
    // simply returned 0 would satisfy the count assertion below.
    expect(reaped).toBe(25)
    expect(svc.list(REPO).filter((i) => i.draft)).toHaveLength(0)

    // THE DEFECT IS THE SCALING, so that is what is asserted: sweeping 25
    // drafts must cost the same number of session reads as sweeping 1. A
    // threshold ("under N") would need retuning whenever the fixed tail
    // changes and would still pass a sweep that grew slower but still grew.
    const twice = harness([])
    for (let i = 0; i < 50; i++) twice.svc.createDraftFor(REPO, 'claude-code', undefined)
    twice.listSessions.mockClear()
    expect(twice.svc.reapLeakedDrafts()).toBe(50)

    expect(twice.listSessions.mock.calls.length).toBe(readsFor25)
  })

  it('still refuses to reap a draft a living session is attached to', () => {
    const { svc, listSessions } = harness([])
    const keep = svc.createDraftFor(REPO, 'claude-code', undefined)
    const go = svc.createDraftFor(REPO, 'claude-code', undefined)
    listSessions.mockReturnValue([sess('s-live', keep.id)])
    listSessions.mockClear()

    const reaped = svc.reapLeakedDrafts()

    expect(reaped).toBe(1)
    const left = svc.list(REPO).filter((i) => i.draft)
    expect(left.map((i) => i.id)).toEqual([keep.id])
    expect(left.map((i) => i.id)).not.toContain(go.id)
    // Whatever the pass reads, it reads once — never once per draft visited.
    expect(listSessions.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('detaches dead sessions from the drafts it reaps', () => {
    const { svc, listSessions, setSessionIssueId } = harness([])
    const draft = svc.createDraftFor(REPO, 'claude-code', undefined)
    listSessions.mockReturnValue([sess('s-dead', draft.id, 'exited')])
    listSessions.mockClear()

    expect(svc.reapLeakedDrafts()).toBe(1)
    expect(setSessionIssueId).toHaveBeenCalledWith('s-dead', null)
    expect(listSessions.mock.calls.length).toBeLessThanOrEqual(3)
  })
})
