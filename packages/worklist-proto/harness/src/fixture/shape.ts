/**
 * POD-4552 — shape measures of a corpus, computed from its rows alone, so the
 * fixture (`buildCorpus`) and a live snapshot (`corpusFromLive`) are measured
 * by the same code. `shape.test.ts` proves the row-level measures agree with
 * the generator's own `stats` on the fixture before any live number is read.
 *
 * Visible rows, phases and groups come from the parity oracle
 * (`expectedSnapshot`). Lanes come from the legacy derivation's own sections
 * (`slice.sections`, the lanes the app shows): a repo root is a lane of its
 * own (`isMain`), next to its linked worktrees. Session ownership is the
 * legacy longest-prefix rule (`worktreeForCwdIndexed` over those lanes).
 */

import { dedupeSessions } from '@podium/client-core/engine'
import {
  issueFinishedAt,
  reposVisibleOnMachines,
  SIDEBAR_FINISHED_GRACE_MS,
} from '@podium/client-core/viewmodels'
import { buildWorktreeRootIndex, worktreeForCwdIndexed } from '@podium/model'
import type { SliceLocals, SliceSnapshot } from '../../../shared/src/slice-types'
import { projectSnapshot, runLegacyDerivation } from '../oracle/index'
import type { FixtureCorpus } from './index'

/** One lane as the legacy sections list it. */
export interface ShapeLane {
  path: string
  /** A repo root (the scan row's own path), not a linked worktree. */
  root: boolean
}

export interface ShapeMeasures {
  issues: number
  sessions: number
  repoPrefixes: number
  scanRepos: number
  /** Oracle rows (the parity surface): top-level rows plus every nested
   *  started-by descendant (`flattenIssueRows`). */
  visibleRows: number
  /** Top-level issue rows of `slice.work`, and rows nested under them. */
  topLevelRows: number
  nestedRows: number
  /** Worktree-kind rows of `slice.work` (dropped by the slice, spec §6). */
  worktreeRows: number
  openIssues: number
  withParent: number
  maxDepth: number
  /** Issues per chain depth (1 = root), from `parentId` walks. */
  depthHistogram: Record<string, number>
  /** Issues with an outgoing `discovered-from` dep. */
  discoveredFromEdges: number
  /** Dependency rows by type (`issueDeps`). */
  depsByType: Record<string, number>
  /** Sessions with no `issueId` (owned by path prefix alone). */
  prefixOwnedSessions: number
  lanes: number
  rootLanes: number
  worktreeLanes: number
  /** Lanes strictly inside another lane (`<repo>/.worktrees/x`). */
  nestedLanes: number
  /** Lane pairs where one path is a string prefix of the other without being
   *  its directory (`/w/alpha` vs `/w/alpha-fork`). */
  forkTrapPairs: number
  /** Prefix-owned sessions by the lane that owns them (longest prefix). */
  prefixOwnedByRootLane: number
  prefixOwnedByWorktreeLane: number
  prefixOwnedUnresolved: number
  /** All sessions (bound or not) whose cwd resolves to a repo-root lane. */
  sessionsInRootLanes: number
  /** Issues carrying `startedBySession` / `coordinatorSessionId` / `needsHuman`. */
  withStartedBySession: number
  withCoordinator: number
  needsHuman: number
  sessionsWithResume: number
  liveSessions: number
  groups: number
  pinnedRows: number
  closedFoldRows: number
  askingRows: number
  workingRows: number
  phases: Record<string, number>
  /** Sessions sharing one resume ref (groups of 2+), and the sessions the
   *  runtime's collapse (`dedupeSessions`) removes. */
  resumeTwinGroups: number
  sessionsCollapsed: number
  /** Lanes no issue names as its `worktreePath` and no session sits in: the
   *  feed announces them from discovery alone (POD-4606). */
  discoveryOnlyLanes: number
  /** Scan repos on a machine the principal cannot see: legacy drops them
   *  (`reposVisibleOnMachines`); the feed does not (a known divergence). */
  hiddenMachineRepos: number
  /** Closed, unarchived, undeleted issues finished within the 24 h grace
   *  window (`SIDEBAR_FINISHED_GRACE_MS`) at `coarseNow`. */
  graceWindowClosed: number
  /** Oracle rows labelled `PREFIX-seq` (the repo-row prefix join, POD-4624). */
  prefixedRows: number
}

