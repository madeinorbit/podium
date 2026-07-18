/**
 * Replica-side issue views (ADR 4 D7.3).
 *
 * The `unread` test in the last block is the one POD-791 asked for by name, and
 * its reasoning is worth keeping in front of whoever edits this file: a child
 * change emits ZERO events on the parent row (POD-794), so a binding subscribed
 * only to the issue tree shows an `unread` that never moves — with no error, no
 * warning, and a demo that looks perfect. It is the bug class that only a test
 * which MUTATES a session and re-reads the issue can see.
 */

import type { IssueProjection } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  buildIssueBoard,
  buildIssueTree,
  deriveIssueRollups,
  deriveIssueViews,
  type IssueViewInput,
  indexSessionsByIssue,
  issueDisplayRef,
  readViewInputs,
  type SessionViewInput,
} from './issue-views'
import { createReplica, memoryStorage } from './replica'

const issue = (over: Partial<IssueViewInput> & { id: string }): IssueViewInput => ({
  seq: 1,
  stage: 'backlog',
  updatedAt: '2026-07-17T08:00:00.000Z',
  ...over,
})
const session = (over: Partial<SessionViewInput> & { sessionId: string }): SessionViewInput => ({
  ...over,
})

const STAGES = ['backlog', 'planning', 'in_progress', 'review', 'done']

describe('membership by local index — the field POD-791 asked us to kill', () => {
  it('indexes sessions onto their issue', () => {
    const index = indexSessionsByIssue([
      session({ sessionId: 's1', issueId: 'i1' }),
      session({ sessionId: 's2', issueId: 'i1' }),
      session({ sessionId: 's3', issueId: 'i2' }),
    ])
    expect(index.get('i1')).toEqual(['s1', 's2'])
    expect(index.get('i2')).toEqual(['s3'])
  })

  it('ignores sessions with no issue', () => {
    expect(
      indexSessionsByIssue([
        session({ sessionId: 's1' }),
        session({ sessionId: 's2', issueId: null }),
      ]).size,
    ).toBe(0)
  })

  it('a session re-homing to another issue moves it in BOTH issues, with one source of truth', () => {
    // The argument against `memberSessionIds` in one test: derived from the
    // edge as stored, a re-home cannot leave the two issues disagreeing. A
    // second spelling of the edge could, and nothing would arbitrate.
    const before = deriveIssueViews(
      [issue({ id: 'i1' }), issue({ id: 'i2' })],
      [session({ sessionId: 's1', issueId: 'i1' })],
    )
    expect(before.get('i1')?.memberSessionIds).toEqual(['s1'])
    expect(before.get('i2')?.memberSessionIds).toEqual([])

    const after = deriveIssueViews(
      [issue({ id: 'i1' }), issue({ id: 'i2' })],
      [session({ sessionId: 's1', issueId: 'i2' })],
    )
    expect(after.get('i1')?.memberSessionIds).toEqual([])
    expect(after.get('i2')?.memberSessionIds).toEqual(['s1'])
  })

  it('a view model carries session IDS, never a SessionMeta', () => {
    // D7.1 one layer up: the wire stopped embedding sessions, and a view that
    // re-embedded them would put the same O(world) rebuild back on the client.
    const views = deriveIssueViews(
      [issue({ id: 'i1' })],
      [session({ sessionId: 's1', issueId: 'i1' })],
    )
    const view = views.get('i1')
    expect(view?.memberSessionIds).toEqual(['s1'])
    expect(Object.values(view ?? {}).flat()).not.toContainEqual(
      expect.objectContaining({ sessionId: 's1' }),
    )
  })
})

describe('displayRef — derived from (prefix, seq)', () => {
  it('renders the human ref', () => {
    expect(issueDisplayRef({ seq: 13, prefix: 'POD' })).toBe('POD-13')
  })
  it('falls back to #seq before a repo has a prefix', () => {
    expect(issueDisplayRef({ seq: 13, prefix: null })).toBe('#13')
    expect(issueDisplayRef({ seq: 13 })).toBe('#13')
  })
})

