import type { IssueViewModel } from '@podium/client-core/replica'
import { fixtureViewModels } from './normalized-issues'
/**
 * POD-4552 — an anonymised snapshot of a live Podium workspace, and the
 * adapter that feeds it to the same oracle and shape measures the fixture uses.
 *
 * The export (`export-snapshot.ts`) reads the four collections the web client
 * reads, through the web client's own paths: the kernel rows from
 * `/sync/bootstrap` (issues, issue projections, sessions, repo prefixes, deps),
 * the machine scan from `discovery.refreshRepos`, pins from `pins.list`.
 *
 * ANONYMISATION. Every string is hashed with a keyed HMAC unless its key is on
 * {@link KEEP_KEYS} (ids, enums, timestamps, the `displayRef` prefix) AND the
 * value is a single token ({@link TOKEN}). An
 * unknown field therefore leaks nothing; a field the derivation reads that
 * hashing broke shows up as a parity failure (`anonymisationParity`), never as
 * a silently different shape. Paths are hashed per segment so every
 * containment relation survives, including the string-prefix fork trap
 * (`/w/alpha` vs `/w/alpha-fork`): a segment that extends a sibling segment is
 * spelled as the sibling's hash plus a hash of the rest.
 */

import { createHmac, randomBytes } from 'node:crypto'
import type { PinState } from '@podium/client-core/viewmodels'
import type {
  GitRepositoryWire,
  IssueDepProjection,
  IssueProjection,
  MachineWire,
  RepoProjection,
  SessionMeta,
} from '@podium/model'
import type { SliceLocals, SliceSnapshot } from '@podium/client-graph/shared/slice-types'
import { expectedSnapshot } from '../oracle/index'
import type { CorpusScale, FixtureCorpus } from './index'

export const LIVE_SNAPSHOT_FORMAT = 'podium-live-snapshot/1'

/** The collections as the web client holds them, before or after hashing. */
export interface LiveCollections {
  issueUserStates?: import('@podium/model').IssueUserStateWire[]
  issueGitStates?: import('@podium/model').IssueGitStateProjection[]
  issues: IssueViewModel[]
  issueProjections: IssueProjection[]
  sessions: SessionMeta[]
  repoProjections: RepoProjection[]
  issueDeps: IssueDepProjection[]
  /** The machine scan (`GitRepositoryWire`): repo roots and their worktrees. */
  repos: GitRepositoryWire[]
  machines: MachineWire[]
  pins: PinState
}

/** The file the exporter writes (gzip JSON, never committed). */
export interface LiveSnapshot extends LiveCollections {
  format: typeof LIVE_SNAPSHOT_FORMAT
  /** Wall clock at export; the oracle's `coarseNow` for this snapshot. */
  exportedAt: string
  /** Server feed position the bootstrap was cut at. */
  snapshotSeq: number
  /** Kernel entity counts in the bootstrap, including kinds not exported. */
  bootstrapEntityCounts: Record<string, number>
  anonymisation: AnonymisationReport
}

export interface AnonymisationReport {
  /** Strings hashed as free text / as paths, and strings kept verbatim. */
  hashedText: number
  hashedPaths: number
  kept: number
  /** Distinct keys whose values were kept (audit trail). */
  keptKeys: string[]
  parity: AnonymisationParity
}

export interface AnonymisationParity {
  rawVisibleRows: number
  anonymisedVisibleRows: number
  /** True when the oracle snapshot is identical except for row titles and
   *  the path-derived repo keys and group labels. */
  equalExceptTitles: boolean
  /** Row ids whose projection differs beyond the title (empty when equal). */
  differingRows: string[]
}

// --------------------------------------------------------------- hashing

/** Keys whose string values are structural and kept verbatim. Everything else
 *  is hashed. Timestamps are kept by the `At` suffix rule in {@link keepKey}. */
export const KEEP_KEYS: ReadonlySet<string> = new Set([
  // identities and references (opaque ids, no free text)
  'id',
  'parentId',
  'sessionId',
  'issueId',
  'refIssueId',
  'repoId',
  'machineId',
  'coordinatorSessionId',
  'startedBySession',
  'supersededBy',
  'duplicateOf',
  'fromId',
  'toId',
  'conversationPodiumId',
  'spawnedBy',
  // enums the derivation reads
  'stage',
  'audience',
  'type',
  'closedReason',
  'status',
  'phase',
  'kind',
  'agentKind',
  'workState',
  'visibility',
  'intentOrigin',
  'origin',
  'suggestedStage',
  'stopReason',
  'stateSource',
  'geometryState',
  'nameSource',
  'driverFamily',
  // the displayRef spelling (`POD-123` / `#123`): repo prefixes are short codes
  'displayRef',
  'prefix',
  'refLetter',
  // the persisted manual order key (base62, no text)
  'sortKey',
  // timestamps without the `At` suffix
  'since',
  'deferUntil',
  'firstSeen',
  'lastSeen',
])

