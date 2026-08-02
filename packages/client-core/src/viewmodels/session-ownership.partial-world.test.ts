import { asIssueId, asSessionId, type IssueWire, type SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  indexSessionOwnership,
  issueIdOwningSession,
  referentSettled,
  resolveReferent,
  sessionsForIssueNav,
  type ReferentExit,
} from './session-ownership'

// ---------------------------------------------------------------------------
// POD-330 — DERIVING OVER A PARTIAL, MULTI-USER WORLD.
//
// Under the scoped feed (POD-1077) the replica holds only what its principal may
// SEE, so a referenced entity that is absent may be absent because it is
// INVISIBLE — not only because it is late, and not because it was deleted.
// `docs/multi-user-readiness.md` §3.1 calls this out, and ADR 2 D5 warns that
// soft-delete and tombstone "look identical from a distance and are not";
// eviction is the third member of that family.
//
// These are the two properties consumers depend on:
//   1. an invisible referent renders as NEITHER loading-forever NOR deleted;
//   2. an evicted row leaves the derivations with no deletion state, no
//      tombstone and no heal loop.
// ---------------------------------------------------------------------------

function session(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId: asSessionId(id),
    agentKind: 'claude-code',
    title: id,
    cwd: '/repo',
    status: 'live',
    controllerId: null,
    geometry: { cols: 80, rows: 24 },
    epoch: 0,
    clientCount: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    lastActiveAt: '2026-07-01T00:00:00.000Z',
    origin: { kind: 'spawn' },
    archived: false,
    busy: false,
    readAt: null,
    unread: false,
    ...over,
  } as unknown as SessionMeta
}

function issue(id: string, over: Partial<IssueWire> = {}): IssueWire {
  return {
    id: asIssueId(id),
    repoPath: '/repo',
    seq: 1,
    title: id,
    description: '',
    stage: 'in_progress',
    worktreePath: '/repo',
    branch: null,
    parentBranch: 'main',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archived: false,
    audience: 'human',
    origin: 'human',
    draft: false,
    childCount: 0,
    childDoneCount: 0,
    deps: [],
    ...over,
  } as unknown as IssueWire
}

describe('resolveReferent — the three absences are distinguishable', () => {
  const present = { a: 1 }
  const lookup = (id: string) => (id === 'visible' ? present : undefined)

  it('resolves a visible referent to present, carrying the value', () => {
    const r = resolveReferent('visible', lookup)
    expect(r.state).toBe('present')
    expect(r.value).toBe(present)
  })

  it('resolves an EVICTED referent to not-visible — not removed, not pending', () => {
    const exits = (id: string): ReferentExit | undefined =>
      id === 'shared-away' ? 'evicted' : undefined
    const r = resolveReferent('shared-away', lookup, exits)
    // The whole point: an eviction must not read as a deletion...
    expect(r.state).toBe('not-visible')
    expect(r.state).not.toBe('removed')
    // ...and must not read as still-loading either, or the UI spins forever.
    expect(r.state).not.toBe('pending')
    // And it must never fabricate a stand-in that implies the entity is usable.
    expect(r.value).toBeUndefined()
  })

  it('resolves a REMOVED referent to removed, distinctly from an eviction', () => {
    const exits = (id: string): ReferentExit | undefined =>
      id === 'deleted' ? 'removed' : undefined
    expect(resolveReferent('deleted', lookup, exits).state).toBe('removed')
  })

  it('resolves an unheard-of referent to pending — the only spinnable state', () => {
    const r = resolveReferent('not-here-yet', lookup)
    expect(r.state).toBe('pending')
    expect(referentSettled(r.state)).toBe(false)
    // Every other absence is terminal, so a spinner on them is a bug.
    expect(referentSettled('not-visible')).toBe(true)
    expect(referentSettled('removed')).toBe(true)
  })

  it('presence beats a stale exit record — a re-granted row is present again', () => {
    // Re-sharing brings the row back without its revision moving; a leftover
    // eviction record must not keep it invisible.
    const exits = (): ReferentExit => 'evicted'
    expect(resolveReferent('visible', lookup, exits).state).toBe('present')
  })
})

describe('eviction leaves the ownership derivations clean', () => {
  const issues = [issue('i-1')]
  const worktrees = ['/repo']

  it('an evicted session simply leaves membership — no tombstone, no residue', () => {
    const before = indexSessionOwnership(
      [session('s-1', { issueId: asIssueId('i-1') }), session('s-2', { issueId: asIssueId('i-1') })],
      issues,
      worktrees,
    )
    expect(before.sessionsByIssue.get('i-1')).toHaveLength(2)

    // s-2 is EVICTED: it is gone from this principal's replica, and its
    // revision never moved. The derivation just sees one fewer row.
    const after = indexSessionOwnership(
      [session('s-1', { issueId: asIssueId('i-1') })],
      issues,
      worktrees,
    )

    expect(after.sessionsByIssue.get('i-1')).toHaveLength(1)
    expect(after.sessionById.has('s-2')).toBe(false)
    // No tombstone entry anywhere — an evicted id must not linger as a key,
    // which is what would later feed a "deleted" badge or a removal animation.
    expect([...after.sessionsByIssue.keys()]).toEqual(['i-1'])
    expect([...after.sessionById.keys()]).toEqual(['s-1'])
  })

  it('recomputing after an eviction is stable — no heal loop', () => {
    const rows = [session('s-1', { issueId: asIssueId('i-1') })]
    const first = indexSessionOwnership(rows, issues, worktrees)
    const second = indexSessionOwnership(rows, issues, worktrees)
    // Same inputs, same answer: nothing about the eviction makes the derivation
    // want to run again or ask for a repair it will not get.
    expect([...second.sessionsByIssue.get('i-1')!].map((s) => s.sessionId)).toEqual(
      [...first.sessionsByIssue.get('i-1')!].map((s) => s.sessionId),
    )
  })

  it('a session whose OWNING ISSUE was evicted resolves to not-visible, not orphaned', () => {
    // The session is visible; its issue is not. Today this is indistinguishable
    // from "no owner" — issueIdOwningSession returns null for both.
    const orphan = session('s-9', { issueId: asIssueId('i-invisible') })
    expect(
      issueIdOwningSession(asSessionId('s-9'), [orphan], issues, worktrees),
    ).toBeNull()

    // resolveReferent is what recovers the distinction for the consumer.
    const byId = new Map(issues.map((i) => [String(i.id), i]))
    const invisible = resolveReferent(
      orphan.issueId as unknown as string,
      (id) => byId.get(id),
      (id) => (id === 'i-invisible' ? 'evicted' : undefined),
    )
    expect(invisible.state).toBe('not-visible')

    const genuinelyAbsent = resolveReferent('i-never-existed', (id) => byId.get(id))
    expect(genuinelyAbsent.state).toBe('pending')
    // The two must not be the same answer — that collapse is the defect.
    expect(invisible.state).not.toBe(genuinelyAbsent.state)
  })

  it('membership over an evicted issue yields no members rather than a phantom row', () => {
    const members = sessionsForIssueNav(
      { id: asIssueId('i-invisible'), worktreePath: null },
      [session('s-1', { issueId: asIssueId('i-1') })],
      worktrees,
    )
    expect(members).toEqual([])
  })
})
