import type { IssueViewModel } from '@podium/client-core/replica'
import type { SessionView } from '@podium/client-core/session-values'
import { fixtureGitStates, fixtureMarkers, fixtureProjection } from './normalized-issues'
/**
 * POD-4443 / POD-4635 — deterministic live-shaped corpus at 1x, 2x and 4x.
 *
 * `buildCorpus(scale, seed)` returns `scale` copies of one workspace unit:
 * 4,867 issues / 4,304 sessions / 9 kernel repos / 17 repo roots / 468
 * worktrees each, shaped like the live workspace export measured in POD-4552
 * (`docs/measurements/POD-4441-fixture-shape.md`, "Fixture vs live"). At 2x
 * and 4x the counts of things multiply and the shares and depths stay: a
 * bigger workspace is more of the same workspace, which is what the growth
 * slope measures.
 *
 * Only the live export's SHAPE is used (per-kind counts, depth histograms,
 * edge and session shares); none of its content is.
 *
 * Determinism: one mulberry32 stream per build, no `Math.random`, no
 * `Date.now()` — every timestamp derives from `FIXED_NOW`. Two builds with the
 * same `(scale, seed)` are deep-equal (proven by `corpus.test.ts`).
 *
 * TWO AXES (POD-4747). `buildCorpus(scale)` grows everything together. A
 * workspace grows along two axes that cost differently: HISTORY (closed,
 * archived and deleted work and its sessions, past every visibility window)
 * grows forever, and ACTIVE work (open issues, live sessions, visible rows,
 * worktree lanes) grows with usage. `buildCorpusCell({ history, active })`
 * grows them separately. Every role in the unit plan belongs to one axis
 * (`ROLE_AXIS`). A cell is the 1x unit (`full`, byte-identical to
 * `buildCorpus(1)`), then `active - 1` ACTIVE units (the active roles only,
 * with their lanes and sessions), then `history - 1` HISTORY epochs (the
 * history roles only, no lanes, no live session, each one an older stretch
 * of the workspace: its clock sits `EPOCH_MS` further back per epoch). Each
 * added unit draws from its own seeded stream and links only inside itself,
 * so adding history leaves every active row of the cell as it was, and adding
 * active work leaves every history row as it was (`cells.test.ts`).
 */


import { deriveIssueRollups, indexSessionsByIssue } from '@podium/client-graph/diagnostics/reference/issue-views'
import type { PinState } from '@podium/client-core/values'
import type {
  SliceIssue,
  SliceSession,
  SliceWorktree,
} from '@podium/client-graph/shared/slice-types'
import type {
  GitRepositoryWire,
  IssueDepProjection,
  IssueProjection,
  MachineWire,
  RepoProjection,
} from '@podium/model'
import { spreadSortKeys } from '@podium/model'

/** The corpus clock. Sits inside the defer band thresholds (spec §3 R-ORDER):
 *  `deferUntil` values are minted ±45 d around it, so bands 0/1/2 are all live.
 *  Kept far from the wall clock so `deriveIssueViews`' wall-clock `deferred`
 *  read (which the worklist does not consume) cannot flip under test. */
export const FIXED_NOW = Date.parse('2026-09-20T12:00:00Z')

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS
const iso = (ms: number): string => new Date(ms).toISOString()

/** 1x counts. 2x and 4x multiply issues, sessions and worktrees; the repos,
 *  their roots and the machines stay (a bigger workspace is more work in the
 *  same repos, so the largest repo's share stays live's 89%). */
export const BASE_COUNTS = {
  issues: 4867,
  sessions: 4304,
  /** Discovery scan entries (`GitRepositoryWire`) at 1x: the 17 repo roots
   *  plus the standalone entry a real scan reports for each linked worktree
   *  (`scanEntries(scale)`). */
  repos: 485,
  /** Linked worktrees (the static `sliceWorktrees` lanes). */
  worktrees: 468,
  machines: 6,
  /** Kernel `repo` entity rows (the prefix join), at every scale. Live: 9. */
  repoRows: 9,
  /** Repo roots in the scan (a lane each), at every scale. Live: 17. */
  rootLanes: 17,
} as const

export type CorpusScale = 1 | 2 | 4

/**
 * POD-4747: one cell of the two-axis grid. `history` multiplies the history
 * roles (the 1x unit's history plus `history - 1` epochs); `active` multiplies
 * the active roles (the 1x unit's active work plus `active - 1` active units).
 */
export interface CorpusCell {
  history: number
  active: CorpusScale
}

/** The cells the growth test compares: the base, history x10, active x4. */
export const GROWTH_CELLS = {
  base: { history: 1, active: 1 },
  history10: { history: 10, active: 1 },
  active4: { history: 1, active: 4 },
} as const satisfies Record<string, CorpusCell>

/** `h10a1` for `{ history: 10, active: 1 }`: the label pages, runs and docs use. */
export const cellLabel = (cell: CorpusCell): string => `h${cell.history}a${cell.active}`

/** The inverse of `cellLabel`; throws on anything else. */
export function parseCell(label: string): CorpusCell {
  const match = /^h(\d+)a(\d+)$/.exec(label)
  const history = Number(match?.[1])
  const active = Number(match?.[2])
  if (
    match === null ||
    !Number.isInteger(history) ||
    history < 1 ||
    history > MAX_HISTORY ||
    (active !== 1 && active !== 2 && active !== 4)
  )
    throw new Error(`[fixture] bad cell ${label} (want h<1..${MAX_HISTORY}>a<1|2|4>)`)
  return { history, active: active as CorpusScale }
}

/** A unit's contribution: the whole live-shaped unit, or one axis of it. */
export type UnitPart = 'full' | 'active' | 'history'

/** How far back each history epoch's clock sits: past every visibility window
 *  (the longest is the 7-day unread-finished one) and as long as the unit's
 *  own creation window (3-120 days), so each epoch's issues were filed before
 *  the next one's. */
export const EPOCH_MS = 120 * 24 * 60 * 60 * 1000
const MAX_HISTORY = 20

/** Discovery scan entries at a scale: the roots, and one per worktree. */
export const scanEntries = (scale: CorpusScale): number =>
  BASE_COUNTS.rootLanes + BASE_COUNTS.worktrees * scale

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface CorpusStats {
  issues: number
  sessions: number
  /** Discovery scan entries. */
  repos: number
  /** Linked worktrees. */
  worktrees: number
  /** Kernel `repo` rows. */
  repoRows: number
  /** Repo roots in the scan. */
  rootLanes: number
  /** Issues with a `parentId` (R1 edges). */
  withParent: number
  /** Issues carrying an outgoing `discovered-from` edge (R4). */
  withOriginEdge: number
  /** Open issues (no `closedAt`). */
  open: number
  /** Depth histogram over parent chains (depth 1 = root). */
  depthHistogram: Record<string, number>
  /** Sessions with no `issueId` (R3 prefix ownership candidates). */
  prefixOwnedSessions: number
  maxDepth: number
  /** Resume-twin groups (sessions sharing one resume ref), all three kinds. */
  resumeTwinGroups: number
  /** Asking sessions on hidden (archived/proposed) children of visible roots. */
  edgedAskers: number
  /** Issues carrying `startedBySession` / `coordinatorSessionId`. */
  withStartedBySession: number
  withCoordinator: number
  /** Dependency rows by type (`issueDeps`). */
  depsByType: Record<string, number>
  sessionsWithResume: number
}

/** POD-4551: which branch of `dedupeSessionsByResume` a twin group covers. */
export type ResumeTwinKind = 'inactive' | 'tie' | 'live'

/** One resume-twin group: every session in it shares `ref`. */
export interface ResumeTwinGroup {
  kind: ResumeTwinKind
  /** The visible root the group is attached to. */
  issueId: string
  ref: { kind: string; value: string }
  sessionIds: string[]
  /** What the legacy collapse keeps: one row, or the whole group when live. */
  keptSessionIds: string[]
}

/** POD-4551 (the L1d shape): an asking session on a hidden child of a visible root. */
export interface EdgedAsker {
  rootId: string
  childId: string
  sessionId: string
}

/** POD-4747: where one unit's rows sit in the corpus arrays (end exclusive):
 *  issues in id order (`issues[k].id === i<k>`), sessions in minting order. */
export interface UnitSpan {
  part: UnitPart
  issues: [number, number]
  sessions: [number, number]
}

/** Everything the oracle and the row stream need, in both spellings. */
export interface FixtureCorpus {
  seed: number
  /** The legacy scale; for a cell, its active factor (what the page's
   *  scale-keyed rules, such as the pinned section's size, see). */
  scale: CorpusScale
  /** POD-4747: the two-axis cell, or null for a `buildCorpus(scale)` corpus. */
  cell: CorpusCell | null
  /** POD-4747: every unit, in minting order. */
  units: UnitSpan[]
  fixedNow: number
  /** Derived render models for oracle inputs; never replicated as a kind. */
  issues: IssueViewModel[]
  /** Normalized durable rows (replica `issueProjections` kind). */
  issueProjections: IssueProjection[]
  issueUserStates?: import('@podium/model').IssueUserStateWire[]
  issueGitStates?: import('@podium/model').IssueGitStateProjection[]
  /** Session rows (`store.sessions`, replica `sessions` kind). */
  sessions: SessionView[]
  /** Logical repos (replica `repos` kind, `displayRef` prefix join). */
  repoProjections: RepoProjection[]
  /** Dependency edges (replica `issueDeps` kind). */
  issueDeps: IssueDepProjection[]
  /** Per-checkout machine facts (`store.repos`, nav structure). */
  repos: GitRepositoryWire[]
  /** Connected machines (`store.machines`). */
  machines: MachineWire[]
  /** Per-user pins (`store.pins`). */
  pins: PinState
  /** Slice-shaped rows for the G3 row stream. */
  sliceIssues: SliceIssue[]
  sliceSessions: SliceSession[]
  sliceWorktrees: SliceWorktree[]
  /** POD-4550: a live issue whose `worktreePath` no discovery scan reported,
   *  with one live orphan session seated under it only by the prefix
   *  relation. */
  unscannedWorktree: { issueId: string; path: string; sessionId: string }
  /** POD-4551: session groups sharing a resume ref, one of each kind per scale unit. */
  resumeTwins: ResumeTwinGroup[]
  /** POD-4551: asking sessions the visible root must NOT bubble (hidden child). */
  edgedAskers: EdgedAsker[]
  stats: CorpusStats
}

// ---------------------------------------------------------------------------
// The unit plan (1x). Every count is per scale unit.
// ---------------------------------------------------------------------------
//
// Roles are grouped by what the legacy derivation does with them:
//
// - TOP: human roots that earn a top-level row (283 live; 271 here).
// - NESTED: issues that render nested under a top row, by a formal parent
//   chain (464 live) or by `startedBySession` (12 live, `sbsNested`).
// - HIDDEN: everything else, the historical bulk.
//
// Per-kind counts are the live export's (5,170 issues) scaled to 4,867; depth
// weights, edge shares and session means are the live per-kind ones.

type Role =
  // top-level rows
  | 'mission'
  | 'topReview'
  | 'topInProg'
  | 'topPlanning'
  | 'sessless'
  | 'topBacklog'
  | 'rescueParent'
  | 'topClosed'
  | 'sbsNested'
  // nested rows
  | 'nAgentDone'
  | 'nAgentReview'
  | 'nAgentActive'
  | 'nHumanDone'
  | 'nHumanActive'
  | 'nHumanBacklog'
  | 'rescueChild'
  // hidden
  | 'proposed'
  | 'agentProposed'
  | 'humanDone'
  | 'humanDoneArch'
  | 'humanBacklog'
  | 'humanDeleted'
  | 'humanArchOpen'
  | 'shipping'
  | 'agentDone'
  | 'agentDoneArch'
  | 'agentBacklog'
  | 'agentReview'
  | 'agentActive'
  | 'agentArch'

interface RoleSpec {
  role: Role
  audience: 'human' | 'agent'
  /** Stage counts, in minting order; they sum to the role's count. */
  stages: Array<[string, number]>
  archived?: boolean
  deleted?: boolean
  /** Exact number of roots (depth 1); the rest are children. */
  roots: number
  /** Depth weights for the children, index 0 = depth 2. */
  depth?: number[]
  /** Share of the children placed inside a mission subtree (the rest sit in
   *  hidden trees). Nested roles are always inside one. */
  inMission?: number
  /** P(`startedBySession`), P(`discovered-from`), P(`coordinatorSessionId`
   *  given own sessions), and the weight of history sessions per issue. */
  sbs: number
  df: number
  coord: number
  history: number
}

