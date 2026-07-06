import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './issues'
import { SessionStore } from './store'

// issue-as-workspace: attachSession / drafts / origin persistence (spec
// docs/superpowers/specs/2026-07-06-issue-as-workspace-design.md).

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const issueBySession = new Map<string, string | null>()
  const deps: IssueDeps = {
    store,
    listSessions: () =>
      sessions.map((s) => ({
        ...s,
        ...(issueBySession.get(s.sessionId) ? { issueId: issueBySession.get(s.sessionId)! } : {}),
      })),
    getSettings: () =>
      ({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }) as never,
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast: vi.fn(),
    now: () => '2026-07-06T00:00:00.000Z',
    getSessionIssueId: (sessionId) => issueBySession.get(sessionId) ?? null,
    setSessionIssueId: (sessionId, issueId) => issueBySession.set(sessionId, issueId),
  }
  return { store, deps, issueBySession, svc: new IssueService(deps) }
}

const sess = (sessionId: string, cwd = '/x'): SessionMeta =>
  ({
    sessionId,
    agentKind: 'claude-code',
    title: 't',
    cwd,
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: 't',
    lastActiveAt: 't',
    origin: { kind: 'spawn' },
    archived: false,
  }) as unknown as SessionMeta

describe('origin/draft on create + wire', () => {
  it('defaults origin=human draft=false; honors explicit values', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(a.origin).toBe('human')
    expect(a.draft).toBe(false)
    const b = svc.create({
      repoPath: '/r',
      title: 'Draft',
      startNow: false,
      origin: 'agent',
      draft: true,
    })
    expect(b.origin).toBe('agent')
    expect(b.draft).toBe(true)
  })

  it('round-trips origin/draft through the store', () => {
    const { svc, store } = harness()
    const b = svc.create({
      repoPath: '/r',
      title: 'Draft',
      startNow: false,
      origin: 'agent',
      draft: true,
    })
    const row = store.getIssue(b.id)!
    expect(row.origin).toBe('agent')
    expect(row.draft).toBe(true)
    // Re-hydrate a fresh service from the same store.
    svc.reload()
    expect(svc.get(b.id)!.draft).toBe(true)
    expect(svc.get(b.id)!.origin).toBe('agent')
  })

  it('retitling a draft clears draft; other updates do not', () => {
    const { svc } = harness()
    const d = svc.createDraftFor('/r')
    expect(d.draft).toBe(true)
    expect(d.stage).toBe('backlog')
    expect(svc.update(d.id, { priority: 1 }).draft).toBe(true)
    expect(svc.update(d.id, { title: 'Real work' }).draft).toBe(false)
  })
})