const str = (row: unknown, key: string): string | null => {
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Chain depth per issue id (1 = root); cycles and dangling parents stop the walk. */
export function depthsOf(issues: readonly { id: string }[]): Map<string, number> {
  const parentOf = new Map(issues.map((i) => [i.id, str(i, 'parentId')] as const))
  const depth = new Map<string, number>()
  const walk = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    const seen = new Set<string>([id])
    let d = 1
    let cur = parentOf.get(id) ?? null
    while (cur !== null && parentOf.has(cur) && !seen.has(cur)) {
      const cached = depth.get(cur)
      if (cached !== undefined) {
        d += cached
        break
      }
      seen.add(cur)
      d++
      cur = parentOf.get(cur) ?? null
    }
    depth.set(id, d)
    return d
  }
  for (const i of issues) walk(i.id)
  return depth
}

/** Pairs of lanes where one is a string prefix of the other but not its parent. */
export function forkTrapPairs(paths: readonly string[]): number {
  const sorted = [...new Set(paths)].sort()
  let pairs = 0
  // Sorted order puts every string extension right after its prefix run.
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!
    for (let j = i + 1; j < sorted.length && sorted[j]!.startsWith(a); j++) {
      if (!sorted[j]!.startsWith(a.endsWith('/') ? a : `${a}/`)) pairs++
    }
  }
  return pairs
}

/**
 * Measure a corpus. `lanes` defaults to the legacy sections' lanes; tests pass
 * a lane list to prove a measure is armed.
 */
export function measureShape(
  corpus: FixtureCorpus,
  opts: { lanes?: ShapeLane[] } = {},
): ShapeMeasures {
  const locals: SliceLocals = { selectedIssueId: null, coarseNow: corpus.fixedNow }
  const derivation = runLegacyDerivation(corpus, locals)
  const snapshot = projectSnapshot(derivation, locals)
  const lanes = opts.lanes ?? legacyLanes(derivation)

  const depths = depthsOf(corpus.issues)
  const depthHistogram: Record<string, number> = {}
  let maxDepth = 0
  for (const d of depths.values()) {
    depthHistogram[String(d)] = (depthHistogram[String(d)] ?? 0) + 1
    if (d > maxDepth) maxDepth = d
  }

  const depsByType: Record<string, number> = {}
  const originIssues = new Set<string>()
  for (const dep of corpus.issueDeps) {
    const type = str(dep, 'type') ?? '?'
    depsByType[type] = (depsByType[type] ?? 0) + 1
    if (type === 'discovered-from') originIssues.add(str(dep, 'fromId') ?? '')
  }

  const rootPaths = new Set(lanes.filter((l) => l.root).map((l) => l.path))
  const lanePaths = lanes.map((l) => l.path)
  const laneIndex = buildWorktreeRootIndex(lanePaths)
  const nestedLanes = lanePaths.filter((p) => {
    const parent = p.slice(0, Math.max(0, p.lastIndexOf('/')))
    return parent !== '' && worktreeForCwdIndexed(parent, laneIndex) !== null
  }).length

  let prefixOwned = 0
  let byRoot = 0
  let byWorktree = 0
  let unresolved = 0
  let inRoot = 0
  let withResume = 0
  let live = 0
  for (const s of corpus.sessions) {
    const owner = worktreeForCwdIndexed(s.cwd, laneIndex)
    const isRoot = owner !== null && rootPaths.has(owner)
    if (isRoot) inRoot++
    if (s.resume !== undefined && s.resume !== null) withResume++
    if (s.status === 'live') live++
    if (s.issueId != null) continue
    prefixOwned++
    if (owner === null) unresolved++
    else if (isRoot) byRoot++
    else byWorktree++
  }

  const work = derivation.slice.work
  const topLevelRows = work.filter((r) => r.kind === 'issue').length
  const rows = Object.values(snapshot.rowsById)
  const resumeGroups = new Map<string, number>()
  for (const s of corpus.sessions)
    if (s.resume) {
      const key = `${s.resume.kind}:${s.resume.value}`
      resumeGroups.set(key, (resumeGroups.get(key) ?? 0) + 1)
    }
  const namedLanes = new Set<string>()
  for (const i of corpus.issues) {
    const wt = str(i, 'worktreePath')
    if (wt !== null) namedLanes.add(wt)
  }
  for (const s of corpus.sessions) {
    const owner = worktreeForCwdIndexed(s.cwd, laneIndex)
    if (owner !== null) namedLanes.add(owner)
  }
  const phases: Record<string, number> = {}
  for (const row of rows) phases[row.phase] = (phases[row.phase] ?? 0) + 1

  return {
    issues: corpus.issues.length,
    sessions: corpus.sessions.length,
    repoPrefixes: corpus.repoProjections.length,
    scanRepos: corpus.repos.length,
    visibleRows: rows.length,
    topLevelRows,
    nestedRows: rows.length - topLevelRows,
    worktreeRows: work.length - topLevelRows,
    openIssues: corpus.issues.filter((i) => str(i, 'closedAt') === null).length,
    withParent: corpus.issues.filter((i) => str(i, 'parentId') !== null).length,
    maxDepth,
    depthHistogram,
    discoveredFromEdges: originIssues.size,
    depsByType,
    prefixOwnedSessions: prefixOwned,
    lanes: lanes.length,
    rootLanes: rootPaths.size,
    worktreeLanes: lanes.length - rootPaths.size,
    nestedLanes,
    forkTrapPairs: forkTrapPairs(lanePaths),
    prefixOwnedByRootLane: byRoot,
    prefixOwnedByWorktreeLane: byWorktree,
    prefixOwnedUnresolved: unresolved,
    sessionsInRootLanes: inRoot,
    withStartedBySession: corpus.issues.filter((i) => str(i, 'startedBySession') !== null).length,
    withCoordinator: corpus.issues.filter((i) => str(i, 'coordinatorSessionId') !== null).length,
    needsHuman: corpus.issues.filter((i) => (i as { needsHuman?: boolean }).needsHuman === true)
      .length,
    sessionsWithResume: withResume,
    liveSessions: live,
    groups: snapshot.order.groups.length,
    pinnedRows: snapshot.order.pinnedIds.length,
    closedFoldRows: rows.filter((r) => r.closed).length,
    askingRows: rows.filter((r) => r.asking).length,
    workingRows: rows.filter((r) => r.working).length,
    phases,
    resumeTwinGroups: [...resumeGroups.values()].filter((n) => n > 1).length,
    sessionsCollapsed: corpus.sessions.length - dedupeSessions(corpus.sessions).length,
    discoveryOnlyLanes: lanePaths.filter((p) => !namedLanes.has(p)).length,
    hiddenMachineRepos:
      corpus.repos.length - reposVisibleOnMachines(corpus.repos, corpus.machines).length,
    graceWindowClosed: corpus.issues.filter(
      (i) =>
        str(i, 'closedAt') !== null &&
        str(i, 'deletedAt') === null &&
        (i as { archived?: boolean }).archived !== true &&
        corpus.fixedNow - issueFinishedAt(i) <= SIDEBAR_FINISHED_GRACE_MS,
    ).length,
    prefixedRows: prefixFidelity(corpus, snapshot).prefixedRows,
  }
}