/** Coordinator and `blocks` shares are the live per-kind ones, lifted so the
 *  corpus totals land on live's (25.4% and 33.9% of issues): a kind's live
 *  share counts issues this corpus mints without sessions or siblings. */
const COORD_LIFT = 1.45
const BLOCK_LIFT = 1.07
/** Live: 46 of 5,170 issues. */
const NEEDS_HUMAN_1X = 44

const DEPTH_AGENT_DONE = [640, 408, 286, 42, 4]
const DEPTH_AGENT_REVIEW = [58, 11, 69, 8]
const DEPTH_AGENT_ACTIVE = [29, 11, 8]
const DEPTH_HUMAN_DONE = [173, 108, 87, 4, 4]

const H = 'human'
const A = 'agent'
/** `proposed` absorbs the remainder so the unit sums to BASE_COUNTS.issues. */
const PLAN: RoleSpec[] = [
  // Top-level rows. `mission` roots carry the nested subtrees; review /
  // in-progress / planning roots are visible by stage alone.
  {
    role: 'mission',
    audience: H,
    stages: [
      ['review', 12],
      ['in_progress', 8],
      ['planning', 4],
      ['done', 6],
    ],
    roots: 30,
    sbs: 0,
    df: 0.2,
    coord: 0.45,
    history: 0.5,
  },
  {
    role: 'topReview',
    audience: H,
    stages: [['review', 100]],
    roots: 100,
    sbs: 0.13,
    df: 0.23,
    coord: 0.38,
    history: 0.3,
  },
  {
    role: 'topInProg',
    audience: H,
    stages: [['in_progress', 10]],
    roots: 10,
    sbs: 0.17,
    df: 0.26,
    coord: 0.5,
    history: 0.8,
  },
  {
    role: 'topPlanning',
    audience: H,
    stages: [['planning', 16]],
    roots: 16,
    sbs: 0,
    df: 0.05,
    coord: 0.36,
    history: 0.3,
  },
  // Sessionless active roots: the hidden askers, the resume twins and the
  // unscanned worktree each take one (they decide what the row shows).
  {
    role: 'sessless',
    audience: H,
    stages: [
      ['in_progress', 14],
      ['planning', 12],
    ],
    roots: 26,
    sbs: 0,
    df: 0,
    coord: 0,
    history: 0,
  },
  {
    role: 'topBacklog',
    audience: H,
    stages: [['backlog', 11]],
    roots: 11,
    sbs: 0.3,
    df: 0.3,
    coord: 0.1,
    history: 0.2,
  },
  // A sessionless backlog parent with exactly one visible child: the legacy
  // rescue materialises it (the #6d keeper pair).
  {
    role: 'rescueParent',
    audience: H,
    stages: [['backlog', 10]],
    roots: 10,
    sbs: 0,
    df: 0,
    coord: 0,
    history: 0,
  },
  {
    role: 'topClosed',
    audience: H,
    stages: [['done', 68]],
    roots: 68,
    sbs: 0.25,
    df: 0.3,
    coord: 0.12,
    history: 0.6,
  },
  // Top-level issues with no parent and no spin-off edge whose starter session
  // belongs to a visible row: legacy nests them under it (rows.ts:289).
  {
    role: 'sbsNested',
    audience: H,
    stages: [
      ['done', 8],
      ['in_progress', 2],
      ['review', 1],
      ['backlog', 1],
    ],
    roots: 12,
    sbs: 1,
    df: 0,
    coord: 0.2,
    history: 0.3,
  },
  // Nested rows: each inside a mission subtree, each earning its row.
  {
    role: 'nAgentDone',
    audience: A,
    stages: [['done', 254]],
    roots: 0,
    depth: DEPTH_AGENT_DONE,
    sbs: 0.88,
    df: 0.15,
    coord: 0.45,
    history: 0.15,
  },
  {
    role: 'nAgentReview',
    audience: A,
    stages: [['review', 104]],
    roots: 0,
    depth: DEPTH_AGENT_REVIEW,
    sbs: 0.99,
    df: 0.34,
    coord: 0.7,
    history: 0.3,
  },
  {
    role: 'nAgentActive',
    audience: A,
    stages: [
      ['in_progress', 15],
      ['planning', 4],
    ],
    roots: 0,
    depth: DEPTH_AGENT_ACTIVE,
    sbs: 1,
    df: 0.05,
    coord: 0.5,
    history: 0.3,
  },
  {
    role: 'nHumanDone',
    audience: H,
    stages: [['done', 40]],
    roots: 0,
    depth: DEPTH_HUMAN_DONE,
    sbs: 0.28,
    df: 0.3,
    coord: 0.12,
    history: 0.3,
  },
  {
    role: 'nHumanActive',
    audience: H,
    stages: [
      ['review', 8],
      ['in_progress', 9],
      ['planning', 1],
    ],
    roots: 0,
    depth: [23, 4, 2],
    sbs: 0.15,
    df: 0.25,
    coord: 0.45,
    history: 0.5,
  },
  {
    role: 'nHumanBacklog',
    audience: H,
    stages: [['backlog', 4]],
    roots: 0,
    depth: [1, 1],
    sbs: 0.3,
    df: 0.4,
    coord: 0,
    history: 0,
  },
  {
    role: 'rescueChild',
    audience: H,
    stages: [
      ['in_progress', 5],
      ['review', 5],
    ],
    roots: 0,
    depth: [1],
    sbs: 0,
    df: 0,
    coord: 0.3,
    history: 0,
  },
  // Hidden bulk.
  {
    role: 'humanDone',
    audience: H,
    stages: [['done', 292]],
    roots: 0,
    depth: DEPTH_HUMAN_DONE,
    inMission: 0.3,
    sbs: 0.28,
    df: 0.3,
    coord: 0.12,
    history: 0.6,
  },
  {
    role: 'humanDoneArch',
    audience: H,
    stages: [['done', 396]],
    archived: true,
    roots: 315,
    depth: [51, 24, 6],
    inMission: 0.2,
    sbs: 0.3,
    df: 0.4,
    coord: 0.08,
    history: 0.9,
  },
  {
    role: 'humanBacklog',
    audience: H,
    stages: [['backlog', 156]],
    roots: 72,
    depth: [38, 46],
    inMission: 0,
    sbs: 0.31,
    df: 0.42,
    coord: 0.08,
    history: 0.15,
  },
  {
    role: 'humanDeleted',
    audience: H,
    stages: [
      ['backlog', 54],
      ['done', 1],
    ],
    deleted: true,
    roots: 55,
    sbs: 0,
    df: 0,
    coord: 0.33,
    history: 0,
  },
  {
    role: 'humanArchOpen',
    audience: H,
    stages: [
      ['review', 57],
      ['in_progress', 21],
      ['backlog', 14],
      ['planning', 7],
    ],
    archived: true,
    roots: 91,
    depth: [1],
    inMission: 0,
    sbs: 0.1,
    df: 0.2,
    coord: 0.3,
    history: 1.2,
  },
  // A system-owned stage the derivation skips (not seen live; kept as cover).
  {
    role: 'shipping',
    audience: H,
    stages: [['shipping', 5]],
    roots: 5,
    sbs: 0,
    df: 0,
    coord: 0,
    history: 0,
  },
  {
    role: 'agentDone',
    audience: A,
    stages: [['done', 1080]],
    roots: 37,
    depth: DEPTH_AGENT_DONE,
    inMission: 0.3,
    sbs: 0.88,
    df: 0.15,
    coord: 0.45,
    history: 0.85,
  },
  {
    role: 'agentDoneArch',
    audience: A,
    stages: [['done', 556]],
    archived: true,
    roots: 0,
    depth: [465, 121, 4, 1],
    inMission: 0.25,
    sbs: 1,
    df: 0.04,
    coord: 0.62,
    history: 0.85,
  },
  {
    role: 'agentBacklog',
    audience: A,
    stages: [['backlog', 330]],
    roots: 2,
    depth: [170, 132, 42, 5],
    inMission: 0.35,
    sbs: 0.86,
    df: 0.17,
    coord: 0.01,
    history: 0,
  },
  {
    role: 'agentReview',
    audience: A,
    stages: [['review', 33]],
    roots: 0,
    depth: DEPTH_AGENT_REVIEW,
    inMission: 0.5,
    sbs: 0.99,
    df: 0.34,
    coord: 0.7,
    history: 1,
  },
  {
    role: 'agentActive',
    audience: A,
    stages: [
      ['in_progress', 27],
      ['planning', 8],
    ],
    roots: 1,
    depth: DEPTH_AGENT_ACTIVE,
    inMission: 0.5,
    sbs: 1,
    df: 0.05,
    coord: 0.5,
    history: 0.8,
  },
  {
    role: 'agentArch',
    audience: A,
    stages: [
      ['backlog', 29],
      ['in_progress', 10],
      ['review', 8],
      ['planning', 1],
    ],
    archived: true,
    roots: 7,
    depth: [27, 14, 2, 1],
    inMission: 0.2,
    sbs: 0.8,
    df: 0,
    coord: 0.2,
    history: 0.3,
  },
  {
    role: 'agentProposed',
    audience: A,
    stages: [['proposed', 19]],
    roots: 19,
    sbs: 0.1,
    df: 0.75,
    coord: 0,
    history: 0,
  },
  {
    role: 'proposed',
    audience: H,
    stages: [['proposed', 0]],
    roots: 0,
    sbs: 0.96,
    df: 0.89,
    coord: 0,
    history: 0,
  },
]

const TOP_ROLES = new Set<Role>([
  'mission',
  'topReview',
  'topInProg',
  'topPlanning',
  'sessless',
  'topBacklog',
  'rescueParent',
  'topClosed',
])
const NESTED_ROLES = new Set<Role>([
  'nAgentDone',
  'nAgentReview',
  'nAgentActive',
  'nHumanDone',
  'nHumanActive',
  'nHumanBacklog',
  'rescueChild',
])
/** Roles that earn a row (sort-key siblings, pins). */
const VISIBLE_ROLES = new Set<Role>([...TOP_ROLES, ...NESTED_ROLES, 'sbsNested'])
/** Leaves by construction: the rescue pair, the askers' and twins' roots. */
const LEAF_ROLES = new Set<Role>([
  'nHumanActive',
  'nHumanBacklog',
  'rescueChild',
  'rescueParent',
  'sessless',
])
/**
 * POD-4747: the growth axis of each role. History is finished or put-away
 * work that no row shows: hidden closed issues, archived and deleted ones.
 * Everything else is active work: every role that earns a row (closed rows in
 * the fold included) and the open hidden work (backlog, proposed, hidden
 * review and in-progress children, shipping).
 */
const HISTORY_ROLES = new Set<Role>([
  'humanDone',
  'humanDoneArch',
  'humanDeleted',
  'humanArchOpen',
  'agentDone',
  'agentDoneArch',
  'agentArch',
])
const axisOfRole = (role: Role): 'active' | 'history' =>
  HISTORY_ROLES.has(role) ? 'history' : 'active'

// ---------------------------------------------------------------------------
// Repos and lanes (per unit). Live: 9 repo rows, 17 roots, 504 worktrees of
// which 202 nest inside a root, 19 fork-trap pairs.
// ---------------------------------------------------------------------------

const PREFIXES = ['POD', 'WEB', 'OPS', 'DOC', 'LAB', 'CLI', 'SDK', 'INF', 'APP'] as const
/** Kernel repo of each root lane: `a`/`b` are repo ids with no repo row (the
 *  `#seq` label, live has four). */
const ROOT_REPO: Array<number | 'a' | 'b'> = [0, 1, 2, 0, 1, 0, 3, 4, 5, 6, 7, 8, 'a', 0, 1, 'b', 0]
/** Linked worktrees per root, and how many of them sit inside the root
 *  (`<root>/.worktrees/x`, a nested lane) rather than elsewhere. */
