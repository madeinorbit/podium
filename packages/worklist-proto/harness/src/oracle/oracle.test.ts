/**
 * POD-4443 — oracle tests: visible range, negative control, completeness.
 *
 * The oracle IS the legacy derivation, so these tests pin the truth the arms
 * are judged against: the 1x visible count (recorded in
 * docs/measurements/POD-4441-fixture-shape.md), the one-title-mutation
 * control, and per-field coverage of the projection.
 */
import { describe, expect, it } from 'vitest'
import type { SliceLocals } from '../../../shared/src/slice-types'
import { buildCorpus, FIXED_NOW } from '../fixture/index'
import { expectedSnapshot } from './index'

const locals = (overrides: Partial<SliceLocals> = {}): SliceLocals => ({
  selectedIssueId: null,
  coarseNow: FIXED_NOW,
  ...overrides,
})

describe('expectedSnapshot at 1x', () => {
  const corpus = buildCorpus(1, 4443)
  const snapshot = expectedSnapshot(corpus, locals())

  it('shows 211 +/- 10% visible rows', () => {
    const count = Object.keys(snapshot.rowsById).length
    console.info(`[fixture-shape] visible rows at 1x: ${count}`)
    expect(count).toBeGreaterThanOrEqual(190)
    expect(count).toBeLessThanOrEqual(232)
  })

  it('keeps order ids resolving to rows with bands in range', () => {
    expect(snapshot.order.pinnedIds.length).toBeGreaterThan(0)
    const ordered = [
      ...snapshot.order.pinnedIds,
      ...snapshot.order.groups.flatMap((g) => [...g.rowIds, ...g.closedIds]),
    ]
    expect(new Set(ordered).size).toBe(ordered.length)
    for (const id of ordered) {
      expect(snapshot.rowsById[id], `ordered id ${id} has no row`).toBeDefined()
    }
    expect(Object.keys(snapshot.rowsById).sort()).toEqual([...ordered].sort())
    for (const row of Object.values(snapshot.rowsById)) {
      expect([0, 1, 2]).toContain(row.band)
    }
  })

  it('covers all three bands, the closed fold and the pinned section', () => {
    const rows = Object.values(snapshot.rowsById)
    expect(rows.some((r) => r.band === 0)).toBe(true)
    expect(rows.some((r) => r.band === 1)).toBe(true)
    expect(rows.some((r) => r.band === 2)).toBe(true)
    expect(rows.some((r) => r.closed)).toBe(true)
    expect(snapshot.order.groups.some((g) => g.closedIds.length > 0)).toBe(true)
  })

  it('populates every SliceRow field for at least one row', () => {
    const rows = Object.values(snapshot.rowsById)
    expect(rows.some((r) => r.phase === 'working')).toBe(true)
    expect(rows.some((r) => r.phase === 'waiting')).toBe(true)
    expect(rows.some((r) => r.phase === 'queued')).toBe(true)
    expect(rows.some((r) => r.phase === 'done')).toBe(true)
    expect(rows.some((r) => r.working)).toBe(true)
    expect(rows.some((r) => r.asking)).toBe(true)
    expect(rows.some((r) => r.progressTotal > 0)).toBe(true)
    expect(rows.some((r) => r.progressDone > 0)).toBe(true)
    expect(rows.some((r) => r.displayRef.startsWith('#'))).toBe(true)
    expect(rows.some((r) => !r.displayRef.startsWith('#'))).toBe(true)
    expect(rows.every((r) => r.title.length > 0)).toBe(true)
    expect(rows.every((r) => r.repoKey.length > 0)).toBe(true)
  })
})

describe('unscanned worktree seat (POD-4550)', () => {
  // The prefix relation must seat a session under a live issue's worktree
  // even when no scan reported that worktree. The fixture's case is a
  // sessionless visible root whose ONLY working session is that orphan, so
  // the row reads working iff the seat happened.
  const corpus = buildCorpus(1, 4443)
  const { issueId, sessionId } = corpus.unscannedWorktree

  it('seats the orphan: the row reads working', () => {
    const row = expectedSnapshot(corpus, locals()).rowsById[issueId]
    expect(row, 'the unscanned-worktree issue is visible').toBeDefined()
    expect(row!.working).toBe(true)
    expect(row!.phase).toBe('working')
  })

  it('control: moving the orphan elsewhere leaves the row not working', () => {
    const moved: typeof corpus = {
      ...corpus,
      sessions: corpus.sessions.map((s) =>
        s.sessionId === sessionId ? { ...s, cwd: '/nowhere/sub' } : s,
      ),
    }
    const row = expectedSnapshot(moved, locals()).rowsById[issueId]
    expect(row).toBeDefined()
    expect(row!.working).toBe(false)
  })
})

describe('expectedSnapshot negative control', () => {
  it('a one-title mutation changes exactly that row', () => {
    const corpus = buildCorpus(1, 4443)
    const before = expectedSnapshot(corpus, locals())
    const ids = Object.keys(before.rowsById)
    // A non-draft visible row: display title tracks the wire title 1:1.
    const target = ids.find((id) => !before.rowsById[id]!.displayRef.startsWith('#'))!
    const mutated: typeof corpus = {
      ...corpus,
      issues: corpus.issues.map((issue) =>
        issue.id === target ? { ...issue, title: `${issue.title} (edited)` } : issue,
      ),
      issueProjections: corpus.issueProjections.map((projection) =>
        projection.id === target
          ? { ...projection, title: `${projection.title} (edited)` }
          : projection,
      ),
      sliceIssues: corpus.sliceIssues.map((issue) =>
        issue.id === target ? { ...issue, title: `${issue.title} (edited)` } : issue,
      ),
    }
    const after = expectedSnapshot(mutated, locals())
    expect(after.order).toEqual(before.order)
    const changed = ids.filter(
      (id) => JSON.stringify(after.rowsById[id]) !== JSON.stringify(before.rowsById[id]),
    )
    expect(changed).toEqual([target])
    expect(after.rowsById[target]!.title).toContain('(edited)')
  })
})

describe('expectedSnapshot timings', () => {
  it('builds the 4x corpus in under 10 s', () => {
    const start = performance.now()
    buildCorpus(4, 4443)
    const ms = performance.now() - start
    console.info(`[fixture-shape] 4x build ms: ${Math.round(ms)}`)
    expect(ms).toBeLessThan(10_000)
  }, 120_000)

  it('runs the 1x oracle in under 5 s', () => {
    const corpus = buildCorpus(1, 4443)
    const start = performance.now()
    expectedSnapshot(corpus, locals())
    const ms = performance.now() - start
    console.info(`[fixture-shape] 1x oracle ms: ${Math.round(ms)}`)
    expect(ms).toBeLessThan(5_000)
  }, 120_000)
})
