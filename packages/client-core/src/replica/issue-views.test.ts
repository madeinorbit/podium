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
    const read = { readAt: '2026-07-17T10:00:00.000Z' }
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
    expect(deriveIssueRollups({ readAt: null }, ['s1'], sessionById(sessions)).unread).toBe(true)
  })

  it('summarises members by phase', () => {
    const sessions = [
      session({ sessionId: 's1', phase: 'working' }),
      session({ sessionId: 's2', phase: 'working' }),
      session({ sessionId: 's3', phase: 'idle' }),
    ]
    const rollups = deriveIssueRollups({ readAt: null }, ['s1', 's2', 's3'], sessionById(sessions))
    expect(rollups.sessionSummary).toEqual({ total: 3, byPhase: { working: 2, idle: 1 } })
  })

  it('a member id whose session has not arrived is not counted', () => {
    // Normal, not an error — the session may be mid-arrival. Counting it would
    // report a total the user cannot see.
    const rollups = deriveIssueRollups(
      { readAt: null },
      ['s1', 'ghost'],
      sessionById([session({ sessionId: 's1' })]),
    )
    expect(rollups.sessionSummary.total).toBe(1)
  })
})

describe('reading straight off the replica', () => {
  it('derives views from real replica rows', () => {
    const replica = createReplica({ storage: memoryStorage() })
    replica.applySnapshot('issues', [
      { id: 'i1', seq: 13, prefix: 'POD', stage: 'in_progress' } as never,
      { id: 'i2', seq: 14, prefix: 'POD', stage: 'done', parentId: 'i1' } as never,
    ])
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

describe('the POD-796 cutover seam: what IssueProjection does NOT carry', () => {
  // These two tests are the evidence for POD-822. They are written to PASS,
  // because they record the real (wrong) behaviour a naive cutover ships — the
  // point is that this behaviour is reachable at all, silently, with a green
  // typecheck. Delete them when the projection can supply deps + prefix; if they
  // start failing, the gap they document has been closed and that is good news.

  it('derives blocked=false for a genuinely blocked issue when deps are absent', () => {
    const blockedByWire = deriveIssueViews(
      [
        { id: 'i1', seq: 13, stage: 'in_progress', deps: [{ id: 'i2', type: 'blocks' }] },
        { id: 'i2', seq: 14, stage: 'in_progress' },
      ],
      [],
    )
    expect(blockedByWire.get('i1')).toMatchObject({ blocked: true, ready: false })

    // The SAME issue as IssueProjection carries it: `deps` is a relation, not a
    // column, so the normalized projection has no such key. `deps ?? []` then
    // reads "no dependencies" instead of "dependencies unknown", and the issue
    // reports itself ready to work on while it is in fact blocked.
    const blockedByProjection = deriveIssueViews(
      [
        { id: 'i1', seq: 13, stage: 'in_progress' },
        { id: 'i2', seq: 14, stage: 'in_progress' },
      ],
      [],
    )
    expect(blockedByProjection.get('i1')).toMatchObject({ blocked: false, ready: true })
  })

  it('derives #13 instead of POD-13 when prefix is absent', () => {
    // `prefix` is a function of the REPO, not the issue, so D7.1 pushed it off
    // the projection — but nothing replica-side supplies it yet, and there is no
    // 'repo' entity kind on the feed.
    expect(
      deriveIssueViews([{ id: 'i1', seq: 13, stage: 'todo', prefix: 'POD' }], []).get('i1'),
    ).toMatchObject({ displayRef: 'POD-13' })
    expect(deriveIssueViews([{ id: 'i1', seq: 13, stage: 'todo' }], []).get('i1')).toMatchObject({
      displayRef: '#13',
    })
  })
})