const ROOT_WORKTREES = [200, 150, 80, 20, 8, 3, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const ROOT_NESTED = [60, 90, 30, 4, 8, 3, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0]
/** Worktrees renamed to extend their predecessor's path (`/w/x` → `/w/x-b`):
 *  a string prefix that is not a directory (the fork trap). Two more pairs
 *  come from the named alpha/beta worktrees. */
const FORK_TRAP_EXTRA = 17
/** Issue repo weights for hidden roots (live: one repo holds 89%). */
const HIDDEN_REPO_WEIGHTS: Array<[number | 'a' | 'b', number]> = [
  [0, 935],
  [1, 40],
  [2, 20],
  [3, 10],
  [4, 5],
  [5, 5],
  [6, 3],
  [7, 3],
  [8, 2],
  ['a', 1],
  ['b', 1],
]

const TITLE_NOUNS = [
  'sidebar',
  'rollup',
  'replica',
  'session',
  'worktree',
  'fold',
  'timer',
  'palette',
  'rail',
  'harness',
]
const TITLE_VERBS = [
  'reconcile',
  'stabilize',
  'collapse',
  'reindex',
  'replay',
  'quieten',
  'rescope',
  'reorder',
  'retire',
  'unflake',
]
const AGENT_KINDS: Array<[string, number]> = [
  ['claude-code', 47],
  ['codex', 42],
  ['opencode', 7],
  ['grok', 4],
]
const RESUME_KIND: Record<string, string> = {
  'claude-code': 'claude-session',
  codex: 'codex-thread',
  opencode: 'opencode-session',
  grok: 'grok-session',
}

interface Mint {
  role: Role
  unit: number
  stage: string
  audience: 'human' | 'agent'
  archived: boolean
  deleted: boolean
  closed: boolean
  closedReason: string | null
  parent: number | null
  depth: number
  /** The mission root whose subtree holds this issue, if any. */
  mission: number | null
  repo: string
  repoPath: string
  worktree: string | null
  createdAt: string
  updatedAt: string
  closedAt: string | null
  deletedAt: string | null
}

type SessionRecord = Record<string, unknown>

/** The planted shapes (POD-4550, POD-4551), as `plant` leaves them. */
interface Planted {
  unscannedIdx: number
  unscannedPath: string
  unscannedOrphan: SessionRecord
  askerChildren: Set<number>
  edgedAskers: EdgedAsker[]
  resumeTwins: ResumeTwinGroup[]
}

function fail(message: string): never {
  throw new Error(`[fixture] ${message}`)
}

const pad = (n: number, width: number): string => String(n).padStart(width, '0')

export function buildCorpus(scale: CorpusScale, seed = 4443): FixtureCorpus {
  if (scale !== 1 && scale !== 2 && scale !== 4) fail(`unsupported scale ${scale}`)
  return build(seed, scale, null)
}

/** POD-4747: the corpus at one cell of the two-axis grid (see the header). */
export function buildCorpusCell(cell: CorpusCell, seed = 4443): FixtureCorpus {
  return build(seed, cell.active, parseCell(cellLabel(cell)))
}

function build(seed: number, scale: CorpusScale, cell: CorpusCell | null): FixtureCorpus {
  // A legacy build draws everything from one stream. A cell's unit 0 draws
  // from `buildCorpus(1)`'s stream and every added unit from its own, and
  // each pass that touches a unit's rows first `enter`s that unit (its stream
  // and its clock), so no unit's rows depend on how many others were added.
  let rng = mulberry32(seed * 1000 + (cell === null ? scale : 1))
  /** The unit's clock: `FIXED_NOW`, or further back for a history epoch. */
  let now = FIXED_NOW
  const streams: Array<{ rng: () => number; now: number }> = [{ rng, now }]
  const enter = (unit: number): void => {
    if (cell === null) return
    const stream = streams[unit] ?? fail(`no stream for unit ${unit}`)
    rng = stream.rng
    now = stream.now
  }
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
  const ago = (minMs: number, maxMs: number): string => iso(now - (minMs + rng() * (maxMs - minMs)))
  const weighted = <T>(items: ReadonlyArray<readonly [T, number]>): T => {
    const total = items.reduce((sum, [, w]) => sum + w, 0)
    let r = rng() * total
    for (const [item, w] of items) {
      r -= w
      if (r < 0) return item
    }
    return items[items.length - 1]![0]
  }
  const shuffle = <T>(items: T[]): T[] => {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[items[i], items[j]] = [items[j]!, items[i]!]
    }
    return items
  }

  // Ids follow creation order (a child after its parent, roles
  // interleaved, as live `seq` does); `idNo` maps a mint to its id number.
  const idNo: number[] = []
  const indexOfId = new Map<string, number>()
  const idOf = (i: number): string => `i${idNo[i]}`
  const mintOf = (id: string): number => indexOfId.get(id) ?? fail(`no issue ${id}`)
  const mints: Mint[] = []
  const sessions: SessionRecord[] = []
  const repoProjections: RepoProjection[] = []
  const repos: GitRepositoryWire[] = []
  const sliceWorktrees: SliceWorktree[] = []
  const machines: MachineWire[] = []
  for (let k = 0; k < BASE_COUNTS.machines; k++) {
    machines.push({
      id: `m${k}`,
      name: `bench-machine-${k}`,
      hostname: `bench-host-${k}`,
      online: true,
      lastSeenAt: iso(FIXED_NOW),
    } as unknown as MachineWire)
  }
  /** Per-unit facts the later passes need. */
  const units: Array<{
    part: UnitPart
    first: number
    end: number
    rootPaths: string[]
    /** Root lane path of a repo id (its first root). */
    primaryRoot: Map<string, string>
    /** Every root path of a repo id (alternate checkouts). */
    rootsOf: Map<string, string[]>
    /** Worktree lanes not yet named by an issue, per repo id. */
    freeLanes: Map<string, string[]>
    lanes: string[]
    quietMissions: Set<number>
    goneSeq: number
  }> = []

  // -- kernel repos and repo roots: one set for the whole corpus ---------------
  // A bigger workspace is more work in the same repos, so repo rows, roots
  // and groups do not multiply with the scale; worktrees, issues and
  // sessions do.
  const repoId = (j: number | 'a' | 'b'): string => (typeof j === 'number' ? `r${j}` : `rx${j}`)
  for (let j = 0; j < BASE_COUNTS.repoRows; j++)
    repoProjections.push({ id: repoId(j), prefix: PREFIXES[j] } as RepoProjection)
  const rootPaths: string[] = []
  const primaryRoot = new Map<string, string>()
  const rootsOf = new Map<string, string[]>()
  const roots = ROOT_REPO.map((j, r) => {
    const path = `/repo-${pad(r, 3)}`
    const rid = repoId(j)
    rootPaths.push(path)
    if (!primaryRoot.has(rid)) primaryRoot.set(rid, path)
    rootsOf.set(rid, [...(rootsOf.get(rid) ?? []), path])
    return {
      path,
      rid,
      machineId: `m${r % 3 === 0 ? 0 : r % 3 === 1 ? 1 : 2 + (r % 4)}`,
      worktrees: [] as Array<{ path: string; branch: string }>,
    }
  })
  if (roots.length !== BASE_COUNTS.rootLanes) fail('root plan drift')
  const standalone: GitRepositoryWire[] = []
  let wtSeq = 0
  const spans: UnitSpan[] = []
  /** Issues a unit of `part` mints: the plan's roles on that axis (`proposed`
   *  takes the rest of the full unit, and is active). */
  const unitIssues = (part: UnitPart): number => {
    if (part === 'full') return BASE_COUNTS.issues
    const history = PLAN.filter((spec) => axisOfRole(spec.role) === 'history').reduce(
      (sum, spec) => sum + spec.stages.reduce((n, [, c]) => n + c, 0),
      0,
    )
    return part === 'history' ? history : BASE_COUNTS.issues - history
  }
  /** A session's axis: its issue's, or for an unbound one, history once it
   *  has stopped (a decayed run) and active while it has not. */
  const sessionAxis = (s: SessionRecord): 'active' | 'history' => {
    const id = s['issueId']
    if (typeof id === 'string') return axisOfRole(mints[mintOf(id)]!.role)
    return s['stoppedAt'] !== undefined ? 'history' : 'active'
  }

  const parts: UnitPart[] =
    cell === null
      ? Array.from({ length: scale }, () => 'full' as const)
      : [
          'full',
          ...Array.from({ length: cell.active - 1 }, () => 'active' as const),
          ...Array.from({ length: cell.history - 1 }, () => 'history' as const),
        ]
  /** POD-4747: sessions per axis of the planted unit 0: what each added
   *  active unit and history epoch mints (null in a legacy build). */
  let axisSessions: Record<'active' | 'history', number> | null = null
  /** The same for unit 0's shells bound to an issue. */
  let axisShells: Record<'active' | 'history', number> | null = null
  let planted: Planted
  if (cell === null) {
    for (let unit = 0; unit < scale; unit++) mintUnit(unit, 'full')
    planted = plant(scale)
  } else {
    // Unit 0 is planted before anything is added, exactly as `buildCorpus(1)`
    // plants it; the added units then mint the planted unit's per-axis counts.
    mintUnit(0, 'full')
    planted = plant(1)
    axisSessions = { active: 0, history: 0 }
    axisShells = { active: 0, history: 0 }
    for (const s of sessions) {
      axisSessions[sessionAxis(s)] += 1
      if (s['agentKind'] === 'shell' && typeof s['issueId'] === 'string')
        axisShells[sessionAxis(s)] += 1
    }
    const ordinal = { active: 0, history: 0 }
    parts.forEach((part, unit) => {
      if (part === 'full') return
      const k = ++ordinal[part]
      streams.push({
        rng: mulberry32(seed * 1000 + (part === 'active' ? 100 : 200) + k),
        now: part === 'history' ? FIXED_NOW - k * EPOCH_MS : FIXED_NOW,
      })
      enter(unit)
      const start = sessions.length
      mintUnit(unit, part)
      for (const s of sessions.slice(start))
        if (sessionAxis(s) !== part)
          fail(`${part} unit ${unit} minted ${String(s['sessionId'])} on the other axis`)
    })
  }
  const { unscannedIdx, unscannedPath, unscannedOrphan, askerChildren, edgedAskers, resumeTwins } =
    planted

  // The scan: every root with all its worktrees, then the standalone entry a
  // real scan reports for each linked worktree.
  for (const root of roots)
    repos.push({
      path: root.path,
      kind: 'repository',
      branch: 'main',
      worktrees: root.worktrees,
      machineId: root.machineId,
      repoId: root.rid,
    } as GitRepositoryWire)
  repos.push(...standalone)

  // -------------------------------------------------------------------------
  // One workspace unit.
  // -------------------------------------------------------------------------
  function mintUnit(unit: number, part: UnitPart): void {
    const first = mints.length
    const sessionsFirst = sessions.length
    /** The roles this part mints: all of them, or one axis's. */
    const mints_ = (role: Role): boolean => part === 'full' || axisOfRole(role) === part
    // -- worktrees (the discovery scan) -----------------------------------------
    // Each unit adds its worktrees under the SAME roots: the workspace grows
    // inside its repos (live: one repo holds 89% of the issues). A history
    // epoch adds none: finished work's worktrees are gone.
    const freeLanes = new Map<string, string[]>()
    const lanes: string[] = []
    const named = unit === 0 ? ['alpha', 'beta'] : [`u${unit}alpha`, `u${unit}beta`]
    let forkBudget = part === 'history' ? 0 : FORK_TRAP_EXTRA
    if (part !== 'history')
      roots.forEach((root, r) => {
        const { path, rid, machineId } = root
        const worktrees = root.worktrees
        const unitStart = worktrees.length
        for (let w = 0; w < ROOT_WORKTREES[r]!; w++) {
          const nested = w < ROOT_NESTED[r]!
          let wt = nested ? `${path}/.worktrees/w${pad(wtSeq, 5)}` : `/w/${unit}t${pad(wtSeq, 5)}`
          // The named forks (the prefix-ownership cover) sit among the elsewhere
          // lanes of the biggest root; the extra traps are spread through the
          // three big roots.
          const namedAt = r === 0 && !nested ? w - ROOT_NESTED[0]! : -1
          if (namedAt >= 0 && namedAt < 4)
            wt = `/w/${named[namedAt >> 1]}${namedAt % 2 === 1 ? '-fork' : ''}`
          const prev = worktrees.length > unitStart ? worktrees.at(-1)?.path : undefined
          if (
            namedAt < 0 || namedAt >= 5
              ? forkBudget > 0 &&
                r < 3 &&
                prev !== undefined &&
                w % 7 === 0 &&
                !prev.endsWith('-b') &&
                !prev.endsWith('-fork')
              : false
          ) {
            wt = `${prev}-b`
            forkBudget--
          }
          wtSeq++
          worktrees.push({ path: wt, branch: 'task' })
          lanes.push(wt)
          freeLanes.set(rid, [...(freeLanes.get(rid) ?? []), wt])
          standalone.push({
            path: wt,
            kind: 'repository',
            branch: 'task',
            worktrees: [],
            machineId,
          } as unknown as GitRepositoryWire)
          sliceWorktrees.push({
            path: wt,
            repoId: rid,
            repoPath: path,
            repoName: path.slice(1),
            prefix: typeof ROOT_REPO[r] === 'number' ? PREFIXES[ROOT_REPO[r] as number] : null,
          })
        }
      })
    if (forkBudget !== 0) fail(`fork-trap budget left ${forkBudget}`)
    // Lanes an issue can name: shuffled per repo so naming is spread out.
    for (const [rid, list] of freeLanes) freeLanes.set(rid, shuffle(list))

    // -- issues by role --------------------------------------------------------
    const fixed = PLAN.reduce((sum, spec) => sum + spec.stages.reduce((s, [, n]) => s + n, 0), 0)
    const proposedCount = BASE_COUNTS.issues - fixed
    if (proposedCount < 0) fail(`unit plan exceeds ${BASE_COUNTS.issues} issues`)
    const byRole = new Map<Role, number[]>()
    for (const spec of PLAN) {
      if (!mints_(spec.role)) continue
      const stages =
        spec.role === 'proposed' ? [['proposed', proposedCount] as [string, number]] : spec.stages
      const list: number[] = []
      for (const [stage, n] of stages) {
        for (let c = 0; c < n; c++) {
          const closed = stage === 'done'
          list.push(mints.length)
          mints.push({
            role: spec.role,
            unit,
            stage,
            audience: spec.audience,
            archived: spec.archived === true,
            deleted: spec.deleted === true,
            closed,
            closedReason: null,
            parent: null,
            depth: 1,
            mission: spec.role === 'mission' ? mints.length : null,
            repo: '',
            repoPath: '',
            worktree: null,
            createdAt: '',
            updatedAt: '',
            closedAt: null,
            deletedAt: null,
          })
        }
      }
      byRole.set(spec.role, list)
    }
    const end = mints.length
    if (end - first !== unitIssues(part)) fail(`unit ${unit} has ${end - first} issues`)
    const roleList = (role: Role): number[] => byRole.get(role) ?? []

    // -- hierarchy ---------------------------------------------------------------
    // Draw a depth and a tree class (inside a mission or in the hidden bulk)
    // for every child, then attach level by level, so every parent exists at
    // depth d-1 before its children at depth d. Missions and hidden roots are
    // chosen with a heavy tail (live: 154 parents with one child, 15 with 30+).
    const missions = roleList('mission')
    const hiddenRoots: number[] = []
    const pending: Array<{ i: number; depth: number; inMission: boolean }> = []
    for (const spec of PLAN) {
      const list = roleList(spec.role)
      // Children first come from the tail of each role, so the head (low
      // ids) keeps the roots.
      list.forEach((i, k) => {
        if (k < spec.roots || spec.role === 'proposed') {
          if (!TOP_ROLES.has(spec.role) && spec.role !== 'sbsNested' && !LEAF_ROLES.has(spec.role))
            hiddenRoots.push(i)
          return
        }
        if (spec.role === 'rescueChild') return
        const weights = (spec.depth ?? [1]).map((w, d) => [d + 2, w] as const)
        const depth = weighted(weights)
        const inMission = NESTED_ROLES.has(spec.role) || rng() < (spec.inMission ?? 0)
        // A history epoch has no mission (every mission root is active work).
        pending.push({ i, depth, inMission: inMission && missions.length > 0 })
      })
    }
    // Hidden-tree roots: never a human open issue a visible descendant could
    // rescue, and never `proposed` (live: every proposed issue is a root).
    const hiddenTreeRoots = shuffle(
      hiddenRoots.filter((i) => {
        const m = mints[i]!
        return m.role !== 'proposed' && m.role !== 'agentProposed' && m.role !== 'shipping'
      }),
    )
    const missionWeights = missions.map((m, k) => [m, 1 / (k + 1) ** 0.9] as const)
    const hiddenWeights = hiddenTreeRoots.map((m, k) => [m, 1 / (k + 1) ** 0.7] as const)
    const byDepth = { v: new Map<number, number[]>(), h: new Map<number, number[]>() }
    byDepth.v.set(1, [...missions])
    byDepth.h.set(1, [...hiddenTreeRoots])
    const childCount = new Map<number, number>()
    const attach = (child: number, parent: number): void => {
      const m = mints[child]!
      m.parent = parent
      m.depth = mints[parent]!.depth + 1
      m.mission = mints[parent]!.mission
      childCount.set(parent, (childCount.get(parent) ?? 0) + 1)
    }
    pending.sort((a, b) => a.depth - b.depth || a.i - b.i)
    for (const { i, depth, inMission } of pending) {
      const cls = inMission ? byDepth.v : byDepth.h
      let d = depth
      while (d > 2 && (cls.get(d - 1)?.length ?? 0) === 0) d--
      let parent: number
      if (d === 2) parent = weighted(inMission ? missionWeights : hiddenWeights)
      else {
        const candidates = cls.get(d - 1)!
        const hubs = candidates.filter((c) => (childCount.get(c) ?? 0) > 0)
        parent = hubs.length > 0 && rng() < 0.65 ? pick(hubs) : pick(candidates)
      }
      attach(i, parent)
      if (!LEAF_ROLES.has(mints[i]!.role)) {
        const list = cls.get(mints[i]!.depth) ?? []
        list.push(i)
        cls.set(mints[i]!.depth, list)
      }
    }
    // The rescue pairs: one visible child under each sessionless backlog root.
    roleList('rescueChild').forEach((i, k) => {
      attach(i, roleList('rescueParent')[k]!)
    })

    // -- repos per issue ------------------------------------------------------------
    // Visible top rows form eight groups (live: 8): the main repo, five
    // smaller ones, a repo with no repo row (`#seq`) and one that only holds
    // closed rows.
    const visibleTop = [...TOP_ROLES, 'sbsNested' as Role].flatMap((role) => roleList(role))
    const topRepos: Array<number | 'a'> = []
    for (const [j, n] of [
      [1, 60],
      [2, 12],
      [3, 5],
      [4, 3],
      [5, 2],
    ] as const)
      for (let c = 0; c < n; c++) topRepos.push(j)
    while (topRepos.length < visibleTop.length) topRepos.push(0)
    shuffle(topRepos)
    const setRepo = (i: number, j: number | 'a' | 'b'): void => {
      const rid = repoId(j)
      const m = mints[i]!
      m.repo = rid
      const alternates = rootsOf.get(rid) ?? []
      // A few issues sit in an alternate checkout of the same repo (one
      // group, two paths).
      m.repoPath = alternates.length > 1 && rng() < 0.03 ? alternates[1]! : primaryRoot.get(rid)!
    }
    visibleTop.forEach((i, k) => {
      setRepo(i, topRepos[k]!)
    })
    // The `#seq` cover and the closed-only group (rows: active work only).
    if (part !== 'history') {
      setRepo(roleList('topReview')[0]!, 'a')
      setRepo(roleList('topClosed')[0]!, 'a')
      setRepo(roleList('topClosed')[1]!, 6)
      setRepo(roleList('topClosed')[2]!, 6)
    }
    for (let i = first; i < end; i++) {
      const m = mints[i]!
      if (m.repo !== '' || m.parent !== null) continue
      setRepo(i, weighted(HIDDEN_REPO_WEIGHTS))
    }
    // Children live in their root's repo.
    const rootOf = (i: number): number => {
      let cur = i
      while (mints[cur]!.parent !== null) cur = mints[cur]!.parent!
      return cur
    }
    for (let i = first; i < end; i++) {
      const m = mints[i]!
      if (m.parent === null) continue
      const root = mints[rootOf(i)]!
      m.repo = root.repo
      m.repoPath = root.repoPath
    }

    // -- worktrees per issue ------------------------------------------------------------
    const laneShare: Partial<Record<Role, number>> = {
      mission: 0.8,
      topReview: 0.7,
      topInProg: 0.8,
      topPlanning: 0.6,
      topBacklog: 0.4,
      nAgentReview: 0.3,
      nAgentActive: 0.5,
      nAgentDone: 0.2,
      nHumanActive: 0.5,
      rescueChild: 0.5,
      agentReview: 0.2,
      agentActive: 0.2,
      agentDone: 0.03,
      humanDone: 0.03,
    }
    for (let i = first; i < end; i++) {
      const m = mints[i]!
      const share = laneShare[m.role] ?? 0
      if (share === 0 || rng() >= share) continue
      // Drafts never own a worktree (the draft-vessel rule).
      if (m.role === 'topBacklog' && roleList('topBacklog').indexOf(i) < 2) continue
      const free = freeLanes.get(m.repo)
      const lane = free?.shift()
      if (lane !== undefined) m.worktree = lane
    }

    // -- timestamps and close reasons -------------------------------------------------------
    const recentFinish = new Set<number>([
      ...roleList('topClosed').slice(0, 6),
      ...roleList('nAgentDone').filter(() => rng() < 0.3),
    ])
    const doneReasons: Array<[string, number]> = [
      ['done', 90],
      ['duplicate', 5],
      ['superseded', 2],
      ['cancelled', 2],
      ['wontfix', 1],
    ]
    // One timeline: a root is created 3-120 days ago, a child shortly after
    // its parent (never later than 2.5 days ago), and everything that
    // happens to an issue happens after it was created.
    const byDepthFirst = Array.from({ length: end - first }, (_, k) => first + k).sort(
      (a, b) => mints[a]!.depth - mints[b]!.depth || a - b,
    )
    const createdMs = new Map<number, number>()
    const LATEST_CREATE = now - 2.5 * DAY_MS
    for (const i of byDepthFirst) {
      const m = mints[i]!
      const t =
        m.parent === null
          ? now - (3 * DAY_MS + rng() * 117 * DAY_MS)
          : Math.min(createdMs.get(m.parent)! + 10 * MIN_MS + rng() * 2 * DAY_MS, LATEST_CREATE)
      createdMs.set(i, t)
      m.createdAt = iso(t)
    }
    const after = (i: number, minMs: number, maxMs: number): string => {
      const born = createdMs.get(i)! + HOUR_MS
      const lo = Math.max(now - maxMs, born)
      const hi = Math.max(now - minMs, lo)
      return iso(lo + rng() * (hi - lo))
    }
    for (let i = first; i < end; i++) {
      const m = mints[i]!
      if (m.closed) {
        m.closedReason =
          m.role === 'topClosed' && roleList('topClosed').indexOf(i) < 20
            ? 'done'
            : weighted(doneReasons)
        m.closedAt = recentFinish.has(i)
          ? ago(1 * HOUR_MS, 20 * HOUR_MS)
          : after(i, 2 * DAY_MS, 100 * DAY_MS)
        m.updatedAt = m.closedAt
      } else if (VISIBLE_ROLES.has(m.role)) {
        m.updatedAt = ago(5 * MIN_MS, 2 * DAY_MS)
      } else {
        m.updatedAt = after(i, 1 * DAY_MS, 100 * DAY_MS)
      }
      if (m.deleted) m.deletedAt = after(i, 1 * DAY_MS, 100 * DAY_MS)
    }
    // Ids in creation order.
    const byCreation = [...byDepthFirst].sort(
      (a, b) => createdMs.get(a)! - createdMs.get(b)! || a - b,
    )
    byCreation.forEach((i, rank) => {
      idNo[i] = first + rank
      indexOfId.set(`i${first + rank}`, i)
    })

    const quietMissions = new Set(
      missions
        .filter((i) => mints[i]!.stage !== 'done' && (childCount.get(i) ?? 0) > 0)
        .slice(0, 5),
    )
    units.push({
      part,
      first,
      end,
      rootPaths,
      primaryRoot,
      rootsOf,
      freeLanes,
      lanes,
      quietMissions,
      goneSeq: 0,
    })
    mintSessions(unit, byRole)
    spans.push({ part, issues: [first, end], sessions: [sessionsFirst, sessions.length] })
  }

  // -------------------------------------------------------------------------
  // Sessions of one unit. Live: 86% hibernated, 13% exited, a handful live;
  // 21% shells; 15% bound to no issue; 76% carry a resume ref.
  // -------------------------------------------------------------------------
  function mintSessions(unit: number, byRole: Map<Role, number[]>): void {
    const u = units[unit]!
    const { part } = u
    const roleList = (role: Role): number[] => byRole.get(role) ?? []
    const start = sessions.length
    // An added unit mints the planted unit 0's sessions on its own axis.
    const target =
      part === 'full'
        ? BASE_COUNTS.sessions
        : (axisSessions?.[part] ?? fail(`${part} unit ${unit} before unit 0 was planted`))
    const gone = (): string => `/gone/${unit}g${pad(u.goneSeq++, 5)}`
    const rootLaneOf = (i: number): string => u.primaryRoot.get(mints[i]!.repo) ?? u.rootPaths[0]!
    /** Where a bound session runs: the issue's worktree, else its repo root
     *  or a checkout that no longer exists (live: 43% of sessions sit in no
     *  lane). */
    const cwdFor = (i: number, sub = false): string => {
      const wt = mints[i]!.worktree
      if (wt !== null) return sub ? `${wt}/src` : wt
      return rng() < 0.28 ? rootLaneOf(i) : gone()
    }
    const agentKind = (): string => weighted(AGENT_KINDS)
    const base = (cwd: string, kind = agentKind()): SessionRecord => {
      const id = `s${sessions.length}`
      const s: SessionRecord = {
        sessionId: id,
        agentKind: kind,
        title: `Session ${sessions.length}`,
        cwd,
        status: 'hibernated',
        controllerId: `c${sessions.length}`,
        geometry: { cols: 80, rows: 24 },
        epoch: 1,
        clientCount: 0,
        createdAt: ago(10 * DAY_MS, 90 * DAY_MS),
        lastActiveAt: ago(1 * HOUR_MS, 20 * DAY_MS),
        origin: { kind: 'spawn' },
        archived: false,
        readAt: null,
        unread: false,
      }
      if (kind !== 'shell' && rng() < 0.96)
        s['resume'] = {
          kind: RESUME_KIND[kind] ?? 'codex-thread',
          value: `${RESUME_KIND[kind]}-${id}`,
        }
      return s
    }
    const push = (s: SessionRecord, issue: number | null): SessionRecord => {
      if (issue !== null) s['issueId'] = idOf(issue)
      sessions.push(s)
      return s
    }
    type Variant =
      | 'retained'
      | 'offer'
      | 'working'
      | 'liveIdle'
      | 'liveOffer'
      | 'exitedRecent'
      | 'doneTurn'
    /** A session that keeps its issue's row. */
    const rowSession = (i: number | null, variant: Variant, cwd?: string): SessionRecord => {
      const s = base(cwd ?? cwdFor(i!))
      const live = variant === 'working' || variant === 'liveIdle' || variant === 'liveOffer'
      const activeAt = live
        ? variant === 'working'
          ? ago(30 * 1000, 25 * MIN_MS)
          : ago(10 * MIN_MS, 3 * HOUR_MS)
        : variant === 'exitedRecent'
          ? ago(2 * HOUR_MS, 20 * HOUR_MS)
          : ago(1 * HOUR_MS, 14 * DAY_MS)
      s['lastActiveAt'] = activeAt
      s['readAt'] = iso(Date.parse(activeAt) + 5 * MIN_MS)
      if (live) {
        s['status'] = 'live'
        s['clientCount'] = 1
      }
      if (variant === 'doneTurn') {
        // A finished turn on finished work: kept only while unread within
        // 7 days of the close (visibility.ts:60), and it reads `done`.
        s['readAt'] = null
        s['unread'] = true
      }
      if (variant === 'exitedRecent') {
        s['status'] = 'exited'
        s['stoppedAt'] = activeAt
        s['readAt'] = null
        s['unread'] = true
        s['agentState'] = { phase: 'ended', since: activeAt, nativeSubagentCount: 0 }
      } else {
        s['agentState'] = {
          phase: variant === 'working' ? 'working' : 'idle',
          since: activeAt,
          nativeSubagentCount: 0,
          ...(variant === 'doneTurn' ? { idle: { kind: 'done' } } : {}),
        }
      }
      if (variant === 'offer' || variant === 'liveOffer')
        s['offer'] = {
          message: 'Review ready',
          actions: [{ label: 'Approve', prompt: 'approve' }],
          createdAt: activeAt,
        }
      return push(s, i)
    }
    /** A decayed session: archived, or stopped and read long ago. */
    const history = (i: number | null, cwd: string, kind = agentKind()): SessionRecord => {
      const s = base(cwd, kind)
      const stoppedAt = ago(3 * DAY_MS, 200 * DAY_MS)
      s['lastActiveAt'] = stoppedAt
      s['stoppedAt'] = stoppedAt
      s['readAt'] = iso(Date.parse(stoppedAt) + HOUR_MS)
      const r = rng()
      if (r < 0.45) s['archived'] = true
      else if (r > 0.8) s['status'] = 'exited'
      if (rng() < 0.6) s['agentState'] = { phase: 'idle', since: stoppedAt, nativeSubagentCount: 0 }
      return push(s, i)
    }

    const inQuiet = (i: number): boolean => {
      const mission = mints[i]!.mission
      return mission !== null && u.quietMissions.has(mission)
    }
    const variantOf = (options: Array<[Variant, number]>, i: number): Variant => {
      const v = weighted(options)
      // Only the quiet missions' roots work inside a quiet subtree (the #2 rule).
      return v === 'working' && inQuiet(i) ? 'retained' : v
    }

    // -- sessions that keep rows ---------------------------------------------------
    for (const i of roleList('mission')) {
      const m = mints[i]!
      if (u.quietMissions.has(i)) {
        // The #2 target's family: one working session among five, so a pool
        // that re-reads the family on a phase change reads more than the
        // per-level budget (3).
        rowSession(i, 'working')
        rowSession(i, 'liveIdle')
        rowSession(i, 'retained')
        rowSession(i, 'retained')
        rowSession(i, 'offer')
        continue
      }
      if (m.closed) {
        if (rng() < 0.5)
          rowSession(
            i,
            weighted([
              ['retained', 1],
              ['exitedRecent', 1],
            ]),
          )
        continue
      }
      const n = int(1, 3)
      for (let c = 0; c < n; c++)
        rowSession(
          i,
          variantOf(
            [
              ['offer', 40],
              ['retained', 30],
              ['working', 20],
              ['liveOffer', 10],
            ],
            i,
          ),
        )
    }
    for (const i of roleList('topReview')) {
      if (rng() >= 0.72) continue
      const n = rng() < 0.8 ? 1 : 2
      for (let c = 0; c < n; c++)
        rowSession(
          i,
          variantOf(
            [
              ['offer', 45],
              ['retained', 30],
              ['exitedRecent', 10],
              ['liveOffer', 10],
              ['working', 5],
            ],
            i,
          ),
        )
    }
    for (const i of roleList('topInProg')) {
      const n = int(1, 2)
      for (let c = 0; c < n; c++)
        rowSession(
          i,
          variantOf(
            [
              ['working', 35],
              ['retained', 45],
              ['offer', 20],
            ],
            i,
          ),
        )
    }
    for (const i of roleList('topPlanning'))
      rowSession(
        i,
        variantOf(
          [
            ['retained', 50],
            ['offer', 30],
            ['working', 20],
          ],
          i,
        ),
      )
    roleList('topBacklog').forEach((i, k) => {
      // The first two are draft vessels: an agent working in a draft.
      rowSession(i, k < 2 ? 'working' : 'retained', k < 2 ? rootLaneOf(i) : cwdFor(i))
    })
    for (const i of roleList('topClosed'))
      if (rng() < 0.3)
        rowSession(
          i,
          weighted([
            ['retained', 2],
            ['exitedRecent', 1],
          ]),
        )
    for (const i of roleList('sbsNested')) {
      const m = mints[i]!
      if (m.stage === 'in_progress' || m.stage === 'backlog') rowSession(i, 'retained')
    }
    /** A finished nested row whose last run ended: live reads it `done`. */
    const finishedRun = (i: number, share: number): void => {
      const v: Variant = rng() < share ? (rng() < 0.6 ? 'doneTurn' : 'exitedRecent') : 'retained'
      const m = mints[i]!
      if (v !== 'retained' && Date.parse(m.closedAt!) < now - 6 * DAY_MS) {
        // Kept only within 7 days of the close; the child was created at
        // least 2.5 days ago, so this stays after its creation.
        m.closedAt = ago(26 * HOUR_MS, 2.4 * DAY_MS)
        m.updatedAt = m.closedAt
      }
      rowSession(i, v)
    }
    for (const i of roleList('nAgentDone')) finishedRun(i, 0.45)
    for (const i of roleList('nAgentReview'))
      rowSession(
        i,
        variantOf(
          [
            ['offer', 45],
            ['retained', 55],
          ],
          i,
        ),
      )
    for (const i of roleList('nAgentActive'))
      rowSession(
        i,
        variantOf(
          [
            ['working', 35],
            ['retained', 65],
          ],
          i,
        ),
      )
    for (const i of roleList('nHumanDone')) finishedRun(i, 0.4)
    for (const i of roleList('nHumanActive'))
      if (rng() < 0.7)
        rowSession(
          i,
          variantOf(
            [
              ['working', 45],
              ['retained', 35],
              ['offer', 20],
            ],
            i,
          ),
        )
    for (const i of roleList('nHumanBacklog')) rowSession(i, 'retained')
    for (const i of roleList('rescueChild'))
      rowSession(
        i,
        variantOf(
          [
            ['working', 40],
            ['retained', 60],
          ],
          i,
        ),
      )

    // -- rows the nesting pass drops -----------------------------------------------------
    // Hidden agent issues whose last run never stopped (live: most agent
    // rows are built and then dropped at top level). Their sessions sit in no
    // lane, so they cannot surface as worktree rows either, and no open human
    // ancestor sits above them for the rescue walk to materialise.
    const rescueSafe = (i: number): boolean => {
      let cur = mints[i]!.parent
      while (cur !== null) {
        const p = mints[cur]!
        if (p.archived || p.deleted) return true
        if (p.audience === 'human' && !p.closed && p.stage !== 'proposed') return false
        cur = p.parent
      }
      return true
    }
    const dropped = roleList('agentDone').filter(
      (i) => mints[i]!.mission === null && mints[i]!.parent !== null && rescueSafe(i),
    )
    for (const i of dropped.slice(0, 150)) rowSession(i, 'retained', gone())

    // -- unbound sessions (prefix ownership) -----------------------------------------------
    // Live: 15.2% of sessions carry no issue; 3.3% sit in a repo root, 0.9% in
    // a worktree, 11.0% in no lane.
    const laneOwnerIssues = new Set<number>()
    for (let i = u.first; i < u.end; i++) if (mints[i]!.worktree !== null) laneOwnerIssues.add(i)
    const orphanTargets = [...laneOwnerIssues].filter((i) => {
      const m = mints[i]!
      return VISIBLE_ROLES.has(m.role) && !inQuiet(i) && m.role !== 'mission' && !m.closed
    })
    // Live orphans: running in a visible issue's worktree, owned by the prefix.
    // Unbound runs that never stopped are active work: no history epoch has them.
    for (let k = 0; k < (part === 'history' ? 0 : 8); k++) {
      const i = orphanTargets[k % orphanTargets.length]
      if (i === undefined) fail('no visible worktree for the live orphans')
      const s = base(`${mints[i]!.worktree}/sub${k % 3 === 0 ? '/deep' : ''}`)
      const activeAt = ago(2 * MIN_MS, 90 * MIN_MS)
      s['status'] = 'live'
      s['clientCount'] = 1
      s['lastActiveAt'] = activeAt
      s['readAt'] = iso(Date.parse(activeAt) + 5 * MIN_MS)
      s['agentState'] = {
        phase: k % 4 === 3 ? 'idle' : 'working',
        since: activeAt,
        nativeSubagentCount: 0,
      }
      push(s, null)
    }
    // Four unbound runs in a repo root that never stopped: the worktree rows
    // live shows (4) — a root lane no issue names.
    for (let k = 0; k < (part === 'history' ? 0 : 4); k++)
      rowSession(null, 'retained', u.rootPaths[(3 + 4 * unit + k) % u.rootPaths.length]!)
    // Decayed unbound runs are history: no active unit has them. A history
    // epoch's lanes are gone, so what ran in one ran in a vanished checkout.
    const decayed = part === 'active' ? 0 : 1
    const rootCwd = (): string => `${pick(u.rootPaths)}${rng() < 0.5 ? '' : '/packages/app'}`
    const laneCwd = (): string => (u.lanes.length > 0 ? pick(u.lanes) : gone())
    for (let k = 0; k < 68 * decayed; k++) history(null, rootCwd())
    for (let k = 0; k < 11 * decayed; k++) history(null, `${laneCwd()}/tmp`)
    for (let k = 0; k < 203 * decayed; k++) history(null, gone())
    // Shells: 21% of sessions, never in the sidebar (sidebarSessions).
    for (let k = 0; k < 70 * decayed; k++) history(null, rootCwd(), 'shell')
    for (let k = 0; k < 20 * decayed; k++) history(null, laneCwd(), 'shell')
    for (let k = 0; k < 270 * decayed; k++) history(null, gone(), 'shell')
    const withSessions = [
      ...new Set(
        sessions
          .slice(start)
          .flatMap((s) => (typeof s['issueId'] === 'string' ? [s['issueId'] as string] : [])),
      ),
    ]
    // Shells on issues that have sessions; an added unit takes unit 0's on its axis.
    const boundShells =
      part === 'full' ? 540 : (axisShells?.[part] ?? fail(`${part} unit before unit 0`))
    for (let k = 0; k < boundShells; k++) {
      const issueId = pick(withSessions)
      const i = mintOf(issueId)
      history(i, rng() < 0.3 ? rootLaneOf(i) : cwdFor(i), 'shell')
    }

    // -- history to the exact session count ------------------------------------------------
    const remaining = target - (sessions.length - start)
    if (remaining < 0)
      fail(`unit ${unit} plans ${sessions.length - start} sessions, want ${target}`)
    const historyWeights: Array<[number, number]> = []
    const specOf = new Map(PLAN.map((spec) => [spec.role, spec]))
    for (let i = u.first; i < u.end; i++) {
      const w = specOf.get(mints[i]!.role)!.history
      if (w > 0) historyWeights.push([i, w])
    }
    for (let k = 0; k < remaining; k++) {
      const i = weighted(historyWeights)
      history(i, cwdFor(i))
    }
    if (sessions.length - start !== target) fail(`unit ${unit} sessions drift`)
  }

  // -------------------------------------------------------------------------
  // Planted shapes (every unit minted so far: the whole legacy corpus, a
  // cell's unit 0). They reuse rows the corpus already has, so every count
  // stays exact.
  // -------------------------------------------------------------------------
  function allOf(role: Role): number[] {
    const out: number[] = []
    mints.forEach((m, i) => {
      if (m.role === role) out.push(i)
    })
    return out
  }
  function sessionsOfIssue(): Map<string, SessionRecord[]> {
    const map = new Map<string, SessionRecord[]>()
    for (const s of sessions) {
      const id = s['issueId']
      if (typeof id !== 'string') continue
      const list = map.get(id) ?? []
      list.push(s)
      map.set(id, list)
    }
    return map
  }

  /** `plantScale` groups of each shape: the scale of the corpus minted so far. */
  function plant(plantScale: number): Planted {
    // -- unscanned worktree (POD-4550, handover from POD-4546) ---------------------------
    // A live issue can name a worktree the discovery scan never reported (a
    // checkout on another machine, one made outside Podium, a scan that has not
    // run yet). Its path lives ONLY on `issue.worktreePath`: it is in no repo's
    // `worktrees` and no session's cwd equals it. A prefix relation that only
    // materialises worktrees the scan reached silently drops the sessions under
    // it. The case: the last sessionless visible root (so the seat is the ONLY
    // thing that can make it working) gets an unscanned path, and the first live
    // working orphan moves under it.
    const unscannedIdx = allOf('sessless').at(-1)
    if (unscannedIdx === undefined) fail('no sessionless visible root for the unscanned worktree')
    const unscannedPath = `/w/unscanned-${idOf(unscannedIdx)}`
    mints[unscannedIdx]!.worktree = unscannedPath
    const unscannedOrphan = sessions.find(
      (s) =>
        s['issueId'] == null &&
        s['status'] === 'live' &&
        (s['agentState'] as { phase?: string } | undefined)?.phase === 'working' &&
        /\/sub(\/deep)?$/.test(s['cwd'] as string),
    )
    if (unscannedOrphan === undefined)
      fail('no live working orphan to seat under the unscanned worktree')
    unscannedOrphan['cwd'] = `${unscannedPath}/sub`

    // -- hidden askers and resume twins (POD-4551) ----------------------------------
    // Sessions come from the tail of the history on hidden closed issues; the
    // roots are sessionless visible roots (active human stage, no sessions, no
    // children, no worktree), so each shape alone decides what its root's row
    // shows.
    const donorRoles = new Set<Role>(['agentDone', 'agentDoneArch', 'humanDoneArch'])
    const donors = sessions
      .filter((s) => {
        const id = s['issueId']
        if (typeof id !== 'string' || s['agentKind'] === 'shell' || s['stoppedAt'] === undefined)
          return false
        return donorRoles.has(mints[mintOf(id)]!.role)
      })
      .reverse()
    const takeDonor = (): SessionRecord => {
      const donor = donors.shift()
      if (donor === undefined) fail('hidden history too small for the POD-4551 shapes')
      return donor
    }
    const cwdOfIssue = (i: number): string => {
      const m = mints[i]!
      return m.worktree ?? units[m.unit]!.primaryRoot.get(m.repo) ?? '/repo-000'
    }
    const reseat = (
      issueIdx: number,
      fields: {
        status: string
        activeAgoMs: number
        phase: string
        offer?: boolean
        stoppedAgoMs?: number
        resume?: { kind: string; value: string }
      },
    ): string => {
      const s = takeDonor()
      const activeAt = iso(FIXED_NOW - fields.activeAgoMs)
      s['issueId'] = idOf(issueIdx)
      s['cwd'] = cwdOfIssue(issueIdx)
      s['status'] = fields.status
      s['archived'] = false
      s['lastActiveAt'] = activeAt
      s['readAt'] = iso(FIXED_NOW - fields.activeAgoMs + 5 * MIN_MS)
      s['unread'] = false
      s['agentState'] = { phase: fields.phase, since: activeAt, nativeSubagentCount: 0 }
      if (fields.stoppedAgoMs === undefined) delete s['stoppedAt']
      else s['stoppedAt'] = iso(FIXED_NOW - fields.stoppedAgoMs)
      if (fields.offer) s['offer'] = { message: 'Needs input', actions: [], createdAt: activeAt }
      else delete s['offer']
      if (fields.resume) s['resume'] = fields.resume
      return s['sessionId'] as string
    }
    // Not `review`: a review-stage root asks on its own account (a pending
    // decision), which would hide whether the shape's ask reached it.
    const sessionlessRoots = allOf('sessless').filter((i) => i !== unscannedIdx)

    // Hidden askers (the L1d shape, POD-4549): an asking session on an archived
    // or proposed child of a visible root. The legacy flat pass skips hidden
    // issues (rows.ts:63-69) and the worktree lanes suppress their sessions
    // (rows.ts:201-210), so the ask detaches: the root must NOT read asking. A
    // pool that bubbles through the formal subtree turns the root amber.
    const hasChild = new Set(mints.flatMap((m) => (m.parent === null ? [] : [m.parent])))
    // Open leaves only (a closed child's offer no longer asks, motionPhase), with
    // no worktree; spin-off edges are minted after, and skip these leaves.
    // Archived and proposed alternate until the scarcer runs out.
    const hiddenLeaf = (m: Mint, i: number): boolean =>
      !hasChild.has(i) && m.worktree === null && !m.closed && m.parent === null
    const archivedLeaves = allOf('humanArchOpen').filter((i) => hiddenLeaf(mints[i]!, i))
    const proposedLeaves = allOf('proposed').filter((i) => hiddenLeaf(mints[i]!, i))
    const ASKERS_1X = 20
    const edgedAskers: EdgedAsker[] = []
    const askerChildren = new Set<number>()
    for (let k = 0; k < ASKERS_1X * plantScale; k++) {
      const root = sessionlessRoots[k]
      if (root === undefined) fail('not enough sessionless roots for the askers')
      // Each root takes a hidden leaf of its own unit.
      const unit = mints[root]!.unit
      const pool = k % 2 === 0 ? archivedLeaves : proposedLeaves
      const at = pool.findIndex((i) => mints[i]!.unit === unit)
      const child = at < 0 ? undefined : pool.splice(at, 1)[0]
      if (child === undefined) fail('not enough hidden leaves for the askers')
      mints[child]!.parent = root
      mints[child]!.depth = mints[root]!.depth + 1
      mints[child]!.repo = mints[root]!.repo
      mints[child]!.repoPath = mints[root]!.repoPath
      askerChildren.add(child)
      const sessionId = reseat(child, {
        status: 'live',
        activeAgoMs: 20 * MIN_MS + k * MIN_MS,
        phase: 'idle',
        offer: true,
      })
      edgedAskers.push({ rootId: idOf(root), childId: idOf(child), sessionId })
    }

    // Resume twins (dedupeSessionsByResume, session-identity.ts:45; the runtime
    // applies it to every session read, optimism.ts:876). One group of each
    // kind per scale unit, each on its own sessionless visible root:
    // - inactive: an older hibernated ask + a newer exited run. Rank beats
    //   recency, so the collapse keeps the ask: the root reads asking. A pool
    //   that breaks on recency alone keeps the exited run and loses the ask.
    // - tie: two hibernated rows, an older ask and a newer quiet one. Equal
    //   rank, so the most recent wins: the root reads NOT asking. Without the
    //   collapse the stale ask shows (the disabled-collapse control).
    // - live: a live working run + an older hibernated ask. A group touching a
    //   live row is kept in full: the root reads working AND asking. A pool
    //   that collapses it anyway loses the ask.
    const resumeTwins: ResumeTwinGroup[] = []
    const twinRoots = sessionlessRoots.slice(ASKERS_1X * plantScale)
    for (let k = 0; k < plantScale; k++) {
      const kinds: ResumeTwinKind[] = ['inactive', 'tie', 'live']
      kinds.forEach((kind, g) => {
        const root = twinRoots[3 * k + g]
        if (root === undefined) fail('not enough sessionless roots for the resume twins')
        const ref = { kind: 'codex-thread', value: `thread-twin-${kind}-${k}` }
        const ask = reseat(root, {
          status: 'hibernated',
          activeAgoMs: 6 * HOUR_MS,
          phase: 'idle',
          offer: true,
          resume: ref,
        })
        const other =
          kind === 'inactive'
            ? reseat(root, {
                status: 'exited',
                activeAgoMs: 3 * HOUR_MS,
                phase: 'ended',
                stoppedAgoMs: 3 * HOUR_MS,
                resume: ref,
              })
            : kind === 'tie'
              ? reseat(root, {
                  status: 'hibernated',
                  activeAgoMs: 2 * HOUR_MS,
                  phase: 'idle',
                  resume: ref,
                })
              : reseat(root, {
                  status: 'live',
                  activeAgoMs: 60 * 1000,
                  phase: 'working',
                  resume: ref,
                })
        resumeTwins.push({
          kind,
          issueId: idOf(root),
          ref,
          sessionIds: [ask, other],
          keptSessionIds: kind === 'live' ? [ask, other] : kind === 'inactive' ? [ask] : [other],
        })
      })
    }

    return { unscannedIdx, unscannedPath, unscannedOrphan, askerChildren, edgedAskers, resumeTwins }
  }

  // -------------------------------------------------------------------------
  // Relations: spin-off origins, started-by, coordinators, dependency edges.
  // Minted after every session is seated, so a starter or coordinator names
  // the session where it ends up.
  // -------------------------------------------------------------------------
  const n = mints.length
  const specOf = new Map(PLAN.map((spec) => [spec.role, spec]))
  const bySession = sessionsOfIssue()
  const agentSessionsOf = (i: number): SessionRecord[] =>
    (bySession.get(idOf(i)) ?? []).filter((s) => s['agentKind'] !== 'shell')
  const unitAgentSessions = units.map((u) =>
    sessions.filter((s) => {
      const id = s['issueId']
      if (typeof id !== 'string' || s['agentKind'] === 'shell') return false
      const i = mintOf(id)
      return i >= u.first && i < u.end
    }),
  )
  /** Visible, non-draft top rows with a session: where an `sbsNested` issue
   *  nests (rows.ts:302 refuses a draft vessel). */
  const starterRows = units.map((u) =>
    [...allOf('mission'), ...allOf('topReview'), ...allOf('topInProg'), ...allOf('topPlanning')]
      .filter((i) => i >= u.first && i < u.end && agentSessionsOf(i).length > 0)
      .sort((a, b) => a - b),
  )
  const reviewRow = (i: number): boolean =>
    VISIBLE_ROLES.has(mints[i]!.role) && mints[i]!.stage === 'review'
  const isVisibleRow = (i: number): boolean => VISIBLE_ROLES.has(mints[i]!.role)

  // Spin-off origins (`discovered-from`, live 34.6%). An origin is never a
  // visible review row: a review row whose work continued in a live spin-off
  // stops asking (continuation, row-attention.ts:150), which spec §6 keeps
  // out of the comparison.
  const originOf = new Map<number, number>()
  const unitOriginPool = units.map((u) => {
    const out: number[] = []
    for (let i = u.first; i < u.end; i++) if (!reviewRow(i) && !askerChildren.has(i)) out.push(i)
    return out
  })
  const mintOrigin = (i: number): void => {
    const pool = unitOriginPool[mints[i]!.unit]!
    for (let attempt = 0; attempt < 8; attempt++) {
      const origin = pick(pool)
      if (origin !== i && originOf.get(origin) !== i) {
        originOf.set(i, origin)
        return
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const m = mints[i]!
    enter(m.unit)
    if (askerChildren.has(i) || m.role === 'sbsNested' || m.role === 'sessless') continue
    if (rng() < specOf.get(m.role)!.df) mintOrigin(i)
  }

  // Started-by (live 72.9%): the session that filed the issue. A child's
  // starter is usually a session of its nearest ancestor that has one; a
  // root's is a session somewhere in its workspace.
  const startedBy = new Map<number, string>()
  for (let i = 0; i < n; i++) {
    const m = mints[i]!
    enter(m.unit)
    if (askerChildren.has(i)) continue
    if (m.role === 'sbsNested') {
      const rows = starterRows[m.unit]!
      if (rows.length === 0) fail('no visible row with a session for the started-by nesting')
      const row = rows[(i * 7) % rows.length]!
      startedBy.set(i, agentSessionsOf(row)[0]!['sessionId'] as string)
      continue
    }
    if (rng() >= specOf.get(m.role)!.sbs) continue
    let starter: SessionRecord | undefined
    let cur = m.parent
    while (starter === undefined && cur !== null) {
      const own = agentSessionsOf(cur)
      if (own.length > 0 && rng() < 0.8) starter = pick(own)
      cur = mints[cur]!.parent
    }
    starter ??= pick(unitAgentSessions[m.unit]!)
    startedBy.set(i, starter['sessionId'] as string)
    // A top-level row that carries a starter keeps its own row only as a
    // spin-off (rows.ts:288): live has 55 such rows and 12 that nest.
    if (m.parent === null && isVisibleRow(i) && !originOf.has(i)) mintOrigin(i)
  }

  // Coordinators (live 25.4%): almost always one of the issue's own sessions.
  const coordinator = new Map<number, string>()
  for (let i = 0; i < n; i++) {
    const m = mints[i]!
    enter(m.unit)
    // Live counts coordinators over every issue; only issues with a session
    // can have one here, so the per-kind share is lifted to match.
    const p = Math.min(0.95, specOf.get(m.role)!.coord * COORD_LIFT)
    if (p === 0 || rng() >= p) continue
    if (m.role === 'humanDeleted') {
      coordinator.set(i, `s-gone-${i}`)
      continue
    }
    const own = agentSessionsOf(i)
    if (own.length === 0) continue
    coordinator.set(
      i,
      (rng() < 0.95 ? own[0]! : pick(unitAgentSessions[m.unit]!))['sessionId'] as string,
    )
  }

  // Dependency edges. `blocks` (live 33.9% of issues): mostly between
  // siblings of one mission, mostly closed on both ends. A visible row is
  // only ever blocked by finished work: `blocked` changes what a row asks
  // (issuePendingDecision), and spec §6 keeps dependency semantics out of
  // the comparison.
  const deps: Array<{ from: number; to: number; type: string }> = []
  for (const [from, to] of originOf) deps.push({ from, to, type: 'discovered-from' })
  const childrenOf = new Map<number, number[]>()
  mints.forEach((m, i) => {
    if (m.parent === null) return
    const list = childrenOf.get(m.parent) ?? []
    list.push(i)
    childrenOf.set(m.parent, list)
  })
  const blockShare: Partial<Record<Role, number>> = {
    agentDone: 0.3,
    nAgentDone: 0.3,
    agentDoneArch: 0.17,
    humanDone: 0.32,
    nHumanDone: 0.32,
    agentBacklog: 0.29,
    agentReview: 0.13,
    nAgentReview: 0.13,
    agentActive: 0.16,
    nAgentActive: 0.16,
    humanBacklog: 0.08,
    humanDoneArch: 0.04,
    agentArch: 0.4,
  }
  for (let i = 0; i < n; i++) {
    const m = mints[i]!
    enter(m.unit)
    if (rng() >= (blockShare[m.role] ?? 0) * BLOCK_LIFT) continue
    const count = weighted([
      [1, 42],
      [2, 22],
      [3, 14],
      [4, 9],
      [5, 7],
      [6, 6],
    ] as const)
    const siblings =
      m.parent === null ? [] : (childrenOf.get(m.parent) ?? []).filter((s) => s !== i)
    const seen = new Set<number>()
    for (let c = 0; c < count; c++) {
      const to =
        siblings.length > 0 && rng() < 0.75 ? pick(siblings) : pick(unitOriginPool[m.unit]!)
      if (to === i || seen.has(to)) continue
      if (isVisibleRow(i) && !mints[to]!.closed) continue
      if (mints[to]!.stage !== 'done' && isVisibleRow(i)) continue
      seen.add(to)
      deps.push({ from: i, to, type: 'blocks' })
    }
  }
  // The rest of the live mix, per unit: related 234, supersedes 25,
  // duplicate 15, blocked-by 12, waits-on 10, duplicates 3, and one edge of
  // a type no code knows.
  for (const u of units) {
    enter(units.indexOf(u))
    const pool = unitOriginPool[units.indexOf(u)]!
    // An added unit carries the unit's mix in proportion to its issues.
    const share = (u.end - u.first) / BASE_COUNTS.issues
    for (const [type, full] of [
      ['related', 234],
      ['supersedes', 25],
      ['duplicate', 15],
      ['blocked-by', 12],
      ['waits-on', 10],
      ['duplicates', 3],
      ['bogus', 1],
    ] as const) {
      const count = u.part === 'full' ? full : Math.round(full * share)
      for (let c = 0; c < count; c++) {
        const from = pick(pool)
        let to = pick(pool)
        if (to === from) to = pool[(pool.indexOf(from) + 1) % pool.length]!
        deps.push({ from, to, type })
      }
    }
  }
  // A cell numbers each unit's edges together (stable: unit 0's in the order
  // `buildCorpus(1)` numbers them), so an added unit shifts no edge id.
  if (cell !== null) deps.sort((a, b) => mints[a.from]!.unit - mints[b.from]!.unit)
  const depsOf = new Map<number, Array<{ id: string; type: string }>>()
  const issueDeps: IssueDepProjection[] = deps.map((d, k) => {
    const list = depsOf.get(d.from) ?? []
    list.push({ id: idOf(d.to), type: d.type })
    depsOf.set(d.from, list)
    return {
      id: `d${k}`,
      fromId: idOf(d.from),
      toId: idOf(d.to),
      type: d.type,
    } as unknown as IssueDepProjection
  })
  const blockedIds = new Set<number>()
  for (const d of deps)
    if (d.type === 'blocks' && mints[d.to]!.stage !== 'done') blockedIds.add(d.from)

  // needsHuman (live 0.9%), on hidden open work only: it is an attention
  // input spec §6 keeps out of the comparison.
  const needsHuman = new Set<number>()
  units.forEach((u, unit) => {
    // Finished history asks nothing of a human.
    if (u.part === 'history') return
    enter(unit)
    const open: number[] = []
    for (let i = u.first; i < u.end; i++) if (!isVisibleRow(i) && !mints[i]!.closed) open.push(i)
    for (const i of shuffle(open).slice(0, NEEDS_HUMAN_1X)) needsHuman.add(i)
  })

  // -------------------------------------------------------------------------
  // Wire rows.
  // -------------------------------------------------------------------------
  const titleOf = (i: number): string => `${pick(TITLE_VERBS)} ${pick(TITLE_NOUNS)} ${i}`
  const deferOf = (m: Mint): string | null => {
    if (!['mission', 'topReview', 'topInProg', 'topPlanning'].includes(m.role) || m.closed)
      return null
    const r = rng()
    if (r < 0.14) return iso(FIXED_NOW + 45 * DAY_MS + rng() * 10 * DAY_MS)
    if (r < 0.24) return iso(FIXED_NOW - 45 * DAY_MS - rng() * 10 * DAY_MS)
    if (r < 0.265) return 'next-message'
    return null
  }
  const drafts = new Set(
    units.flatMap((u) =>
      allOf('topBacklog')
        .filter((i) => i >= u.first && i < u.end)
        .slice(0, 2),
    ),
  )
  const issues: IssueViewModel[] = []
  const issueProjections: IssueProjection[] = []
  mints.forEach((m, i) => {
    enter(m.unit)
    const title = drafts.has(i) ? 'Draft' : titleOf(i)
    const deferUntil = deferOf(m)
    const wireDeps = depsOf.get(i) ?? []
    const wire = {
      id: idOf(i),
      title,
      description: `Body ${i}`,
      seq: idNo[i]! + 1,
      stage: m.stage,
      parentBranch: 'main',
      blockedByNotes: [],
      deps: wireDeps,
      dependents: [],
      ready: !blockedIds.has(i),
      blocked: blockedIds.has(i),
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      archived: m.archived,
      pinned: false,
      readAt: null,
      intentOrigin: 'human',
      audience: m.audience,
      isDraftVessel: drafts.has(i),
      repoPath: m.repoPath,
      repoId: m.repo,
      parentId: m.parent === null ? undefined : idOf(m.parent),
      closedAt: m.closedAt,
      closedReason: m.closedReason,
      deferUntil,
      tuckedAt: null,
      sortKey: null,
      worktreePath: m.worktree,
      branch: null,
      needsHuman: needsHuman.has(i),
      ...(needsHuman.has(i)
        ? {
            asked: {
              question: `Question ${i}`,
              options: ['Ship', 'Hold'],
              at: iso(FIXED_NOW),
              by: `s-asker-${i}`,
            },
          }
        : {}),
      priority: 2,
      type: 'task',
      labels: [],
    } as unknown as Record<string, unknown>
    if (m.deletedAt !== null) wire['deletedAt'] = m.deletedAt
    if (startedBy.has(i)) wire['startedBySession'] = startedBy.get(i)
    if (coordinator.has(i)) wire['coordinatorSessionId'] = coordinator.get(i)
    const projection = {
      id: idOf(i),
      seq: idNo[i]! + 1,
      title,
      description: { value: `Body ${i}` },
      stage: m.stage,
      archived: m.archived,
      priority: 2,
      type: 'task',
      labels: [],
      blockedByNotes: [],
      worktreePath: m.worktree,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'auto',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      needsHuman: needsHuman.has(i),
      owner: 'u-bench',
      visibility: 'personal',
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      createdBy: { actor: { kind: 'user', id: 'u-bench' }, onBehalfOf: 'u-bench' },
      parentId: m.parent === null ? undefined : idOf(m.parent),
      repoId: m.repo,
      deferUntil,
      sortKey: null,
      closedAt: m.closedAt,
      closedReason: m.closedReason,
      deletedAt: m.deletedAt,
      audience: m.audience,
    } as unknown as Record<string, unknown>
    if (drafts.has(i)) projection['isDraftVessel'] = true
    if (startedBy.has(i)) projection['startedBySession'] = startedBy.get(i)
    if (coordinator.has(i)) projection['coordinatorSessionId'] = coordinator.get(i)
    issues.push(wire as unknown as IssueViewModel)
    issueProjections.push(projection as unknown as IssueProjection)
  })
  const setWire = (i: number, key: string, value: unknown): void => {
    ;(issues[i] as unknown as Record<string, unknown>)[key] = value
  }

  // Pins (live: 21 pinned rows, 36 pinned issues). A pin keeps an issue in
  // view: no history epoch has one.
  for (const u of units) {
    if (u.part === 'history') continue
    const inUnit = (i: number): boolean => i >= u.first && i < u.end
    const pinnedRows = [
      ...allOf('topReview').filter(inUnit).slice(1, 9),
      ...allOf('mission')
        .filter((i) => inUnit(i) && !u.quietMissions.has(i))
        .slice(0, 3),
      ...allOf('topInProg').filter(inUnit).slice(0, 2),
      ...allOf('topPlanning').filter(inUnit).slice(0, 2),
      ...allOf('topClosed').filter(inUnit).slice(30, 35),
      ...allOf('topBacklog').filter(inUnit).slice(2, 3),
    ]
    const pinnedHidden = [
      ...allOf('humanDoneArch').filter(inUnit).slice(0, 10),
      ...allOf('humanDone').filter(inUnit).slice(0, 5),
    ]
    for (const i of [...pinnedRows, ...pinnedHidden]) setWire(i, 'pinned', true)
  }
  // Sibling sort keys (R-ORDER step 2; POD-4550 at POD-4547's request). The
  // legacy order puts keyed siblings before unkeyed ones and orders keyed
  // siblings by key; without keys it is creation order, newest first. Keys go
  // where they CHANGE that order. Siblings are rows the order compares
  // directly: children of one parent, and roots sharing a repo group. In
  // every such group of two or more rows the worklist can show, the OLDEST
  // row is keyed (it jumps ahead of newer unkeyed siblings); in groups of
  // three or more the second-oldest is keyed too, with a LATER key (keyed
  // order runs against creation order). Everything else stays unkeyed, so
  // keyed and unkeyed siblings mix. Every third active root is keyed as
  // well, for share.
  const setSortKey = (i: number, key: string): void => {
    setWire(i, 'sortKey', key)
    ;(issueProjections[i] as unknown as Record<string, unknown>)['sortKey'] = key
  }
  const siblingGroups = new Map<string, number[]>()
  mints.forEach((m, i) => {
    if (!VISIBLE_ROLES.has(m.role)) return
    const key = m.parent !== null ? `p:${m.parent}` : `repo:${m.repo}`
    const list = siblingGroups.get(key) ?? []
    list.push(i)
    siblingGroups.set(key, list)
  })
  const createdMs = (i: number): number => Date.parse(mints[i]!.createdAt)
  // Keys are minted by the model's own `spreadSortKeys`, so each passes
  // `isSortKey` exactly as a server-written key does (POD-4551): the two
  // sibling keys first (oldest, then second-oldest), then one per keyed root,
  // all ascending, so sibling keys sort ahead of root keys.
  const keyedRoots = [...allOf('mission'), ...allOf('topReview'), ...allOf('topInProg')].filter(
    (_, k) => k % 3 === 0,
  )
  const [siblingFirst, siblingSecond, ...rootKeys] = spreadSortKeys(2 + keyedRoots.length) as [
    string,
    string,
    ...string[],
  ]
  keyedRoots.forEach((root, j) => {
    setSortKey(root, rootKeys[j]!)
  })
  for (const group of siblingGroups.values()) {
    if (group.length < 2) continue
    const oldestFirst = [...group].sort((a, b) => createdMs(a) - createdMs(b))
    setSortKey(oldestFirst[0]!, siblingFirst)
    if (oldestFirst.length >= 3) setSortKey(oldestFirst[1]!, siblingSecond)
  }
  for (const u of units) {
    enter(units.indexOf(u))
    const closedTop = allOf('topClosed').filter((i) => i >= u.first && i < u.end)
    // Tucked closed rows (explicit dismissal into the closed fold), past the
    // grace window.
    for (const i of closedTop.slice(6, 14)) setWire(i, 'tuckedAt', ago(30 * MIN_MS, 5 * HOUR_MS))
    // Awaiting-merge rows: finished + unmerged delivery on a private branch.
    // Dual-written like the authority does (POD-4940): the app reads `branch`
    // off the projection spelling (`projectionOnLegacySpelling`) and
    // `gitState` off the wire (never persisted, serialization-only), so a
    // wire-only stamp is invisible to the oracle while the wire-first pool
    // sees it. `setSortKey` above is the same discipline.
    for (const i of closedTop.slice(14, 19)) {
      setWire(i, 'branch', `podium/merge-${i}`)
      ;(issueProjections[i] as unknown as Record<string, unknown>)['branch'] = `podium/merge-${i}`
      setWire(i, 'gitState', { shared: false, merged: false, ahead: 2 })
    }
  }
  // Read cursors: everything historical reads as read, after its last
  // session activity too (an unread finished child stays visible for 7 days,
  // visibility.ts:36, and hidden history must stay hidden); open issues read
  // within two days.
  const lastActivity = new Map<string, number>()
  for (const s of sessions) {
    const id = s['issueId']
    if (typeof id !== 'string') continue
    const at = Date.parse(s['lastActiveAt'] as string)
    if (at > (lastActivity.get(id) ?? 0)) lastActivity.set(id, at)
  }
  mints.forEach((m, i) => {
    enter(m.unit)
    if (!(m.closed || m.archived || m.deleted)) {
      setWire(i, 'readAt', ago(30 * MIN_MS, 2 * DAY_MS))
      return
    }
    const last = lastActivity.get(idOf(i)) ?? 0
    const updated = Date.parse(m.updatedAt)
    setWire(
      i,
      'readAt',
      !VISIBLE_ROLES.has(m.role) && last > updated ? iso(last + MIN_MS) : m.updatedAt,
    )
  })

  // -- unread rollups (same derivation the replica runs) -------------------------
  const typedSessions = sessions as unknown as SessionView[]
  const sessionInputs = typedSessions.map((s) => ({
    sessionId: s.sessionId,
    issueId: s.issueId,
    agentKind: s.agentKind,
    phase: s.agentState?.phase ?? null,
    lastActiveAt: s.lastActiveAt,
  }))
  const memberIndex = indexSessionsByIssue(sessionInputs as never)
  const sessionById = new Map(sessionInputs.map((s) => [s.sessionId, s] as const))
  issues.forEach((wire, i) => {
    const w = wire as unknown as Record<string, unknown>
    const rollups = deriveIssueRollups(
      {
        readAt: (w['readAt'] as string | null) ?? null,
        updatedAt: wire.updatedAt,
        deletedAt: (issueProjections[i] as unknown as { deletedAt?: string }).deletedAt,
      },
      (memberIndex.get(idOf(i) as never) ?? []) as never,
      ((id: unknown) => sessionById.get(id as never)) as never,
    )
    w['unread'] = rollups.unread
    w['sessionSummary'] = rollups.sessionSummary
  })

  // Every collection in id order (`issues[k].id === i<k>`).
  const inIdOrder = <T>(rows: T[]): T[] => {
    const out = new Array<T>(rows.length)
    rows.forEach((row, i) => {
      out[idNo[i]!] = row
    })
    return out
  }
  issues.splice(0, issues.length, ...inIdOrder(issues))
  issueProjections.splice(0, issueProjections.length, ...inIdOrder(issueProjections))

  // -- slice projections -------------------------------------------------------------
  const sliceIssues: SliceIssue[] = issues.map((wire) => {
    const w = wire as unknown as Record<string, unknown>
    return {
      id: wire.id,
      parentId: (w['parentId'] as string | undefined) ?? null,
      seq: wire.seq,
      createdAt: wire.createdAt,
      updatedAt: wire.updatedAt,
      closedAt: (w['closedAt'] as string | null) ?? null,
      deletedAt: (w['deletedAt'] as string | null) ?? null,
      archived: wire.archived,
      stage: wire.stage,
      closedReason: (w['closedReason'] as string | null) ?? null,
      audience: wire.audience,
      isDraftVessel: (w['isDraftVessel'] as boolean) ?? false,
      pinned: (w['pinned'] as boolean) ?? false,
      sortKey: (w['sortKey'] as string | null) ?? null,
      deferUntil: (w['deferUntil'] as string | null) ?? null,
      tuckedAt: (w['tuckedAt'] as string | null) ?? null,
      repoId: (w['repoId'] as string | null) ?? null,
      repoPath: wire.repoPath,
      worktreePath: (w['worktreePath'] as string | null) ?? null,
      coordinatorSessionId: (w['coordinatorSessionId'] as string | undefined) ?? null,
      startedBySession: (w['startedBySession'] as string | undefined) ?? null,
      deps: ((w['deps'] as Array<{ id: string; type: string }>) ?? []).map((d) => ({
        id: d.id,
        type: d.type,
      })),
      needsHuman: (w['needsHuman'] as boolean) ?? false,
      blocked: (w['blocked'] as boolean) ?? false,
      readAt: (w['readAt'] as string | null) ?? null,
      unread: (w['unread'] as boolean) ?? false,
      title: wire.title,
    }
  })
  const sliceSessions: SliceSession[] = typedSessions.map((s) => ({
    sessionId: s.sessionId,
    ...(s.issueId === undefined || s.issueId === null ? {} : { issueId: s.issueId }),
    cwd: s.cwd,
    agentKind: s.agentKind ?? null,
    headless: (s as { headless?: boolean }).headless ?? false,
    status: s.status ?? null,
    archived: s.archived ?? false,
    lastActiveAt: s.lastActiveAt,
    stoppedAt: s.stoppedAt ?? null,
    readAt: s.readAt ?? null,
    unread: s.unread ?? false,
    agentState: s.agentState
      ? {
          phase: s.agentState.phase ?? null,
          since: s.agentState.since,
          workingMsTotal: s.agentState.workingMsTotal,
        }
      : undefined,
    offer: s.offer ? { createdAt: s.offer.createdAt } : undefined,
    ...(s.resume ? { resume: { kind: s.resume.kind, value: s.resume.value } } : {}),
  }))

  // -- stats ----------------------------------------------------------------------------
  const depthHistogram: Record<string, number> = {}
  let maxDepth = 1
  mints.forEach((m) => {
    depthHistogram[String(m.depth)] = (depthHistogram[String(m.depth)] ?? 0) + 1
    if (m.depth > maxDepth) maxDepth = m.depth
  })
  const depsByType: Record<string, number> = {}
  for (const d of deps) depsByType[d.type] = (depsByType[d.type] ?? 0) + 1
  const stats: CorpusStats = {
    issues: issues.length,
    sessions: sessions.length,
    repos: repos.length,
    worktrees: sliceWorktrees.length,
    repoRows: repoProjections.length,
    rootLanes: repos.filter((r) => r.repoId !== undefined).length,
    withParent: mints.filter((m) => m.parent !== null).length,
    withOriginEdge: originOf.size,
    open: mints.filter((m) => !m.closed).length,
    depthHistogram,
    prefixOwnedSessions: typedSessions.filter((s) => s.issueId == null).length,
    maxDepth,
    resumeTwinGroups: resumeTwins.length,
    edgedAskers: edgedAskers.length,
    withStartedBySession: startedBy.size,
    withCoordinator: coordinator.size,
    depsByType,
    sessionsWithResume: typedSessions.filter((s) => s.resume != null).length,
  }
  const wantSessions = parts.reduce(
    (sum, part) => sum + (part === 'full' ? BASE_COUNTS.sessions : axisSessions![part]),
    0,
  )
  if (stats.issues !== parts.reduce((sum, part) => sum + unitIssues(part), 0))
    fail('issue count drift')
  if (stats.sessions !== wantSessions) fail('session count drift')
  if (stats.repos !== scanEntries(scale)) fail('repo count drift')
  if (stats.repoRows !== BASE_COUNTS.repoRows) fail('repo row drift')
  if (stats.worktrees !== BASE_COUNTS.worktrees * scale) fail('worktree count drift')

  return {
    seed,
    scale,
    cell,
    units: spans,
    fixedNow: FIXED_NOW,
    issues,
    issueProjections: issueProjections.map((projection, index) =>
      fixtureProjection(issues[index]!, projection),
    ),
    issueUserStates: fixtureMarkers(issues),
    issueGitStates: fixtureGitStates(issues),
    sessions: typedSessions,
    repoProjections: repoProjections.map((repo) => ({
      ...repo,
      repoPath: units[0]!.primaryRoot.get(repo.id) ?? '',
    })),
    issueDeps,
    repos,
    machines,
    pins: { panels: [], worktrees: [], repos: [] },
    sliceIssues: sliceIssues.map((issue, index) => ({
      ...issue,
      isDraftVessel: issues[index]?.isDraftVessel ?? false,
      intentOrigin: issues[index]?.intentOrigin,
      asked: issueProjections[index]?.asked,
    })),
    sliceSessions,
    sliceWorktrees,
    unscannedWorktree: {
      issueId: idOf(unscannedIdx),
      path: unscannedPath,
      sessionId: unscannedOrphan['sessionId'] as string,
    },
    resumeTwins,
    edgedAskers,
    stats,
  }
}