/** Keys whose string values are filesystem paths (hashed per segment). */
export const PATH_KEYS: ReadonlySet<string> = new Set(['cwd', 'path', 'repoPath', 'worktreePath'])

const keepKey = (keep: ReadonlySet<string>, key: string): boolean =>
  keep.has(key) || /At$/.test(key)

/** A kept key keeps its value only when the value is one token: an id, an
 *  enum member, a timestamp. Live rows put sentences in fields that look like
 *  enums (`closedReason` holds closing summaries), so a value with a space, a
 *  slash or unusual length is hashed even under a kept key. The derivation
 *  reads those fields for presence, which a hash keeps. */
const TOKEN = /^[A-Za-z0-9_:.|#+-]{1,128}$/

/**
 * Keyed, deterministic hashing: equal inputs stay equal, nothing is
 * recoverable without the key. The exporter uses a fresh random key per run
 * and never writes it down.
 */
export class Hasher {
  private readonly key: Buffer
  /** Children of each raw parent directory, collected before any encoding. */
  private readonly siblings = new Map<string, Set<string>>()
  private readonly segmentCache = new Map<string, string>()
  counts = { hashedText: 0, hashedPaths: 0, kept: 0 }
  readonly keptKeys = new Set<string>()

  /** `keep` is the kept-key set; tests narrow it to prove parity is armed.
   *  `siblingAware: false` hashes every segment on its own (a control that
   *  loses the fork trap). */
  constructor(
    key: Buffer = randomBytes(32),
    readonly keep: ReadonlySet<string> = KEEP_KEYS,
    private readonly siblingAware = true,
  ) {
    this.key = key
  }

  digest(domain: string, value: string): string {
    return createHmac('sha256', this.key).update(`${domain}\0${value}`).digest('hex').slice(0, 16)
  }

  text(value: string): string {
    this.counts.hashedText++
    return `t${this.digest('text', value)}`
  }

  /** Register a path so its segments' siblings are known before encoding. */
  notePath(path: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join('/')
      const set = this.siblings.get(parent) ?? new Set<string>()
      this.siblings.set(parent, set)
      set.add(parts[i]!)
    }
  }

  path(value: string): string {
    this.counts.hashedPaths++
    const parts = value.split('/')
    const out = [parts[0] === '' ? '' : this.segment('', parts[0]!)]
    for (let i = 1; i < parts.length; i++) {
      out.push(this.segment(parts.slice(0, i).join('/'), parts[i]!))
    }
    return out.join('/')
  }

  /** A segment extending a sibling (`alpha-fork` next to `alpha`) is spelled
   *  as the sibling's encoding plus a hash of the rest, so the raw string
   *  prefix relation between the two paths survives. */
  private segment(parent: string, seg: string): string {
    if (seg === '') return ''
    const cacheKey = `${parent}\0${seg}`
    const cached = this.segmentCache.get(cacheKey)
    if (cached !== undefined) return cached
    let base: string | null = null
    for (const sib of this.siblingAware ? (this.siblings.get(parent) ?? []) : []) {
      if (
        sib !== seg &&
        sib.length > 0 &&
        seg.startsWith(sib) &&
        (base === null || sib.length > base.length)
      )
        base = sib
    }
    const encoded =
      base === null
        ? `p${this.digest('seg', seg)}`
        : `${this.segment(parent, base)}${this.digest('rest', seg.slice(base.length))}`
    this.segmentCache.set(cacheKey, encoded)
    return encoded
  }
}

/** Walk a value, collecting every path-keyed string (first pass). */
function notePaths(value: unknown, hasher: Hasher, key = ''): void {
  if (typeof value === 'string') {
    if (PATH_KEYS.has(key)) hasher.notePath(value)
  } else if (Array.isArray(value)) {
    for (const item of value) notePaths(item, hasher, key)
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) notePaths(v, hasher, k)
  }
}

/** Hash every string under `value` by its nearest key (array items inherit it). */
function anonymiseValue(value: unknown, hasher: Hasher, key = ''): unknown {
  if (typeof value === 'string') {
    if (PATH_KEYS.has(key)) return hasher.path(value)
    if (keepKey(hasher.keep, key) && TOKEN.test(value)) {
      hasher.counts.kept++
      hasher.keptKeys.add(key)
      return value
    }
    return hasher.text(value)
  }
  if (Array.isArray(value)) return value.map((item) => anonymiseValue(item, hasher, key))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = anonymiseValue(v, hasher, k)
    return out
  }
  return value
}