export interface PrefixFidelity {
  repoRows: number
  /** Oracle rows whose label is `PREFIX-seq`. */
  prefixedRows: number
  /** Rows whose label disagrees with their repo row's prefix (`id: got≠want`). */
  mismatches: string[]
}

/**
 * The `POD-123` labels are only a comparison if the repo rows survived: every
 * oracle row whose issue's repo has a prefix row must read `PREFIX-seq`, and
 * at least one must. A snapshot that lost the `repo` entity reads `#seq`
 * everywhere and fails here (POD-4624).
 */
export function prefixFidelity(corpus: FixtureCorpus, snapshot: SliceSnapshot): PrefixFidelity {
  const prefixOf = new Map(
    corpus.repoProjections.map((r) => [r.id as string, str(r, 'prefix')] as const),
  )
  const issueById = new Map(corpus.issueProjections.map((i) => [i.id as string, i] as const))
  const mismatches: string[] = []
  let prefixedRows = 0
  for (const row of Object.values(snapshot.rowsById)) {
    const issue = issueById.get(row.id)
    const repoId = issue === undefined ? null : str(issue, 'repoId')
    const prefix = repoId === null ? null : (prefixOf.get(repoId) ?? null)
    if (prefix === null) continue
    const want = `${prefix}-${(issue as { seq: number }).seq}`
    if (row.displayRef === want) prefixedRows++
    else mismatches.push(`${row.id}: ${row.displayRef}≠${want}`)
  }
  return { repoRows: corpus.repoProjections.length, prefixedRows, mismatches }
}