describe('tree rollups', () => {
  const issues = [
    issue({ id: 'parent' }),
    issue({ id: 'kid1', parentId: 'parent', stage: 'done' }),
    issue({ id: 'kid2', parentId: 'parent', stage: 'in_progress' }),
  ]

  it('counts children and done children', () => {
    const views = deriveIssueViews(issues, [])
    expect(views.get('parent')?.childCount).toBe(2)
    expect(views.get('parent')?.childDoneCount).toBe(1)
    expect(views.get('kid1')?.childCount).toBe(0)
  })

  it('builds the tree', () => {
    const views = deriveIssueViews(issues, [])
    const roots = buildIssueTree(views, issues)
    expect(roots.map((r) => r.view.id)).toEqual(['parent'])
    expect(roots[0]?.children.map((c) => c.view.id)).toEqual(['kid1', 'kid2'])
  })

  it('an issue whose parent this replica does NOT hold surfaces at the root', () => {
    // Not an edge case. An issue whose parent is filtered, archived, or simply
    // not yet arrived would otherwise be in no view at all — reachable from
    // nothing, and silently so.
    const orphans = [issue({ id: 'orphan', parentId: 'never-arrived' })]
    const roots = buildIssueTree(deriveIssueViews(orphans, []), orphans)
    expect(roots.map((r) => r.view.id)).toEqual(['orphan'])
  })
})

describe('blocked / ready / deferred — the fields that read OTHER entities', () => {
  it('blocked while a blocking dep is unfinished, ready once it is done', () => {
    const open = [issue({ id: 'a', deps: [{ id: 'b', type: 'blocks' }] }), issue({ id: 'b' })]
    expect(deriveIssueViews(open, []).get('a')?.blocked).toBe(true)
    expect(deriveIssueViews(open, []).get('a')?.ready).toBe(false)

    const closed = [
      issue({ id: 'a', deps: [{ id: 'b', type: 'blocks' }] }),
      issue({ id: 'b', stage: 'done' }),
    ]
    expect(deriveIssueViews(closed, []).get('a')?.blocked).toBe(false)
    expect(deriveIssueViews(closed, []).get('a')?.ready).toBe(true)
  })

  it('a non-blocking dep does not block', () => {
    const issues = [issue({ id: 'a', deps: [{ id: 'b', type: 'related' }] }), issue({ id: 'b' })]
    expect(deriveIssueViews(issues, []).get('a')?.blocked).toBe(false)
  })

  it('an UNKNOWN dep does not block — a replica must not render everything blocked', () => {
    // The failure this prevents: a replica that has not yet seen a dependency
    // would otherwise show every dependent issue blocked. Briefly showing one
    // issue ready is the better error.
    const issues = [issue({ id: 'a', deps: [{ id: 'not-here', type: 'blocks' }] })]
    expect(deriveIssueViews(issues, []).get('a')?.blocked).toBe(false)
  })

  it('deferred while snoozed into the future, ready once the snooze passes', () => {
    const now = () => Date.parse('2026-07-17T00:00:00.000Z')
    const snoozed = [issue({ id: 'a', deferUntil: '2026-08-01T00:00:00.000Z' })]
    expect(deriveIssueViews(snoozed, [], { now }).get('a')?.deferred).toBe(true)
    expect(deriveIssueViews(snoozed, [], { now }).get('a')?.ready).toBe(false)

    const past = [issue({ id: 'a', deferUntil: '2026-07-01T00:00:00.000Z' })]
    expect(deriveIssueViews(past, [], { now }).get('a')?.deferred).toBe(false)
    expect(deriveIssueViews(past, [], { now }).get('a')?.ready).toBe(true)
  })

  it('a done issue is never ready', () => {
    expect(deriveIssueViews([issue({ id: 'a', stage: 'done' })], []).get('a')?.ready).toBe(false)
  })
})

describe('dependents — the reverse of deps, derived not embedded [POD-856]', () => {
  it("an edge A→B puts A in B's dependents with the edge type", () => {
    const issues = [issue({ id: 'a', deps: [{ id: 'b', type: 'blocks' }] }), issue({ id: 'b' })]
    const views = deriveIssueViews(issues, [])
    expect(views.get('b')?.dependents).toEqual([{ id: 'a', type: 'blocks' }])
    // The forward side is unchanged — A depends on B, not the reverse.
    expect(views.get('a')?.dependents).toEqual([])
  })

  it('collects multiple dependents and preserves their types', () => {
    const issues = [
      issue({ id: 'a', deps: [{ id: 'c', type: 'blocks' }] }),
      issue({ id: 'b', deps: [{ id: 'c', type: 'related' }] }),
      issue({ id: 'c' }),
    ]
    const dependents = deriveIssueViews(issues, []).get('c')?.dependents ?? []
    expect(dependents).toHaveLength(2)
    expect(dependents).toContainEqual({ id: 'a', type: 'blocks' })
    expect(dependents).toContainEqual({ id: 'b', type: 'related' })
  })

  it('an edge pointing at an unheld issue does not fabricate a view', () => {
    // The reverse index keys on the target id, which may not be a held issue —
    // it must not create a phantom entry (mirrors the unknown-dep blocked rule).
    const views = deriveIssueViews([issue({ id: 'a', deps: [{ id: 'gone', type: 'blocks' }] })], [])
    expect(views.has('gone')).toBe(false)
    expect(views.get('a')?.dependents).toEqual([])
  })
})

