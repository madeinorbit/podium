import type { SessionMeta } from '@podium/protocol'
import { normalizeSettings } from '@podium/runtime'
import { describe, expect, it, vi } from 'vitest'
import { type IssueDeps, IssueService } from './modules/issues/service'
import { issueTestPlumbing } from './modules/issues/service/test-plumbing'
import { SessionStore } from './store'

// issue-as-workspace: attachSession / drafts / origin persistence (spec
// docs/internal/superpowers/specs/2026-07-06-issue-as-workspace-design.md).

function harness(sessions: SessionMeta[] = []) {
  const store = new SessionStore(':memory:')
  const issueBySession = new Map<string, string | null>()
  const broadcast = vi.fn()
  const deps: IssueDeps & { broadcast: ReturnType<typeof vi.fn> } = {
    store,
    listSessions: () =>
      sessions.map((s) => ({
        ...s,
        ...(issueBySession.get(s.sessionId) ? { issueId: issueBySession.get(s.sessionId)! } : {}),
      })),
    getSettings: () =>
      normalizeSettings({
        gitWorkflow: {
          defaultParentBranch: '',
          mergeStyle: 'ff-only',
          autoRebaseBeforeMerge: true,
        },
        sessionDefaults: { agent: 'claude-code' },
      }),
    spawnSession: vi.fn(() => ({ sessionId: 's1' })),
    repoOp: vi.fn(async () => ({ ok: true, output: '' })),
    broadcast,
    ...issueTestPlumbing((msg) => broadcast(msg)),
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
      audience: 'agent',
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
      audience: 'agent',
      draft: true,
    })
    const row = store.issues.getIssue(b.id)!
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

  it('keeps a draft that still has sessions', () => {
    const { svc, issueBySession } = harness([sess('s1'), sess('s2')])
    const draft = svc.createDraftFor('/r')
    issueBySession.set('s1', draft.id)
    issueBySession.set('s2', draft.id) // second session keeps the draft alive
    const target = svc.create({ repoPath: '/r', title: 'T', startNow: false })
    svc.attachSession({ sessionId: 's1', targetId: target.id })
    expect(svc.get(draft.id)).not.toBeNull()
  })

  // Cross-issue reattach is blocked [spec:SP-8744]: moving off a real issue
  // strands it session-less and it falls out of the sidebar.
  it('blocks unconfirmed re-home off a real issue; confirmed --subissue works', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const real = svc.create({ repoPath: '/r', title: 'R', startNow: false })
    issueBySession.set('s1', real.id)
    const other = svc.create({ repoPath: '/r', title: 'O', startNow: false })

    expect(() => svc.attachSession({ sessionId: 's1', targetId: other.id })).toThrow(
      /attach blocked/,
    )
    expect(issueBySession.get('s1')).toBe(real.id) // unmoved

    // Self-attach stays a no-op without confirmation.
    expect(svc.attachSession({ sessionId: 's1', targetId: real.id }).id).toBe(real.id)

    const unconfirmed = () =>
      svc.attachSession({
        sessionId: 's1',
        newSubissue: { title: 'Side quest', origin: 'agent' },
      })
    expect(unconfirmed).toThrow(/native subagent must not self-attach/)
    expect(unconfirmed).toThrow(/parent must attach it/)
    expect(unconfirmed).toThrow(/--confirm-rehome/)
    expect(issueBySession.get('s1')).toBe(real.id)
    expect(svc.list('/r').filter((issue) => issue.parentId === real.id)).toHaveLength(0)

    const child = svc.attachSession({
      sessionId: 's1',
      newSubissue: { title: 'Side quest', origin: 'agent' },
      confirmRehome: true,
    })
    expect(child.parentId).toBe(real.id)
    expect(issueBySession.get('s1')).toBe(child.id)
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
    const w = svc.attachSession({
      sessionId: 's1',
      newSubissue: { title: 'Side quest', origin: 'human' },
      confirmRehome: true,
    })
    expect(w.title).toBe('Side quest')
    expect(w.parentId).toBe(parent.id)
    expect(w.origin).toBe('human')
    expect(w.draft).toBe(false)
    expect(issueBySession.get('s1')).toBe(w.id)
    expect(svc.get(parent.id)).not.toBeNull()
  })

  it('newSubissue with no current issue requires targetId as parent', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    expect(() =>
      svc.attachSession({ sessionId: 's1', newSubissue: { title: 'x', origin: 'human' } }),
    ).toThrow(/no parent/)
    const parent = svc.create({ repoPath: '/r', title: 'P', startNow: false })
    const w = svc.attachSession({
      sessionId: 's1',
      targetId: parent.id,
      newSubissue: { title: 'child', origin: 'human' },
    })
    expect(w.parentId).toBe(parent.id)
    expect(issueBySession.get('s1')).toBe(w.id)
  })

  it('newSpinoff creates a TOP-LEVEL issue with a discovered-from edge and moves there (POD-85)', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const origin = svc.create({ repoPath: '/r', title: 'Origin work', startNow: false })
    issueBySession.set('s1', origin.id)
    const w = svc.attachSession({
      sessionId: 's1',
      newSpinoff: { title: 'Adjacent discovery', origin: 'agent' },
      confirmRehome: true,
    })
    expect(w.title).toBe('Adjacent discovery')
    // Provenance, not containment: no parent, but a discovered-from edge back.
    expect(w.parentId ?? null).toBeNull()
    expect(w.deps).toContainEqual({ id: origin.id, type: 'discovered-from' })
    expect(issueBySession.get('s1')).toBe(w.id)
    // Agent-created but immediately worked: NOT proposed — the session is on it.
    expect(w.stage).not.toBe('proposed')
    // The origin's tally of decomposition children is untouched.
    expect(svc.get(origin.id)?.childCount ?? 0).toBe(0)
  })

  it('newSpinoff demands the same rehome confirmation and rejects --subissue combos', () => {
    const { svc, issueBySession } = harness([sess('s1')])
    const origin = svc.create({ repoPath: '/r', title: 'Origin', startNow: false })
    issueBySession.set('s1', origin.id)
    expect(() =>
      svc.attachSession({ sessionId: 's1', newSpinoff: { title: 'x', origin: 'agent' } }),
    ).toThrow(/--confirm-rehome/)
    expect(() =>
      svc.attachSession({
        sessionId: 's1',
        newSubissue: { title: 'a', origin: 'agent' },
        newSpinoff: { title: 'b', origin: 'agent' },
        confirmRehome: true,
      }),
    ).toThrow(/not both/)
    // Unattached session with no --id: nothing to spin off from.
    issueBySession.delete('s1')
    expect(() =>
      svc.attachSession({ sessionId: 's1', newSpinoff: { title: 'x', origin: 'human' } }),
    ).toThrow(/no origin/)
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
    const broad = svc.create({ repoPath: '/r', title: 'Broad', startNow: false })
    svc.update(broad.id, { worktreePath: '/r/.worktrees' })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a/sub')).toBe(a.id)

    const twin = svc.create({ repoPath: '/r', title: 'Twin', startNow: false })
    svc.update(twin.id, { worktreePath: '/r/.worktrees/a' })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a/sub')).toBeNull()
    svc.update(twin.id, { archived: true })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a/sub')).toBe(a.id)

    svc.update(a.id, { archived: true })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a')).toBe(broad.id)
    svc.update(broad.id, { archived: true })
    expect(svc.soleOwnerForCwd('/r/.worktrees/a')).toBeNull()
  })

  it('a registered repo main checkout never owns spawns ([spec:SP-595b] #582)', () => {
    const { svc, store } = harness()
    store.repos.addRepo('/r')
    const squatter = svc.create({ repoPath: '/other', title: 'Squatter', startNow: false })
    svc.update(squatter.id, { worktreePath: '/r' })
    expect(svc.soleOwnerForCwd('/r')).toBeNull()
    expect(svc.soleOwnerForCwd('/r/sub')).toBeNull()
    // Dedicated worktrees under the root still attach.
    const wt = svc.create({ repoPath: '/r', title: 'Wt', startNow: false })
    svc.update(wt.id, { worktreePath: '/r/.worktrees/wt' })
    expect(svc.soleOwnerForCwd('/r/.worktrees/wt')).toBe(wt.id)
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

  it('bound real issue gets the spinoff-vs-subissue litmus re-home line (POD-85)', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    const text = svc.prime({ boundIssueId: a.id })
    expect(text).toContain('You are working on #1: A')
    expect(text).toContain('podium issue attach --spinoff')
    expect(text).toContain('podium issue attach --subissue')
    expect(text).toContain('close with the new work untouched')
    expect(text).toContain('--confirm-rehome')
    expect(text).toContain('native subagent must not self-attach')
  })

  // Agents attached to their own freshly-retitled issue left it in `backlog`
  // forever: retitling names an issue but never advances its stage, and only
  // `claim` sets in_progress. Prime has to say so, in both places.
  it('draft prime tells the agent retitling leaves it in backlog', () => {
    const { svc } = harness()
    const d = svc.createDraftFor('/r')
    const text = svc.prime({ boundIssueId: d.id })
    expect(text).toContain('--stage planning')
    expect(text).toContain('--stage in_progress')
  })

  it('bound issue still in backlog is told to advance the stage', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    expect(svc.get(a.id)?.stage).toBe('backlog')
    expect(svc.prime({ boundIssueId: a.id })).toContain('still in `backlog` but you are working it')
  })

  it('bound issue past backlog is not nagged about its stage', () => {
    const { svc } = harness()
    const a = svc.create({ repoPath: '/r', title: 'A', startNow: false })
    svc.claim(a.id, 'agent')
    expect(svc.prime({ boundIssueId: a.id })).not.toContain('still in `backlog`')
  })
})

describe('store: sessions.issue_id round-trip', () => {
  it('persists and reloads issueId on session rows', () => {
    const store = new SessionStore(':memory:')
    store.sessions.upsertSession({
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
    const rows = store.sessions.loadSessions()
    expect(rows.find((r) => r.id === 'sx')?.issueId).toBe('iss_1')
    // clearing round-trips too
    store.sessions.upsertSession({ ...rows.find((r) => r.id === 'sx')!, issueId: null })
    expect(store.sessions.loadSessions().find((r) => r.id === 'sx')?.issueId).toBeNull()
  })
})