/** Throws unless the snapshot carries repo rows and the labels join them. */
export function assertPrefixFidelity(fidelity: PrefixFidelity): void {
  if (fidelity.repoRows === 0 || fidelity.prefixedRows === 0 || fidelity.mismatches.length > 0)
    throw new Error(
      `prefix join lost: ${fidelity.repoRows} repo rows, ${fidelity.prefixedRows} PREFIX-seq rows, ${fidelity.mismatches.length} mismatches (${fidelity.mismatches.slice(0, 3).join('; ')})`,
    )
}

/** The lanes the legacy sections show, pinned repos included. */
function legacyLanes(derivation: ReturnType<typeof runLegacyDerivation>): ShapeLane[] {
  const { sections } = derivation.slice
  const out = new Map<string, ShapeLane>()
  for (const repo of [...sections.pinnedRepos, ...sections.repos])
    for (const wt of repo.worktrees) out.set(wt.path, { path: wt.path, root: wt.isMain })
  return [...out.values()]
}

// ------------------------------------------------------------- comparison

export interface ShapeComparisonRow {
  measure: string
  fixture: number
  live: number
  /** How the two are compared: a count, or a share of `per` (issues, sessions…). */
  basis: 'count' | 'share'
  /** |live − fixture| / fixture on the compared value; Infinity when the
   *  fixture is 0 and live is not. */
  deviation: number
  /** Deviation above 20%: a fixture follow-up. */
  followUp: boolean
}

type Picker = {
  measure: string
  value: (m: ShapeMeasures) => number
  per?: (m: ShapeMeasures) => number
}

const perIssue = (m: ShapeMeasures) => m.issues
const perSession = (m: ShapeMeasures) => m.sessions
const perVisible = (m: ShapeMeasures) => m.visibleRows

/** The measures the table carries, in order. Shares are compared as shares. */
export function comparisonPickers(fixture: ShapeMeasures, live: ShapeMeasures): Picker[] {
  const depths = [
    ...new Set([...Object.keys(fixture.depthHistogram), ...Object.keys(live.depthHistogram)]),
  ].sort((a, b) => Number(a) - Number(b))
  const depTypes = [
    ...new Set([...Object.keys(fixture.depsByType), ...Object.keys(live.depsByType)]),
  ].sort()
  const phases = ['queued', 'working', 'waiting', 'done']
  return [
    { measure: 'issues', value: (m) => m.issues },
    { measure: 'sessions', value: (m) => m.sessions },
    { measure: 'repo prefixes (kernel `repo` rows)', value: (m) => m.repoPrefixes },
    { measure: 'scan repos (`GitRepositoryWire`)', value: (m) => m.scanRepos },
    { measure: 'visible rows (oracle `rowsById`)', value: (m) => m.visibleRows },
    { measure: 'top-level rows', value: (m) => m.topLevelRows },
    { measure: 'nested (started-by) rows', value: (m) => m.nestedRows },
    { measure: 'worktree-kind rows (dropped)', value: (m) => m.worktreeRows },
    { measure: 'open issues / issues', value: (m) => m.openIssues, per: perIssue },
    { measure: 'with parent / issues', value: (m) => m.withParent, per: perIssue },
    ...depths.map<Picker>((d) => ({
      measure: `depth ${d} / issues`,
      value: (m) => m.depthHistogram[d] ?? 0,
      per: perIssue,
    })),
    { measure: 'max depth', value: (m) => m.maxDepth },
    {
      measure: 'discovered-from edges / issues',
      value: (m) => m.discoveredFromEdges,
      per: perIssue,
    },
    ...depTypes
      .filter((t) => t !== 'discovered-from')
      .map<Picker>((t) => ({
        measure: `\`${t}\` deps / issues`,
        value: (m) => m.depsByType[t] ?? 0,
        per: perIssue,
      })),
    {
      measure: 'prefix-owned sessions / sessions',
      value: (m) => m.prefixOwnedSessions,
      per: perSession,
    },
    { measure: 'lanes', value: (m) => m.lanes },
    { measure: 'repo-root lanes', value: (m) => m.rootLanes },
    { measure: 'worktree lanes', value: (m) => m.worktreeLanes },
    { measure: 'nested lanes (inside another lane)', value: (m) => m.nestedLanes },
    { measure: 'fork-trap lane pairs', value: (m) => m.forkTrapPairs },
    {
      measure: 'prefix-owned → repo-root lane / sessions',
      value: (m) => m.prefixOwnedByRootLane,
      per: perSession,
    },
    {
      measure: 'prefix-owned → worktree lane / sessions',
      value: (m) => m.prefixOwnedByWorktreeLane,
      per: perSession,
    },
    {
      measure: 'prefix-owned → no lane / sessions',
      value: (m) => m.prefixOwnedUnresolved,
      per: perSession,
    },
    {
      measure: 'sessions in repo-root lanes / sessions',
      value: (m) => m.sessionsInRootLanes,
      per: perSession,
    },
    { measure: '`startedBySession` / issues', value: (m) => m.withStartedBySession, per: perIssue },
    { measure: '`coordinatorSessionId` / issues', value: (m) => m.withCoordinator, per: perIssue },
    { measure: '`needsHuman` / issues', value: (m) => m.needsHuman, per: perIssue },
    {
      measure: 'sessions with `resume` / sessions',
      value: (m) => m.sessionsWithResume,
      per: perSession,
    },
    { measure: 'live sessions / sessions', value: (m) => m.liveSessions, per: perSession },
    { measure: 'resume-twin groups (2+ sessions, one ref)', value: (m) => m.resumeTwinGroups },
    { measure: 'sessions removed by the twin collapse', value: (m) => m.sessionsCollapsed },
    { measure: 'discovery-only lanes', value: (m) => m.discoveryOnlyLanes },
    { measure: 'scan repos on hidden machines', value: (m) => m.hiddenMachineRepos },
    { measure: 'closed issues in the 24 h grace window', value: (m) => m.graceWindowClosed },
    { measure: '`PREFIX-seq` rows / visible', value: (m) => m.prefixedRows, per: perVisible },
    { measure: 'groups', value: (m) => m.groups },
    { measure: 'pinned rows', value: (m) => m.pinnedRows },
    { measure: 'closed-fold rows / visible', value: (m) => m.closedFoldRows, per: perVisible },
    { measure: 'asking rows / visible', value: (m) => m.askingRows, per: perVisible },
    { measure: 'working rows / visible', value: (m) => m.workingRows, per: perVisible },
    ...phases.map<Picker>((p) => ({
      measure: `phase ${p} / visible`,
      value: (m) => m.phases[p] ?? 0,
      per: perVisible,
    })),
  ]
}