describe('board', () => {
  it('groups by stage and keeps every column, including the empty ones', () => {
    const issues = [issue({ id: 'a' }), issue({ id: 'b', stage: 'done' })]
    const board = buildIssueBoard(deriveIssueViews(issues, []), issues, STAGES)
    expect(board.get('backlog')?.map((v) => v.id)).toEqual(['a'])
    expect(board.get('done')?.map((v) => v.id)).toEqual(['b'])
    // A board that hides its empty columns rearranges itself as work moves.
    expect([...board.keys()]).toEqual(STAGES)
    expect(board.get('review')).toEqual([])
  })
})

describe('session-content rollups — THE pin (POD-791 + POD-794 event semantics)', () => {
  const sessionById = (sessions: SessionViewInput[]) => (id: string) =>
    sessions.find((s) => s.sessionId === id)

  it('a session change moves the issue’s unread', () => {
    // The bug this exists to catch: a child change emits ZERO events on the
    // parent row, so a binding subscribed only to the tree shows an `unread`
    // frozen forever — no error, no warning, a perfect-looking demo.
    const read = {
      readAt: '2026-07-17T10:00:00.000Z',
      updatedAt: '2026-07-17T08:00:00.000Z',
    }
    const quiet = [
      session({ sessionId: 's1', issueId: 'i1', lastActiveAt: '2026-07-17T09:00:00.000Z' }),
    ]
    expect(deriveIssueRollups(read, ['s1'], sessionById(quiet)).unread).toBe(false)

    // The session speaks. THIS must move.
    const active = [
      session({ sessionId: 's1', issueId: 'i1', lastActiveAt: '2026-07-17T11:00:00.000Z' }),
    ]
    expect(deriveIssueRollups(read, ['s1'], sessionById(active)).unread).toBe(true)
  })

  it('a never-read issue with any active session is unread', () => {
    const sessions = [session({ sessionId: 's1', lastActiveAt: '2026-07-17T09:00:00.000Z' })]
    expect(
      deriveIssueRollups(
        { readAt: null, updatedAt: '2026-07-17T08:00:00.000Z' },
        ['s1'],
        sessionById(sessions),
      ).unread,
    ).toBe(true)
  })

  it('matches server unread semantics for issue-row activity without sessions', () => {
    const sessionLookup = sessionById([])
    expect(
      deriveIssueRollups({ readAt: null, updatedAt: '2026-07-17T08:00:00.000Z' }, [], sessionLookup)
        .unread,
    ).toBe(true)
    expect(
      deriveIssueRollups(
        {
          readAt: '2026-07-17T10:00:00.000Z',
          updatedAt: '2026-07-17T11:00:00.000Z',
        },
        [],
        sessionLookup,
      ).unread,
    ).toBe(true)
    expect(
      deriveIssueRollups(
        {
          readAt: '2026-07-17T10:00:00.000Z',
          updatedAt: '2026-07-17T09:00:00.000Z',
        },
        [],
        sessionLookup,
      ).unread,
    ).toBe(false)
  })

  it('keeps deleted issues read even when issue or session activity is newer', () => {
    const rollups = deriveIssueRollups(
      {
        readAt: null,
        updatedAt: '2026-07-17T11:00:00.000Z',
        deletedAt: '2026-07-17T12:00:00.000Z',
      },
      ['s1'],
      sessionById([session({ sessionId: 's1', lastActiveAt: '2026-07-17T13:00:00.000Z' })]),
    )
    expect(rollups.unread).toBe(false)
    expect(rollups.sessionSummary.total).toBe(1)
  })

  it('summarises members by phase', () => {
    const sessions = [
      session({ sessionId: 's1', phase: 'working' }),
      session({ sessionId: 's2', phase: 'working' }),
      session({ sessionId: 's3', phase: 'idle' }),
    ]
    const rollups = deriveIssueRollups(
      { readAt: null, updatedAt: '2026-07-17T08:00:00.000Z' },
      ['s1', 's2', 's3'],
      sessionById(sessions),
    )
    expect(rollups.sessionSummary).toEqual({ total: 3, byPhase: { working: 2, idle: 1 } })
  })

  it('a member id whose session has not arrived is not counted', () => {
    // Normal, not an error — the session may be mid-arrival. Counting it would
    // report a total the user cannot see.
    const rollups = deriveIssueRollups(
      { readAt: null, updatedAt: '2026-07-17T08:00:00.000Z' },
      ['s1', 'ghost'],
      sessionById([session({ sessionId: 's1' })]),
    )
    expect(rollups.sessionSummary.total).toBe(1)
  })
})

