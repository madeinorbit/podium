/**
 * POD-4443 — fixture tests: determinism, exact counts, shape rules.
 *
 * Timing tests (4x build) live here too; walls are recorded, counts verdict.
 */
import { dedupeSessions } from '@podium/client-core/engine'
import { describe, expect, it } from 'vitest'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { expectedSnapshot } from '../oracle/index'
import { BASE_COUNTS, buildCorpus, type CorpusStats, FIXED_NOW } from './index'

describe('buildCorpus determinism', () => {
  it('two 1x builds with the same seed are deep-equal', () => {
    const a = buildCorpus(1, 4443)
    const b = buildCorpus(1, 4443)
    expect(a).toEqual(b)
  })

  it('different seeds diverge', () => {
    const a = buildCorpus(1, 4443)
    const b = buildCorpus(1, 777)
    expect(a.issues[0]).not.toEqual(b.issues[0])
  })
})

describe('buildCorpus counts', () => {
  it.each([1, 2, 4] as const)('scale %i multiplies all four collections', (scale) => {
    const corpus = buildCorpus(scale, 4443)
    expect(corpus.stats.issues).toBe(BASE_COUNTS.issues * scale)
    expect(corpus.stats.sessions).toBe(BASE_COUNTS.sessions * scale)
    expect(corpus.stats.repos).toBe(BASE_COUNTS.repos * scale)
    expect(corpus.stats.worktrees).toBe(BASE_COUNTS.worktrees * scale)
    expect(corpus.issues).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.sessions).toHaveLength(BASE_COUNTS.sessions * scale)
    expect(corpus.issueProjections).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.repos).toHaveLength(BASE_COUNTS.repos * scale)
    expect(corpus.sliceIssues).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.sliceSessions).toHaveLength(BASE_COUNTS.sessions * scale)
    expect(corpus.sliceWorktrees).toHaveLength(BASE_COUNTS.worktrees * scale)
    expect(corpus.machines).toHaveLength(BASE_COUNTS.machines)
  }, 120_000)
})

describe('buildCorpus shape (1x)', () => {
  const corpus = buildCorpus(1, 4443)

  it('has parent chains depth 1-4 with ~40% children', () => {
    const ratio = corpus.stats.withParent / corpus.stats.issues
    expect(ratio).toBeGreaterThan(0.35)
    expect(ratio).toBeLessThan(0.45)
    expect(corpus.stats.maxDepth).toBeLessThanOrEqual(4)
    expect(corpus.stats.maxDepth).toBeGreaterThanOrEqual(3)
  })

  it('has ~2,230 open issues (no closedAt)', () => {
    expect(corpus.stats.open).toBeGreaterThan(2000)
    expect(corpus.stats.open).toBeLessThan(2460)
  })

  it('exercises prefix ownership with forked worktree paths', () => {
    const paths = new Set(corpus.sliceWorktrees.map((w) => w.path))
    expect(paths.has('/w/alpha')).toBe(true)
    expect(paths.has('/w/alpha-fork')).toBe(true)
    expect(paths.has('/w/beta-fork')).toBe(true)
  })

  it('mints unique session ids; only the resume-twin groups share a resume ref', () => {
    const ids = corpus.sessions.map((s) => s.sessionId)
    expect(new Set(ids).size).toBe(ids.length)
    const twinIds = new Set(corpus.resumeTwins.flatMap((g) => g.sessionIds))
    for (const s of corpus.sessions) {
      if (!twinIds.has(s.sessionId)) expect(s).not.toHaveProperty('resume')
    }
  })

  it('covers both displayRef spellings (prefix-seq and #seq)', () => {
    const withPrefix = corpus.sliceIssues.filter((i) => i.repoId !== null).length
    const withoutRepo = corpus.sliceIssues.filter((i) => i.repoId === null).length
    expect(withPrefix).toBeGreaterThan(0)
    expect(withoutRepo).toBeGreaterThan(0)
  })

  it('names one live issue worktree no scan reported, with an orphan under it (POD-4550)', () => {
    const { issueId, path, sessionId } = corpus.unscannedWorktree
    const issue = corpus.sliceIssues.find((i) => i.id === issueId)!
    expect(issue.worktreePath).toBe(path)
    expect(issue.closedAt).toBeNull()
    expect(issue.archived).toBe(false)
    // Not in the discovery scan, not a worktree row, not any session's cwd.
    expect(corpus.repos.flatMap((r) => r.worktrees.map((w) => w.path))).not.toContain(path)
    expect(corpus.sliceWorktrees.map((w) => w.path)).not.toContain(path)
    expect(corpus.sessions.map((s) => s.cwd)).not.toContain(path)
    // Its only session is an unbound one, seated by the prefix alone.
    const under = corpus.sessions.filter((s) => s.cwd.startsWith(`${path}/`))
    expect(under.map((s) => s.sessionId)).toEqual([sessionId])
    expect(under[0]!.issueId ?? null).toBeNull()
    expect(corpus.sessions.some((s) => s.issueId === issueId)).toBe(false)
  })
})

