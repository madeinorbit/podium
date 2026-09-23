/**
 * POD-4443 / POD-4635 — fixture tests: determinism, exact counts, and the
 * shape against the live table at every scale.
 */
import { isSortKey } from '@podium/model'
import { describe, expect, it } from 'vitest'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { expectedSnapshot } from '../oracle/index'
import {
  BASE_COUNTS,
  buildCorpus,
  type CorpusStats,
  FIXED_NOW,
  type FixtureCorpus,
  scanEntries,
} from './index'
import { measureShape, type ShapeMeasures } from './shape'

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
  it.each([
    1, 2, 4,
  ] as const)('scale %i multiplies issues, sessions and worktrees; repos stay', (scale) => {
    const corpus = buildCorpus(scale, 4443)
    expect(corpus.stats.issues).toBe(BASE_COUNTS.issues * scale)
    expect(corpus.stats.sessions).toBe(BASE_COUNTS.sessions * scale)
    expect(scanEntries(1)).toBe(BASE_COUNTS.repos)
    expect(corpus.stats.repos).toBe(scanEntries(scale))
    expect(corpus.stats.worktrees).toBe(BASE_COUNTS.worktrees * scale)
    expect(corpus.stats.repoRows).toBe(BASE_COUNTS.repoRows)
    expect(corpus.stats.rootLanes).toBe(BASE_COUNTS.rootLanes)
    expect(corpus.repoProjections).toHaveLength(BASE_COUNTS.repoRows)
    expect(corpus.issues).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.sessions).toHaveLength(BASE_COUNTS.sessions * scale)
    expect(corpus.issueProjections).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.repos).toHaveLength(scanEntries(scale))
    expect(corpus.sliceIssues).toHaveLength(BASE_COUNTS.issues * scale)
    expect(corpus.sliceSessions).toHaveLength(BASE_COUNTS.sessions * scale)
    expect(corpus.sliceWorktrees).toHaveLength(BASE_COUNTS.worktrees * scale)
    expect(corpus.machines).toHaveLength(BASE_COUNTS.machines)
  }, 120_000)
})