export const FOLLOW_UP_THRESHOLD = 0.2

export function compareShapes(fixture: ShapeMeasures, live: ShapeMeasures): ShapeComparisonRow[] {
  return comparisonPickers(fixture, live).map((p) => {
    const f = p.per ? p.value(fixture) / Math.max(1, p.per(fixture)) : p.value(fixture)
    const l = p.per ? p.value(live) / Math.max(1, p.per(live)) : p.value(live)
    const deviation = f === 0 ? (l === 0 ? 0 : Number.POSITIVE_INFINITY) : Math.abs(l - f) / f
    return {
      measure: p.measure,
      fixture: p.value(fixture),
      live: p.value(live),
      basis: p.per ? 'share' : 'count',
      deviation,
      followUp: deviation > FOLLOW_UP_THRESHOLD,
    }
  })
}

/** The markdown table the measurement doc carries. */
export function renderComparison(
  rows: ShapeComparisonRow[],
  fixture: ShapeMeasures,
  live: ShapeMeasures,
): string {
  const fmt = (n: number) => n.toLocaleString('en-US')
  const cell = (row: ShapeComparisonRow, value: number, of: ShapeMeasures) => {
    if (row.basis === 'count') return fmt(value)
    const denominator = row.measure.endsWith('/ visible')
      ? of.visibleRows
      : row.measure.includes('/ sessions')
        ? of.sessions
        : of.issues
    return `${fmt(value)} (${((100 * value) / Math.max(1, denominator)).toFixed(1)}%)`
  }
  const dev = (d: number) => (Number.isFinite(d) ? `${(100 * d).toFixed(0)}%` : '∞ (fixture 0)')
  const lines = [
    '| measure | fixture 1x | live | deviation | follow-up |',
    '|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.measure} | ${cell(r, r.fixture, fixture)} | ${cell(r, r.live, live)} | ${dev(r.deviation)} | ${r.followUp ? '**yes**' : ''} |`,
    ),
  ]
  return lines.join('\n')
}