/** Depth proportions in percent of all issues, keyed by depth. */
const depthShares = (stats: CorpusStats): Record<string, number> =>
  Object.fromEntries(
    Object.entries(stats.depthHistogram).map(([depth, count]) => [
      depth,
      (100 * count) / stats.issues,
    ]),
  )

describe.each([1, 2, 4] as const)('buildCorpus shape at %ix (POD-4551)', (scale) => {
  // Growth measurements only mean something if the corpus grows the way real
  // usage would: the same proportions, the visible set linear in scale.
  const corpus = buildCorpus(scale, 4443)
  const oneX = scale === 1 ? corpus : buildCorpus(1, 4443)
  const { stats } = corpus
  const locals: SliceLocals = { selectedIssueId: null, coarseNow: FIXED_NOW }
  const snapshot = expectedSnapshot(corpus, locals)
  // The runtime collapses resume twins on every session read
  // (runtime.ts:465, optimism.ts:876); the shared oracle feeds the raw rows
  // today (routed to the oracle's owner, POD-4563). The twin cases compare a
  // test-local collapse against the raw run: the collapse-on arm is what the
  // app shows, the raw arm is the disabled-collapse control.
  const collapsed = expectedSnapshot(
    { ...corpus, sessions: dedupeSessions(corpus.sessions) },
    locals,
  )
  const byId = new Map(corpus.issues.map((i) => [i.id as string, i]))
  const sessionById = new Map(corpus.sessions.map((s) => [s.sessionId as string, s]))

  it('shows 211 x scale +/- 10% visible rows', () => {
    const count = Object.keys(snapshot.rowsById).length
    expect(count).toBeGreaterThanOrEqual(Math.ceil(211 * scale * 0.9))
    expect(count).toBeLessThanOrEqual(Math.floor(211 * scale * 1.1))
  })

  it('keeps the parent depth histogram within 5 points of 1x', () => {
    const shares = depthShares(stats)
    const base = depthShares(oneX.stats)
    expect(Object.keys(shares).sort()).toEqual(Object.keys(base).sort())
    for (const depth of Object.keys(base)) {
      expect(Math.abs(shares[depth]! - base[depth]!), `depth ${depth}`).toBeLessThanOrEqual(5)
    }
    expect(stats.maxDepth).toBe(4)
  })

  it('attaches ~10% of sessions to a worktree path with no issueId', () => {
    const ratio = stats.prefixOwnedSessions / stats.sessions
    expect(ratio).toBeGreaterThan(0.09)
    expect(ratio).toBeLessThan(0.11)
    for (const s of corpus.sliceSessions) {
      if (s.issueId == null) expect(s.cwd).toMatch(/^\/w\//)
    }
  })

  it('carries discovered-from edges on ~5% of issues', () => {
    const ratio = stats.withOriginEdge / stats.issues
    expect(ratio).toBeGreaterThan(0.04)
    expect(ratio).toBeLessThan(0.06)
    expect(corpus.issueDeps).toHaveLength(stats.withOriginEdge)
  })

  it('carries 20 x scale invisible-but-edged askers under visible, non-asking roots', () => {
    // The L1d shape (POD-4549): an asking session on an archived or proposed
    // child of a visible root. Legacy detaches the ask (the hidden child has
    // no row and its sessions join no lane), so the root must not ask.
    expect(corpus.edgedAskers).toHaveLength(20 * scale)
    expect(stats.edgedAskers).toBe(20 * scale)
    for (const { rootId, childId, sessionId } of corpus.edgedAskers) {
      const child = byId.get(childId)!
      expect(child.parentId).toBe(rootId)
      expect(child.archived || child.stage === 'proposed').toBe(true)
      expect(child.closedAt).toBeNull()
      const session = sessionById.get(sessionId)!
      expect(session.issueId).toBe(childId)
      expect(session.status).toBe('live')
      expect(session.offer).toBeDefined()
      expect(snapshot.rowsById[childId], `hidden child ${childId}`).toBeUndefined()
      expect(snapshot.rowsById[rootId], `root ${rootId} visible`).toBeDefined()
      expect(snapshot.rowsById[rootId]!.asking, `root ${rootId} not asking`).toBe(false)
    }
  })

  it("control: un-hiding the askers' children makes their roots ask", () => {
    // Proves the shape is edged, not vacuous: the same asks DO bubble once the
    // child is a visible member of the root's subtree.
    const hidden = new Set(corpus.edgedAskers.map((a) => a.childId))
    const unhide = <T extends { id: unknown }>(rows: T[]): T[] =>
      rows.map((r) =>
        hidden.has(r.id as string) ? { ...r, archived: false, stage: 'in_progress' } : r,
      )
    const shown = expectedSnapshot(
      {
        ...corpus,
        issues: unhide(corpus.issues),
        issueProjections: unhide(corpus.issueProjections),
      },
      locals,
    )
    for (const { rootId } of corpus.edgedAskers) {
      expect(shown.rowsById[rootId]!.asking, `root ${rootId} asks once its child shows`).toBe(true)
    }
  })

  it('carries one resume-twin group of each kind per scale unit, on visible roots', () => {
    expect(corpus.resumeTwins).toHaveLength(3 * scale)
    expect(stats.resumeTwinGroups).toBe(3 * scale)
    const refs = new Set<string>()
    for (const group of corpus.resumeTwins) {
      const key = `${group.ref.kind}:${group.ref.value}`
      expect(refs.has(key)).toBe(false)
      refs.add(key)
      const members = corpus.sessions.filter(
        (s) => s.resume?.kind === group.ref.kind && s.resume?.value === group.ref.value,
      )
      expect(members.map((s) => s.sessionId).sort()).toEqual([...group.sessionIds].sort())
      for (const s of members) expect(s.issueId).toBe(group.issueId)
      const slice = corpus.sliceSessions.filter((s) => group.sessionIds.includes(s.sessionId))
      for (const s of slice) expect(s.resume).toEqual(group.ref)
      const statuses = members.map((s) => s.status).sort()
      if (group.kind === 'inactive') expect(statuses).toEqual(['exited', 'hibernated'])
      if (group.kind === 'tie') expect(statuses).toEqual(['hibernated', 'hibernated'])
      if (group.kind === 'live') expect(statuses).toEqual(['hibernated', 'live'])
      expect(snapshot.rowsById[group.issueId], `root ${group.issueId} visible`).toBeDefined()
    }
  })

  it('shows each twin group through the legacy collapse', () => {
    for (const group of corpus.resumeTwins) {
      const row = collapsed.rowsById[group.issueId]!
      if (group.kind === 'inactive') {
        // Rank beats recency: the older hibernated ask survives the exited run.
        expect(row.asking).toBe(true)
        expect(row.working).toBe(false)
      } else if (group.kind === 'tie') {
        // Equal rank, most recent wins: the stale ask collapses away.
        expect(row.asking).toBe(false)
        expect(row.phase).toBe('queued')
      } else {
        // A group touching a live row is kept in full.
        expect(row.working).toBe(true)
        expect(row.asking).toBe(true)
      }
    }
  })

  it('control: the oracle with the collapse disabled changes exactly the tie rows', () => {
    // `snapshot` is the raw (collapse-off) run.
    expect(Object.keys(snapshot.rowsById).sort()).toEqual(Object.keys(collapsed.rowsById).sort())
    expect(snapshot.order).toEqual(collapsed.order)
    const changed = Object.keys(collapsed.rowsById).filter(
      (id) => JSON.stringify(snapshot.rowsById[id]) !== JSON.stringify(collapsed.rowsById[id]),
    )
    const ties = corpus.resumeTwins.filter((g) => g.kind === 'tie').map((g) => g.issueId)
    expect(changed.sort()).toEqual([...ties].sort())
    for (const id of ties) {
      expect(snapshot.rowsById[id]!.asking).toBe(true)
      expect(collapsed.rowsById[id]!.asking).toBe(false)
    }
  })
})