describe('buildCorpus shape (1x)', () => {
  const corpus = buildCorpus(1, 4443)

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
    // Most sessions carry a resume ref (live 75.5%); outside the planted
    // twin groups every ref is its own.
    const twinIds = new Set(corpus.resumeTwins.flatMap((g) => g.sessionIds))
    const refs = corpus.sessions
      .filter((s) => s.resume && !twinIds.has(s.sessionId))
      .map((s) => `${s.resume!.kind}:${s.resume!.value}`)
    expect(refs.length).toBeGreaterThan(corpus.sessions.length / 2)
    expect(new Set(refs).size).toBe(refs.length)
  })

  it('covers both displayRef spellings (prefix-seq and #seq)', () => {
    // `#seq` comes from issues whose repo id has no repo row (live: 4 such
    // ids, 2 visible rows); every other row joins a prefix.
    const snapshot = expectedSnapshot(corpus, { selectedIssueId: null, coarseNow: FIXED_NOW })
    const labels = Object.values(snapshot.rowsById).map((row) => row.displayRef)
    expect(labels.filter((ref) => ref.startsWith('#')).length).toBeGreaterThan(0)
    expect(labels.filter((ref) => /^[A-Z]{3}-\d+$/.test(ref)).length).toBeGreaterThan(0)
    const known = new Set(corpus.repoProjections.map((r) => r.id as string))
    expect(corpus.sliceIssues.some((i) => i.repoId != null && !known.has(i.repoId))).toBe(true)
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

/** Every sort key the corpus carries (wire, projection, slice) that a real
 *  server would refuse: `isSortKey` is the model's own well-formedness rule. */
const malformedSortKeys = (corpus: FixtureCorpus): string[] =>
  [...corpus.issues, ...corpus.issueProjections, ...corpus.sliceIssues].flatMap((row) => {
    const key = (row as { sortKey?: string | null }).sortKey ?? null
    return key === null || isSortKey(key) ? [] : [`${row.id}:${key}`]
  })

/**
 * The live table: one anonymised export of the live workspace
 * (2026-09-23T06:38:21Z, seq 5,828,147), measured by `measureShape`
 * (`docs/measurements/POD-4441-fixture-shape.md`, "Fixture vs live"). The
 * fixture is measured by the same instrument. Counts scale with the corpus;
 * shares and depths stay (POD-4635).
 */
const LIVE = {
  issues: 5170,
  sessions: 4624,
  visibleRows: 759,
  maxDepth: 6,
} as const
const LIVE_DEP_TYPES = ['blocks', 'related', 'supersedes', 'duplicate', 'waits-on', 'blocked-by']
const TOLERANCE = 0.2

interface LiveTarget {
  name: string
  live: number
  value: (m: ShapeMeasures) => number
  band: [number, number]
}

function liveTargets(scale: number): LiveTarget[] {
  const within = (live: number): [number, number] => [
    live * (1 - TOLERANCE),
    live * (1 + TOLERANCE),
  ]
  /** A count: live times the scale. */
  const count = (name: string, live: number, value: (m: ShapeMeasures) => number): LiveTarget => ({
    name,
    live,
    value,
    band: within(live * scale),
  })
  /** A count of repos and what they group: the same at every scale. */
  const fixed = (name: string, live: number, value: (m: ShapeMeasures) => number): LiveTarget => ({
    name,
    live,
    value,
    band: within(live),
  })
  /** A share of issues, sessions or visible rows: the same at every scale. */
  const share = (
    name: string,
    live: number,
    per: 'issues' | 'sessions' | 'visible',
    value: (m: ShapeMeasures) => number,
  ): LiveTarget => {
    const denominator = (m: ShapeMeasures) =>
      per === 'issues' ? m.issues : per === 'sessions' ? m.sessions : m.visibleRows
    const liveShare =
      live /
      (per === 'issues' ? LIVE.issues : per === 'sessions' ? LIVE.sessions : LIVE.visibleRows)
    return {
      name,
      live: liveShare,
      value: (m) => value(m) / denominator(m),
      band: within(liveShare),
    }
  }
  const depthAtLeast = (m: ShapeMeasures, d: number) =>
    Object.entries(m.depthHistogram).reduce((sum, [k, n]) => sum + (Number(k) >= d ? n : 0), 0)
  return [
    // Rows.
    count('visible rows', 759, (m) => m.visibleRows),
    count('top-level rows', 283, (m) => m.topLevelRows),
    count('nested rows', 476, (m) => m.nestedRows),
    count('worktree-kind rows', 4, (m) => m.worktreeRows),
    count('pinned rows', 21, (m) => m.pinnedRows),
    fixed('groups', 8, (m) => m.groups),
    share('closed-fold rows / visible', 71, 'visible', (m) => m.closedFoldRows),
    // Hierarchy.
    share('with parent / issues', 3159, 'issues', (m) => m.withParent),
    share('depth 3+ / issues', 889 + 506 + 61 + 4, 'issues', (m) => depthAtLeast(m, 3)),
    share('open / issues', 2284, 'issues', (m) => m.openIssues),
    // Edges.
    share('discovered-from / issues', 1788, 'issues', (m) => m.discoveredFromEdges),
    share('blocks / issues', 1751, 'issues', (m) => m.depsByType['blocks'] ?? 0),
    share('related / issues', 249, 'issues', (m) => m.depsByType['related'] ?? 0),
    share('supersedes / issues', 27, 'issues', (m) => m.depsByType['supersedes'] ?? 0),
    share('duplicate / issues', 16, 'issues', (m) => m.depsByType['duplicate'] ?? 0),
    share('blocked-by / issues', 13, 'issues', (m) => m.depsByType['blocked-by'] ?? 0),
    share('waits-on / issues', 11, 'issues', (m) => m.depsByType['waits-on'] ?? 0),
    share('startedBySession / issues', 3770, 'issues', (m) => m.withStartedBySession),
    share('coordinatorSessionId / issues', 1315, 'issues', (m) => m.withCoordinator),
    share('needsHuman / issues', 46, 'issues', (m) => m.needsHuman),
    // Repos and lanes.
    fixed('kernel repo prefixes', 9, (m) => m.repoPrefixes),
    fixed('repo-root lanes', 17, (m) => m.rootLanes),
    // M3 (POD-4591) F1: one repo's bucket is the cost the old fixture hid.
    share('largest repo / issues', 4574, 'issues', (m) => m.largestRepoIssues),
    count('nested lanes', 202, (m) => m.nestedLanes),
    count('fork-trap lane pairs', 19, (m) => m.forkTrapPairs),
    // Sessions and seating.
    share('prefix-owned / sessions', 701, 'sessions', (m) => m.prefixOwnedSessions),
    share(
      'prefix-owned seated by a root / sessions',
      152,
      'sessions',
      (m) => m.prefixOwnedByRootLane,
    ),
    share(
      'prefix-owned seated by a worktree / sessions',
      40,
      'sessions',
      (m) => m.prefixOwnedByWorktreeLane,
    ),
    share(
      'prefix-owned seated by no lane / sessions',
      509,
      'sessions',
      (m) => m.prefixOwnedUnresolved,
    ),
    share('sessions in repo-root lanes / sessions', 1287, 'sessions', (m) => m.sessionsInRootLanes),
    share('sessions with resume / sessions', 3493, 'sessions', (m) => m.sessionsWithResume),
    // One moment's snapshot (06:38Z, the quiet end of the day). Phase
    // shares follow it; the working share does not (live 0.7% of rows, 32
    // live sessions): the corpus keeps a working-day level so #2 and the
    // working roll-up have work to move. See the measurement doc.
    share('phase queued / visible', 284, 'visible', (m) => m.phases['queued'] ?? 0),
    share('phase waiting / visible', 281, 'visible', (m) => m.phases['waiting'] ?? 0),
    share('phase done / visible', 189, 'visible', (m) => m.phases['done'] ?? 0),
    {
      name: 'working rows / visible (chosen 2-10%, live 1.2%)',
      live: 9 / LIVE.visibleRows,
      value: (m) => m.workingRows / m.visibleRows,
      band: [0.02, 0.1],
    },
    {
      name: 'live sessions / sessions (chosen 1-4%, live 0.7%)',
      live: 32 / LIVE.sessions,
      value: (m) => m.liveSessions / m.sessions,
      band: [0.01, 0.04],
    },
  ]
}

/** Depth proportions in percent of all issues, keyed by depth. */
const depthShares = (stats: CorpusStats): Record<string, number> =>
  Object.fromEntries(
    Object.entries(stats.depthHistogram).map(([depth, count]) => [
      depth,
      (100 * count) / stats.issues,
    ]),
  )

describe.each([1, 2, 4] as const)('buildCorpus shape at %ix (POD-4551, POD-4635)', (scale) => {
  // Growth measurements only mean something if the corpus grows the way real
  // usage would: counts linear in scale, shares and depths the live ones.
  const corpus = buildCorpus(scale, 4443)
  const oneX = scale === 1 ? corpus : buildCorpus(1, 4443)
  const { stats } = corpus
  const locals: SliceLocals = { selectedIssueId: null, coarseNow: FIXED_NOW }
  const snapshot = expectedSnapshot(corpus, locals)
  // The oracle collapses resume twins as the runtime does (runtime.ts:465,
  // oracle.ts runLegacyDerivation). The disabled-collapse control is
  // test-local: the same corpus with every resume ref stripped leaves the
  // collapse nothing to match, which is exactly a derivation that forgets it.
  const raw = expectedSnapshot(
    {
      ...corpus,
      sessions: corpus.sessions.map((s) => {
        const { resume: _resume, ...rest } = s
        return rest as typeof s
      }),
    },
    locals,
  )
  const byId = new Map(corpus.issues.map((i) => [i.id as string, i]))
  const sessionById = new Map(corpus.sessions.map((s) => [s.sessionId as string, s]))
  // The instrument the live table was measured with (shape.ts).
  const measures = measureShape(corpus)

  it.each(liveTargets(scale))('$name: within 20% of the live table', (target) => {
    const got = target.value(measures)
    const [lo, hi] = target.band
    expect(got, `${target.name} = ${got}, live ${target.live}`).toBeGreaterThanOrEqual(lo)
    expect(got, `${target.name} = ${got}, live ${target.live}`).toBeLessThanOrEqual(hi)
  })

  it('reaches the live max depth (6) and keeps the depth histogram within 5 points of 1x', () => {
    expect(stats.maxDepth).toBe(LIVE.maxDepth)
    expect(measures.maxDepth).toBe(LIVE.maxDepth)
    const shares = depthShares(stats)
    const base = depthShares(oneX.stats)
    expect(Object.keys(shares).sort()).toEqual(Object.keys(base).sort())
    for (const depth of Object.keys(base)) {
      expect(Math.abs(shares[depth]! - base[depth]!), `depth ${depth}`).toBeLessThanOrEqual(5)
    }
  })

  it('carries every live dependency type', () => {
    for (const type of LIVE_DEP_TYPES)
      expect(measures.depsByType[type] ?? 0, type).toBeGreaterThan(0)
    expect(corpus.issueDeps).toHaveLength(
      Object.values(stats.depsByType).reduce((sum, n) => sum + n, 0),
    )
    expect(stats.withOriginEdge).toBe(measures.discoveredFromEdges)
  })

  it('never blocks a visible row on open work (spec §6: dependency semantics are out)', () => {
    // A `blocks` edge to unfinished work changes what a row asks
    // (issuePendingDecision). Live: 4 of 759 rows. The fixture keeps the
    // edges and leaves the semantics out of the comparison.
    const blocked = new Set(corpus.sliceIssues.filter((i) => i.blocked).map((i) => i.id))
    expect(blocked.size).toBeGreaterThan(0)
    expect(Object.keys(snapshot.rowsById).filter((id) => blocked.has(id))).toEqual([])
  })

  it('mints only sort keys the model accepts (isSortKey), on a meaningful share of rows', () => {
    expect(malformedSortKeys(corpus)).toEqual([])
    const keyed = corpus.sliceIssues.filter((i) => i.sortKey !== null).length
    expect(keyed).toBeGreaterThan(40 * scale)
  })

  it('control: a planted a0 key fails the sort-key check', () => {
    const target = corpus.sliceIssues.find((i) => i.sortKey !== null)!
    const planted: FixtureCorpus = {
      ...corpus,
      sliceIssues: corpus.sliceIssues.map((i) =>
        i.id === target.id ? { ...i, sortKey: 'a0' } : i,
      ),
    }
    expect(malformedSortKeys(planted)).toEqual([`${target.id}:a0`])
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
    // One full oracle run: ~1 s at 1x, tens of seconds at 4x under load
    // (the legacy derivation's own growth on the live-shaped corpus).
  }, 300_000)

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
      const row = snapshot.rowsById[group.issueId]!
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

  it('control: a derivation that forgets the collapse fails parity on exactly the tie rows', () => {
    expect(raw).not.toEqual(snapshot)
    expect(Object.keys(raw.rowsById).sort()).toEqual(Object.keys(snapshot.rowsById).sort())
    expect(raw.order).toEqual(snapshot.order)
    const changed = Object.keys(snapshot.rowsById).filter(
      (id) => JSON.stringify(raw.rowsById[id]) !== JSON.stringify(snapshot.rowsById[id]),
    )
    const ties = corpus.resumeTwins.filter((g) => g.kind === 'tie').map((g) => g.issueId)
    expect(ties).toHaveLength(scale)
    expect(changed.sort()).toEqual([...ties].sort())
    for (const id of ties) {
      expect(raw.rowsById[id]!.asking).toBe(true)
      expect(snapshot.rowsById[id]!.asking).toBe(false)
    }
  })
})
