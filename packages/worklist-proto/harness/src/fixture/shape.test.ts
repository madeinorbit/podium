/**
 * POD-4552 — the shape instrument and the anonymiser, proven before any live
 * number is read: the row-level measures agree with the generator's own stats
 * on the fixture, repo-root lanes are measured (and a lane list without them
 * measures differently), and hashing keeps both the oracle snapshot and every
 * lane relation, including the fork trap.
 */
import type { GitRepositoryWire, SessionMeta } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { expectedSnapshot } from '../oracle/index'
import { buildCorpus, type FixtureCorpus } from './index'
import {
  anonymisationParity,
  anonymiseCollections,
  corpusFromLive,
  Hasher,
  KEEP_KEYS,
  type LiveCollections,
} from './live-snapshot'
import { compareShapes, forkTrapPairs, measureShape } from './shape'

const fixture = buildCorpus(1, 4443)
const NOW = fixture.fixedNow

const collectionsOf = (corpus: FixtureCorpus): LiveCollections => ({
  issues: corpus.issues,
  issueProjections: corpus.issueProjections,
  sessions: corpus.sessions,
  repoProjections: corpus.repoProjections,
  issueDeps: corpus.issueDeps,
  repos: corpus.repos,
  machines: corpus.machines,
  pins: corpus.pins,
})

describe('measureShape on the fixture (1x) agrees with the generator', () => {
  const m = measureShape(fixture)
  const { stats } = fixture

  it('counts parents, open issues, depths, origin edges and prefix-owned sessions as buildCorpus does', () => {
    expect(m.issues).toBe(stats.issues)
    expect(m.sessions).toBe(stats.sessions)
    expect(m.withParent).toBe(stats.withParent)
    expect(m.openIssues).toBe(stats.open)
    expect(m.depthHistogram).toEqual(stats.depthHistogram)
    expect(m.maxDepth).toBe(stats.maxDepth)
    expect(m.discoveredFromEdges).toBe(stats.withOriginEdge)
    expect(m.prefixOwnedSessions).toBe(stats.prefixOwnedSessions)
  })

  it('counts the oracle rows corpus.test.ts counts, split into top-level and nested', () => {
    const snapshot = expectedSnapshot(fixture, { selectedIssueId: null, coarseNow: NOW })
    expect(m.visibleRows).toBe(Object.keys(snapshot.rowsById).length)
    expect(m.topLevelRows + m.nestedRows).toBe(m.visibleRows)
    expect(m.nestedRows).toBeGreaterThan(0)
  })

  it('compares against itself with no follow-ups', () => {
    expect(compareShapes(m, m).filter((r) => r.followUp)).toEqual([])
  })
})

// A tiny workspace with every lane relation the live snapshot has and the
// fixture's static `sliceWorktrees` lacks (coordinator addendum, POD-4565):
// a repo root that is itself a lane, a worktree nested INSIDE that root
// (`<repo>/.worktrees/a`, longest prefix must win), and a string-prefix
// sibling (`/r` vs `/r-fork`).
const scanRow = (path: string, worktrees: string[] = []): GitRepositoryWire =>
  ({ path, branch: 'main', worktrees: worktrees.map((p) => ({ path: p, branch: 'task' })) }) as never

const session = (sessionId: string, cwd: string): SessionMeta =>
  ({
    sessionId,
    cwd,
    agentKind: 'claude',
    status: 'exited',
    archived: false,
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    createdAt: new Date(NOW - 120_000).toISOString(),
    title: `session in ${cwd}`,
  }) as never

const lanesWorkspace: LiveCollections = {
  issues: [],
  issueProjections: [],
  repoProjections: [],
  issueDeps: [],
  machines: [],
  pins: { panels: [], worktrees: [], repos: [] },
  repos: [scanRow('/r', ['/r/.worktrees/a']), scanRow('/r-fork')],
  sessions: [
    session('s-root', '/r/src'), // no issueId: seated by the repo-root lane only
    session('s-nested', '/r/.worktrees/a/pkg'), // the nested worktree, not the root
    session('s-fork', '/r-fork/x'), // the sibling root, never `/r`
    session('s-none', '/elsewhere'), // no lane at all
  ],
}

describe('repo-root lanes (POD-4565 addendum)', () => {
  const corpus = corpusFromLive(lanesWorkspace, NOW)

  it('measures root lanes, nested lanes, the fork trap and root-lane seating from the legacy sections', () => {
    const m = measureShape(corpus)
    expect(m.lanes).toBe(3)
    expect(m.rootLanes).toBe(2)
    expect(m.worktreeLanes).toBe(1)
    expect(m.nestedLanes).toBe(1)
    expect(m.forkTrapPairs).toBe(1)
    expect(m.prefixOwnedSessions).toBe(4)
    // s-root and s-fork by root lanes; s-nested by the worktree inside /r.
    expect(m.prefixOwnedByRootLane).toBe(2)
    expect(m.prefixOwnedByWorktreeLane).toBe(1)
    expect(m.prefixOwnedUnresolved).toBe(1)
  })

  it('control: a lane list without repo roots (the fixture sliceWorktrees shape) unseats the root sessions', () => {
    const m = measureShape(corpus, { lanes: [{ path: '/r/.worktrees/a', root: false }] })
    expect(m.rootLanes).toBe(0)
    expect(m.prefixOwnedByRootLane).toBe(0)
    expect(m.prefixOwnedUnresolved).toBe(3)
    expect(m.prefixOwnedByWorktreeLane).toBe(1)
  })
})

describe('anonymisation', () => {
  it('keeps every lane relation and seating when paths are hashed', () => {
    const raw = measureShape(corpusFromLive(lanesWorkspace, NOW))
    const hashed = measureShape(corpusFromLive(anonymiseCollections(lanesWorkspace), NOW))
    expect(hashed).toEqual(raw)
  })

  it('control: hashing each segment alone loses the fork trap', () => {
    const naive = anonymiseCollections(lanesWorkspace, new Hasher(undefined, KEEP_KEYS, false))
    const paths = naive.repos.map((r) => r.path)
    expect(forkTrapPairs(lanesWorkspace.repos.map((r) => r.path))).toBe(1)
    expect(forkTrapPairs(paths)).toBe(0)
    const aware = anonymiseCollections(lanesWorkspace)
    expect(forkTrapPairs(aware.repos.map((r) => r.path))).toBe(1)
  })

  it('leaves the fixture oracle snapshot unchanged except titles, and no raw title or path survives', () => {
    const raw = collectionsOf(fixture)
    const anonymised = anonymiseCollections(raw)
    const parity = anonymisationParity(raw, anonymised, NOW)
    expect(parity.differingRows).toEqual([])
    expect(parity.equalExceptTitles).toBe(true)
    expect(parity.anonymisedVisibleRows).toBe(parity.rawVisibleRows)
    const text = JSON.stringify(anonymised)
    for (const issue of fixture.issues.slice(0, 50)) expect(text).not.toContain(issue.title)
    for (const s of fixture.sessions.slice(0, 50)) expect(text).not.toContain(`"${s.cwd}"`)
    expect(text).not.toContain('/w/alpha')
  }, 60_000)

  it('control: hashing a field the derivation reads (stage) fails parity', () => {
    const raw = collectionsOf(fixture)
    const keep = new Set([...KEEP_KEYS].filter((k) => k !== 'stage'))
    const broken = anonymiseCollections(raw, new Hasher(undefined, keep))
    const parity = anonymisationParity(raw, broken, NOW)
    expect(parity.equalExceptTitles).toBe(false)
    expect(parity.differingRows.length).toBeGreaterThan(0)
  }, 60_000)
})