describe('reading straight off the replica', () => {
  it('derives views from real replica rows', () => {
    const replica = createReplica({ storage: memoryStorage() })
    // POD-822: the source is `issueProjections` (own row, `repoId` not `prefix`)
    // joined against `repos` for the prefix — never the legacy embedded field.
    replica.applySnapshot('issueProjections', [
      { id: 'i1', seq: 13, repoId: 'repo_a', stage: 'in_progress' } as never,
      { id: 'i2', seq: 14, repoId: 'repo_a', stage: 'done', parentId: 'i1' } as never,
    ])
    replica.applySnapshot('repos', [{ id: 'repo_a', prefix: 'POD' } as never])
    replica.applySnapshot('sessions', [{ sessionId: 's1', issueId: 'i1' } as never])

    const { issues, sessions } = readViewInputs(replica)
    const views = deriveIssueViews(issues, sessions)
    expect(views.get('i1')).toMatchObject({
      displayRef: 'POD-13',
      memberSessionIds: ['s1'],
      childCount: 1,
      childDoneCount: 1,
    })
  })
})

describe('the POD-822 cutover: the projection + join supplies deps and prefix', () => {
  // These two tests were the EVIDENCE for POD-822, written to record the wrong
  // behaviour a naive cutover shipped — a blocked issue reading `blocked: false`
  // and `#13` instead of `POD-13`, silently, with a green typecheck. POD-822
  // closed the gap by giving the replica the two kinds the projection cannot
  // carry (dep edges, repo prefixes) and joining them in `readViewInputs`. So
  // they are FLIPPED: they now drive the real cutover path — replica in,
  // `readViewInputs` join, `deriveIssueViews` — and assert the RIGHT answer. If
  // either regresses, the join broke.
  //
  // A partial `IssueProjection` is cast rather than fully built: the view path
  // reads only id/seq/parentId/repoId/stage/deferUntil/readAt off it, and the
  // collection does not validate — the join is what is under test, not the
  // projection's full shape (that is `issue.mapping.test.ts`'s job).
  const projection = (o: {
    id: string
    seq: number
    stage: string
    repoId?: string
  }): IssueProjection => o as unknown as IssueProjection

  it('derives blocked=true from the joined issueDep edges [POD-822]', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [
      projection({ id: 'i1', seq: 13, stage: 'in_progress' }),
      projection({ id: 'i2', seq: 14, stage: 'in_progress' }),
    ])
    // The edge lives in its OWN collection now — a first-class entity, not a
    // field on either issue. Its id is the composed key the server emits.
    replica.applySnapshot('issueDeps', [
      { id: 'i1|i2|blocks', fromId: 'i1', toId: 'i2', type: 'blocks' } as never,
    ])

    const { issues } = readViewInputs(replica)
    const views = deriveIssueViews(issues, [])
    // i1 depends on i2, which is not done ⇒ blocked. Before POD-822 the missing
    // relation read as "no deps" and this was `blocked: false, ready: true`.
    expect(views.get('i1')).toMatchObject({ blocked: true, ready: false })
  })

  it('derives POD-13 from the joined repo prefix [POD-822]', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [
      projection({ id: 'i1', seq: 13, stage: 'in_progress', repoId: 'repo_a' }),
    ])
    replica.applySnapshot('repos', [{ id: 'repo_a', prefix: 'POD' } as never])

    const { issues } = readViewInputs(replica)
    expect(deriveIssueViews(issues, []).get('i1')).toMatchObject({ displayRef: 'POD-13' })
  })

  it('falls back to #13 when the repo has no prefix — an honest absence, not the gap', () => {
    // The `#13` fallback is still CORRECT for a genuinely prefix-less repo; the
    // POD-822 bug was reaching it for a repo that HAD a prefix. A repo row with
    // `prefix: null`, or an issue whose repo the replica does not hold, is the
    // real absent case and must still read `#13`.
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issueProjections', [
      projection({ id: 'i1', seq: 13, stage: 'in_progress', repoId: 'repo_a' }),
    ])
    replica.applySnapshot('repos', [{ id: 'repo_a', prefix: null } as never])

    const { issues } = readViewInputs(replica)
    expect(deriveIssueViews(issues, []).get('i1')).toMatchObject({ displayRef: '#13' })
  })
})