describe('attachSession', () => {
  it('moves the session to the target issue and cleans up the empty draft', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const draft = svc.createDraftFor('/r')
    issueBySession.set('s1', draft.id)
    const target = svc.create({ repoPath: '/r', title: 'Real', startNow: false })
    const w = svc.attachSession({ sessionId: 's1', targetId: target.id })
    expect(w.id).toBe(target.id)
    expect(issueBySession.get('s1')).toBe(target.id)
    expect(svc.get(draft.id)).toBeNull() // empty draft deleted
  })

  it('self-attach is a no-op', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    issueBySession.set('s1', a.id)
    const w = svc.attachSession({ sessionId: 's1', targetId: a.id })
    expect(w.id).toBe(a.id)
    expect(svc.get(a.id)).not.toBeNull()
  })

  it('keeps a previous non-draft issue and a draft that still has sessions', () => {
    const { svc, issueBySession } = harness([sess('s1'), sess('s2')])
    const draft = svc.createDraftFor('/r')
    issueBySession.set('s1', draft.id)
    issueBySession.set('s2', draft.id) // second session keeps the draft alive
    const target = svc.create({ repoPath: '/r', title: 'T', startNow: false })
    svc.attachSession({ sessionId: 's1', targetId: target.id })
    expect(svc.get(draft.id)).not.toBeNull()
    // non-draft previous issue survives even when empty
    const real = svc.create({ repoPath: '/r', title: 'R', startNow: false })
    issueBySession.set('s2', real.id)
    const other = svc.create({ repoPath: '/r', title: 'O', startNow: false })
    svc.attachSession({ sessionId: 's2', targetId: other.id })
    expect(svc.get(real.id)).not.toBeNull()
  })

  it('keeps a draft that owns a worktree or has children', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const draft = svc.createDraftFor('/r')
    svc.update(draft.id, { worktreePath: '/r/.worktrees/x' })
    issueBySession.set('s1', draft.id)
    const target = svc.create({ repoPath: '/r', title: 'T', startNow: false })
    svc.attachSession({ sessionId: 's1', targetId: target.id })
    expect(svc.get(draft.id)).not.toBeNull()
  })

  it('newSubissue creates a child of the current issue and moves there', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const parent = svc.create({ repoPath: '/r', title: 'Epic', startNow: false })
    issueBySession.set('s1', parent.id)
    const w = svc.attachSession({ sessionId: 's1', newSubissue: { title: 'Side quest' } })
    expect(w.title).toBe('Side quest')
    expect(w.parentId).toBe(parent.id)
    expect(w.origin).toBe('human')
    expect(w.draft).toBe(false)
    expect(issueBySession.get('s1')).toBe(w.id)
    expect(svc.get(parent.id)).not.toBeNull()
  })

  it('newSubissue with no current issue requires targetId as parent', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    expect(() => svc.attachSession({ sessionId: 's1', newSubissue: { title: 'x' } })).toThrow(
      /no parent/,
    )
    const parent = svc.create({ repoPath: '/r', title: 'P', startNow: false })
    const w = svc.attachSession({
      sessionId: 's1',
      targetId: parent.id,
      newSubissue: { title: 'child' },
    })
    expect(w.parentId).toBe(parent.id)
    expect(issueBySession.get('s1')).toBe(w.id)
  })

  it('throws without --id/--subissue and on unknown target', () => {
    const { svc } = harness([sess('s1')])
    expect(() => svc.attachSession({ sessionId: 's1' })).toThrow(/attach needs/)
    expect(() => svc.attachSession({ sessionId: 's1', targetId: 'iss_nope' })).toThrow()
  })
})

describe('soleOwnerForCwd', () => {
  it('resolves only when exactly one non-archived issue owns the cwd', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.update(a.id, { worktreePath: '/r/.worktrees/a' })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a/sub')).toBe(a.id)
    expect(svc.soleOwnerForCwd('/elsewhere')).toBeNull()
    svc.update(a.id, { archived: true })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a')).toBeNull()
  })
})

describe('prime draft/attach variants', () => {
  it('bound draft issue gets the retitle-or-attach instruction', () => {
    const { svc } = harness()
    const d = svc.createDraftFor('/r')
    const text = svc.prime({ boundIssueId: d.id })
    expect(text).toContain('draft work item')
    expect(text).toContain('podium issue attach --id')
    expect(text).toContain('--title')
  })

  it('bound real issue gets the sub-issue re-home line', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const text = svc.prime({ boundIssueId: a.id })
    expect(text).toContain('You are working on #1: A')
    expect(text).toContain('podium issue attach --subissue')
  })
})

describe('store: sessions.issue_id round-trip', () => {
  it('persists and reloads issueId on session rows', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession({
      id: 'sx',
      agentKind: 'claude-code',
      cwd: '/r',
      title: 't',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'live',
      exitCode: null,
      durableLabel: 'podium-sx',
      createdAt: 't',
      lastActiveAt: 't',
      lastOutputAt: null,
      lastInputAt: null,
      lastResumedAt: null,
      archived: false,
      workState: null,
      issueId: 'iss_1',
    })
    const rows = store.loadSessions()
    expect(rows.find((r) => r.id === 'sx')?.issueId).toBe('iss_1')
    // clearing round-trips too
    store.upsertSession({ ...rows.find((r) => r.id === 'sx')!, issueId: null })
    expect(store.loadSessions().find((r) => r.id === 'sx')?.issueId).toBeNull()
  })
})