/**
 * Anonymise all eight collections with one hasher (so a path, a title or a
 * resume ref hashes the same wherever it appears). Pins name worktrees and
 * repos by path and panels by id.
 */
export function anonymiseCollections(
  raw: LiveCollections,
  hasher: Hasher = new Hasher(),
): LiveCollections {
  const { pins, ...rest } = raw
  for (const rows of Object.values(rest)) notePaths(rows, hasher)
  for (const path of [...pins.worktrees, ...pins.repos]) hasher.notePath(path)
  const out = {} as Record<string, unknown>
  for (const [name, rows] of Object.entries(rest)) out[name] = anonymiseValue(rows, hasher)
  return {
    ...(out as Omit<LiveCollections, 'pins'>),
    pins: {
      panels: [...pins.panels],
      worktrees: pins.worktrees.map((p) => hasher.path(p)),
      repos: pins.repos.map((p) => hasher.path(p)),
    },
  }
}

// ------------------------------------------------------------ oracle input

/**
 * The live collections in the fixture's spelling, so `expectedSnapshot` and
 * `measureShape` read them exactly as they read `buildCorpus`. Slice rows and
 * fixture-only markers are empty: nothing here reads them.
 */
export function corpusFromLive(live: LiveCollections, coarseNow: number): FixtureCorpus {
  const issues = fixtureViewModels(live)
  return {
    seed: 0,
    scale: 1 as CorpusScale,
    cell: null,
    units: [],
    fixedNow: coarseNow,
    issues,
    issueProjections: live.issueProjections,
    issueUserStates: live.issueUserStates ?? [],
    issueGitStates: live.issueGitStates ?? [],
    sessions: live.sessions,
    repoProjections: live.repoProjections,
    issueDeps: live.issueDeps,
    repos: live.repos,
    machines: live.machines,
    pins: live.pins,
    sliceIssues: [],
    sliceSessions: [],
    sliceWorktrees: [],
    unscannedWorktree: { issueId: '', path: '', sessionId: '' },
    resumeTwins: [],
    edgedAskers: [],
    stats: {
      issues: issues.length,
      sessions: live.sessions.length,
      repos: live.repos.length,
      worktrees: 0,
      repoRows: live.repoProjections.length,
      rootLanes: 0,
      withStartedBySession: 0,
      withCoordinator: 0,
      depsByType: {},
      sessionsWithResume: 0,
      withParent: 0,
      withOriginEdge: 0,
      open: 0,
      depthHistogram: {},
      prefixOwnedSessions: 0,
      maxDepth: 0,
      resumeTwinGroups: 0,
      edgedAskers: 0,
    },
  }
}

const localsAt = (coarseNow: number): SliceLocals => ({ selectedIssueId: null, coarseNow })

/**
 * The oracle over the raw collections and over their anonymised copy must
 * agree on everything but titles (hashed by design). A hashed field the
 * derivation reads — an enum, a path relation — shows up here.
 */
export function anonymisationParity(
  raw: LiveCollections,
  anonymised: LiveCollections,
  coarseNow: number,
): AnonymisationParity {
  const a = expectedSnapshot(corpusFromLive(raw, coarseNow), localsAt(coarseNow))
  const b = expectedSnapshot(corpusFromLive(anonymised, coarseNow), localsAt(coarseNow))
  return compareExceptTitles(a, b)
}

export function compareExceptTitles(a: SliceSnapshot, b: SliceSnapshot): AnonymisationParity {
  // `repoKey` falls back to the (hashed) repo path; group membership below
  // carries what it decides.
  const strip = (s: SliceSnapshot) =>
    Object.fromEntries(
      Object.entries(s.rowsById).map(([id, row]) => [
        id,
        JSON.stringify({ ...row, title: '', repoKey: '' }),
      ]),
    )
  const ra = strip(a)
  const rb = strip(b)
  const ids = new Set([...Object.keys(ra), ...Object.keys(rb)])
  const differingRows = [...ids].filter((id) => ra[id] !== rb[id]).sort()
  // Group keys and labels come from repo identity (hashed paths/names), so
  // compare the order by row ids and group membership, not by label text.
  const orderShape = (s: SliceSnapshot) =>
    JSON.stringify({
      pinned: s.order.pinnedIds,
      groups: s.order.groups.map((g) => ({ rowIds: g.rowIds, closedIds: g.closedIds })),
    })
  const orderEqual = orderShape(a) === orderShape(b)
  return {
    rawVisibleRows: Object.keys(a.rowsById).length,
    anonymisedVisibleRows: Object.keys(b.rowsById).length,
    equalExceptTitles: differingRows.length === 0 && orderEqual,
    differingRows: orderEqual ? differingRows : [...differingRows, '<order>'],
  }
}
