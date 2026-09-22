/**
 * POD-4443 — fixture tests: determinism, exact counts, shape rules.
 *
 * Timing tests (4x build) live here too; walls are recorded, counts verdict.
 */
import { describe, expect, it } from 'vitest'
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

  it('has discovered-from edges on ~5% of issues', () => {
    const ratio = corpus.stats.withOriginEdge / corpus.stats.issues
    expect(ratio).toBeGreaterThan(0.03)
    expect(ratio).toBeLessThan(0.07)
  })

  it('has ~2,230 open issues (no closedAt)', () => {
    expect(corpus.stats.open).toBeGreaterThan(2000)
    expect(corpus.stats.open).toBeLessThan(2460)
  })

  it('attaches ~10% of sessions to a worktree path with no issueId', () => {
    const ratio = corpus.stats.prefixOwnedSessions / corpus.stats.sessions
    expect(ratio).toBeGreaterThan(0.08)
    expect(ratio).toBeLessThan(0.12)
    for (const s of corpus.sliceSessions) {
      if (s.issueId == null) expect(s.cwd).toMatch(/^\/w\//)
    }
  })

  it('exercises prefix ownership with forked worktree paths', () => {
    const paths = new Set(corpus.sliceWorktrees.map((w) => w.path))
    expect(paths.has('/w/alpha')).toBe(true)
    expect(paths.has('/w/alpha-fork')).toBe(true)
    expect(paths.has('/w/beta-fork')).toBe(true)
  })

  it('mints unique session ids and no resume refs (no legacy dedupe)', () => {
    const ids = corpus.sessions.map((s) => s.sessionId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const s of corpus.sessions) {
      expect(s as unknown as { resume?: unknown }).not.toHaveProperty('resume')
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
    Object.entries(stats.depthHistogram).map(([depth, count]) => [depth, (100 * count) / stats.issues]),
  )

describe.each([1, 2, 4] as const)('buildCorpus shape at %ix (POD-4551)', (scale) => {
  // Growth measurements only mean something if the corpus grows the way real
  // usage would: the same proportions, the visible set linear in scale.
  const corpus = buildCorpus(scale, 4443)
  const oneX = scale === 1 ? corpus : buildCorpus(1, 4443)
  const { stats } = corpus

  it('shows 211 x scale +/- 10% visible rows', () => {
    const count = Object.keys(expectedSnapshot(corpus, { selectedIssueId: null, coarseNow: FIXED_NOW }).rowsById).length
    console.info(`[fixture-shape] visible rows at ${scale}x: ${count}`)
    expect(count).toBeGreaterThanOrEqual(Math.ceil(211 * scale * 0.9))
    expect(count).toBeLessThanOrEqual(Math.floor(211 * scale * 1.1))
  }, 120_000)

  it('keeps the parent depth histogram within 5 points of 1x', () => {
    const shares = depthShares(stats)
    const base = depthShares(oneX.stats)
    console.info(`[fixture-shape] depth histogram at ${scale}x: ${JSON.stringify(stats.depthHistogram)}`)
    expect(Object.keys(shares).sort()).toEqual(Object.keys(base).sort())
    for (const depth of Object.keys(base)) {
      expect(Math.abs(shares[depth]! - base[depth]!), `depth ${depth}`).toBeLessThanOrEqual(5)
    }
    expect(stats.maxDepth).toBe(4)
  })

  it('attaches ~10% of sessions to a worktree path with no issueId', () => {
    const ratio = stats.prefixOwnedSessions / stats.sessions
    console.info(`[fixture-shape] prefix-owned sessions at ${scale}x: ${stats.prefixOwnedSessions} (${(100 * ratio).toFixed(1)}%)`)
    expect(ratio).toBeGreaterThan(0.08)
    expect(ratio).toBeLessThan(0.12)
  })

  it('carries discovered-from edges on ~5% of issues', () => {
    const ratio = stats.withOriginEdge / stats.issues
    console.info(`[fixture-shape] discovered-from edges at ${scale}x: ${stats.withOriginEdge} (${(100 * ratio).toFixed(1)}%)`)
    expect(ratio).toBeGreaterThan(0.04)
    expect(ratio).toBeLessThan(0.06)
    expect(corpus.issueDeps).toHaveLength(stats.withOriginEdge)
  })
})
