/**
 * POD-4443 — deterministic live-shaped corpus at 1x, 2x and 4x.
 *
 * `buildCorpus(scale, seed)` returns 4,867 issues / 4,304 sessions / 500 repos /
 * 468 worktrees at 1x (all four multiplied by `scale`), shaped like the live
 * installation the budgets were measured on: a small visible set (~211 rows)
 * over a large historical bulk. See `README.md` and
 * `docs/measurements/POD-4441-fixture-shape.md`.
 *
 * Determinism: one mulberry32 stream per build, no `Math.random`, no
 * `Date.now()` — every timestamp derives from `FIXED_NOW`. Two builds with the
 * same `(scale, seed)` are deep-equal (proven by `corpus.test.ts`).
 */

import { deriveIssueRollups, indexSessionsByIssue } from '@podium/client-core/replica'
import type { PinState } from '@podium/client-core/viewmodels'
import type {
  GitRepositoryWire,
  IssueDepProjection,
  IssueProjection,
  IssueWire,
  MachineWire,
  RepoProjection,
  SessionMeta,
} from '@podium/model'
import type { SliceIssue, SliceSession, SliceWorktree } from '../../../shared/src/slice-types'

/** The corpus clock. Sits inside the defer band thresholds (spec §3 R-ORDER):
 *  `deferUntil` values are minted ±45 d around it, so bands 0/1/2 are all live.
 *  Kept far from the wall clock so `deriveIssueViews`' wall-clock `deferred`
 *  read (which the worklist does not consume) cannot flip under test. */
export const FIXED_NOW = Date.parse('2026-09-20T12:00:00Z')

const DAY_MS = 24 * 60 * 60 * 1000
const iso = (ms: number): string => new Date(ms).toISOString()

/** Base (1x) counts. 2x and 4x multiply all four. Machines stay at 6. */
export const BASE_COUNTS = {
  issues: 4867,
  sessions: 4304,
  repos: 500,
  worktrees: 468,
  machines: 6,
} as const

export type CorpusScale = 1 | 2 | 4

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
  repos: number
  worktrees: number
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

/** Everything the oracle and the row stream need, in both spellings. */
export interface FixtureCorpus {
  seed: number
  scale: CorpusScale
  fixedNow: number
  /** Legacy wire rows (`store.issues`, replica `issues` kind for `readAt`). */
  issues: IssueWire[]
  /** Normalized durable rows (replica `issueProjections` kind). */
  issueProjections: IssueProjection[]
  /** Session rows (`store.sessions`, replica `sessions` kind). */
  sessions: SessionMeta[]
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
// Role plan (1x counts; every line scales with `scale`)
// ---------------------------------------------------------------------------

type BulkKind =
  | 'vWork'
  | 'vChild'
  | 'vDoneChild'
  | 'vSessless'
  | 'vClosed'
  | 'vMerge'
  | 'rescueParent'
  | 'agentBacklog'
  | 'agentDone'
  | 'humanBacklog'
  | 'humanDone'
  | 'archived'
  | 'deleted'
  | 'proposed'
  | 'shipping'

const ROLE_COUNTS_1X: Array<{ role: BulkKind; count: number }> = [
  { role: 'vWork', count: 85 },
  { role: 'vChild', count: 55 },
  { role: 'vDoneChild', count: 120 },
  { role: 'vSessless', count: 40 },
  { role: 'vClosed', count: 16 },
  { role: 'vMerge', count: 5 },
  { role: 'rescueParent', count: 10 },
  { role: 'agentBacklog', count: 880 },
  { role: 'agentDone', count: 1600 },
  { role: 'humanBacklog', count: 800 },
  { role: 'humanDone', count: 766 },
  { role: 'archived', count: 150 },
  { role: 'deleted', count: 100 },
  { role: 'proposed', count: 190 },
  { role: 'shipping', count: 50 },
]

/** vClosed sub-segments per 16: grace-window (open lane) / tucked (folded) /
 *  abandoned (folds immediately). */
const VCLOSED_GRACE = 4
const VCLOSED_TUCKED = 8

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

interface Mint {
  role: BulkKind
  stage: string
  audience: 'human' | 'agent'
  archived: boolean
  deleted: boolean
  closed: boolean
  closedReason: string | null
  parent: number | null
  depth: number
}

function fail(message: string): never {
  throw new Error(`[fixture] ${message}`)
}

export function buildCorpus(scale: CorpusScale, seed = 4443): FixtureCorpus {
  if (scale !== 1 && scale !== 2 && scale !== 4) fail(`unsupported scale ${scale}`)
  const rng = mulberry32(seed * 1000 + scale)
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))
  const ago = (minMs: number, maxMs: number): string =>
    iso(FIXED_NOW - (minMs + rng() * (maxMs - minMs)))

  const issueTarget = BASE_COUNTS.issues * scale
  const sessionTarget = BASE_COUNTS.sessions * scale
  const repoTarget = BASE_COUNTS.repos * scale
  const worktreeTarget = BASE_COUNTS.worktrees * scale

  // -- roles -----------------------------------------------------------------
  const mints: Mint[] = []
  for (const { role, count } of ROLE_COUNTS_1X) {
    for (let k = 0; k < count * scale; k++) mints.push(baseMint(role))
  }
  if (mints.length !== issueTarget) fail(`role plan sums to ${mints.length}, want ${issueTarget}`)
  const n = mints.length
  const idOf = (i: number): string => `i${i}`
  const byRole = (role: BulkKind): number[] => {
    const out: number[] = []
    mints.forEach((m, i) => {
      if (m.role === role) out.push(i)
    })
    return out
  }
  const vWorkIdx = byRole('vWork')

  // -- stages ------------------------------------------------------------------
  // vWork: in_progress / planning / review + 2 backlog drafts.
  vWorkIdx.forEach((i, k) => {
    const m = mints[i]!
    if (k < 2 * scale) m.stage = 'backlog'
    else if (k < 17 * scale) m.stage = 'review'
    else if (k < 32 * scale) m.stage = 'planning'
    else m.stage = 'in_progress'
  })
  // vChild: mixed active stages (all visible via live sessions).
  byRole('vChild').forEach((i, k) => {
    const m = mints[i]!
    if (k < 10 * scale) m.stage = 'review'
    else if (k < 20 * scale) m.stage = 'planning'
    else if (k < 50 * scale) m.stage = 'in_progress'
    else m.stage = 'backlog'
  })
  // vSessless: active stages, never any sessions (queued phase cover).
  byRole('vSessless').forEach((i, k) => {
    const m = mints[i]!
    if (k < 5 * scale) m.stage = 'review'
    else if (k < 15 * scale) m.stage = 'planning'
    else m.stage = 'in_progress'
  })
  // vClosed sub-segments with matching close reasons.
  const abandoned = ['cancelled', 'cancelled', 'duplicate', 'superseded']
  byRole('vClosed').forEach((i, k) => {
    const m = mints[i]!
    if (k < VCLOSED_GRACE * scale) m.closedReason = 'done'
    else if (k < (VCLOSED_GRACE + VCLOSED_TUCKED) * scale) m.closedReason = 'done'
    else m.closedReason = abandoned[(k - (VCLOSED_GRACE + VCLOSED_TUCKED) * scale) % abandoned.length] as string
  })
  // archived: mostly done; deleted: mixed; proposed: mostly human.
  byRole('archived').forEach((i, k) => {
    const m = mints[i]!
    if (k < 130 * scale) {
      m.stage = 'done'
      m.closed = true
    }
  })
  byRole('deleted').forEach((i, k) => {
    const m = mints[i]!
    if (k < 60 * scale) {
      m.stage = 'done'
      m.closed = true
    }
  })
  byRole('proposed').forEach((i, k) => {
    if (k >= 150 * scale) mints[i]!.audience = 'agent'
  })

  // -- parents (depth 1-4, ~40% children) ---------------------------------------
  const rescueIdx = byRole('rescueParent')
  // Rescue: parent the first vWork roots under the rescue parents (1:1), so
  // the sessionless backlog parents materialize as rescue rows.
  vWorkIdx.slice(0, rescueIdx.length).forEach((wi, k) => {
    const parent = rescueIdx[k % rescueIdx.length] as number
    mints[wi]!.parent = parent
    mints[wi]!.depth = 2
  })
  // Visible children hang off vWork roots (round-robin with jitter).
  let childCursor = int(0, Math.max(0, vWorkIdx.length - 1))
  mints.forEach((m, i) => {
    if (m.role !== 'vChild' && m.role !== 'vDoneChild') return
    const parent = vWorkIdx[childCursor % vWorkIdx.length] as number
    childCursor += 1 + int(0, 3)
    m.parent = parent
    m.depth = Math.min(4, mints[parent]!.depth + 1)
  })
  // Bulk chaining: ~39% of the bulk gets an earlier, compatible parent.
  const bulkIdx: number[] = []
  mints.forEach((m, i) => {
    if (
      m.role === 'agentBacklog' ||
      m.role === 'agentDone' ||
      m.role === 'humanBacklog' ||
      m.role === 'humanDone' ||
      m.role === 'proposed' ||
      m.role === 'shipping' ||
      m.role === 'deleted' ||
      m.role === 'archived'
    )
      bulkIdx.push(i)
  })
  for (const i of bulkIdx) {
    if (rng() >= 0.435) continue
    const m = mints[i]!
    const agent = m.audience === 'agent'
    for (let attempt = 0; attempt < 12; attempt++) {
      const p = bulkIdx[int(0, bulkIdx.length - 1)] as number
      if (p >= i) continue
      const parent = mints[p]!
      if (parent.depth >= 4) continue
      if (agent && parent.audience !== 'agent' && rng() < 0.8) continue
      m.parent = p
      m.depth = parent.depth + 1
      break
    }
  }

  // -- repos / worktrees / machines ----------------------------------------------
  const wtPath = (k: number): string => {
    if (k === 10) return '/w/alpha'
    if (k === 11) return '/w/alpha-fork'
    if (k === 12) return '/w/beta'
    if (k === 13) return '/w/beta-fork'
    return `/w/${k}`
  }
  const noPrefixFrom = repoTarget - Math.max(1, Math.floor(repoTarget / 10))
  const repoProjections: RepoProjection[] = []
  const repos: GitRepositoryWire[] = []
  const wtByRepo: Array<string | null> = []
  for (let k = 0; k < repoTarget; k++) {
    const prefix = k < noPrefixFrom ? 'POD' : undefined
    repoProjections.push(
      prefix === undefined
        ? ({ id: `r${k}` }) as RepoProjection
        : ({ id: `r${k}`, prefix }) as RepoProjection,
    )
    const wt = k < worktreeTarget ? wtPath(k) : null
    wtByRepo.push(wt)
    repos.push({
      path: `/repo-${k}`,
      kind: 'repository',
      branch: 'main',
      worktrees: wt === null ? [] : [{ path: wt, branch: 'task' }],
      ...(k < 5 ? { machineId: 'm0' } : {}),
      repoId: `r${k}`,
    } as GitRepositoryWire)
  }

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

  // Worktree assignment: visible roots + agent-live + some agent bulk own one.
  // Invisible HUMAN issues never own a worktree, so R3 orphans can only join
  // rows that already exist (visible) or rows the nesting pass drops (agent).
  const issueWt: Array<string | null> = new Array(n).fill(null)
  let wtCursor = int(0, worktreeTarget - 1)
  const takeWt = (): number => {
    const k = wtCursor % worktreeTarget
    wtCursor++
    return k
  }
  mints.forEach((m, i) => {
    if (m.role === 'vWork') {
      const k = takeWt()
      issueWt[i] = wtByRepo[k]!
    }
  })
  mints.forEach((m, i) => {
    if (m.role === 'vChild') {
      if (rng() < 0.5 && m.parent !== null && issueWt[m.parent] !== null) {
        issueWt[i] = issueWt[m.parent] ?? null
      } else {
        issueWt[i] = wtByRepo[takeWt()]!
      }
    }
  })
  const agentLiveIdx: number[] = []
  mints.forEach((m, i) => {
    if (m.role === 'agentBacklog' && agentLiveIdx.length < 200 * scale && rng() < 0.25) {
      agentLiveIdx.push(i)
      issueWt[i] = wtByRepo[takeWt()]!
    }
  })
  mints.forEach((m, i) => {
    if (m.role === 'agentBacklog' || m.role === 'agentDone') {
      if (issueWt[i] === null && rng() < 0.12) issueWt[i] = wtByRepo[int(0, worktreeTarget - 1)]!
    }
  })

  // -- discovered-from edges (~5%) -------------------------------------------------
  const sessionBacked: number[] = [...vWorkIdx, ...agentLiveIdx]
  const originOf = new Map<number, number>()
  mints.forEach((m, i) => {
    if (m.archived || m.deleted) return
    if (rng() >= 0.057) return
    // Origins always have open sessions, so they never read as vacated and
    // their continuation stays null.
    const origin = pick(sessionBacked)
    if (origin === i) return
    originOf.set(i, origin)
  })
  const issueDeps: IssueDepProjection[] = []
  for (const [from, to] of originOf) {
    issueDeps.push({
      id: `d${from}`,
      fromId: idOf(from),
      toId: idOf(to),
      type: 'discovered-from',
    } as unknown as IssueDepProjection)
  }

  // -- issues ------------------------------------------------------------------------
  const repoOf: number[] = mints.map(() => int(0, repoTarget - 1))
  // One visible root intentionally sits on a prefix-less repo (`#seq` cover).
  if (vWorkIdx.length > 0) repoOf[vWorkIdx[0] as number] = repoTarget - 1
  // A few issues share repo r5 under a different path (group-merge cover).
  const altPathIdx = new Set<number>()
  mints.forEach((m, i) => {
    if (altPathIdx.size < 10 * scale && (m.role === 'agentBacklog' || m.role === 'humanBacklog')) {
      repoOf[i] = 5
      altPathIdx.add(i)
    }
  })

  const titleOf = (i: number, m: Mint): string => {
    if (m.role === 'vWork' && m.stage === 'backlog') return 'Draft'
    return `${pick(TITLE_VERBS)} ${pick(TITLE_NOUNS)} ${i}`
  }
  const deferOf = (m: Mint): string | null => {
    if (m.role !== 'vWork') return null
    const r = rng()
    if (r < 0.14) return iso(FIXED_NOW + 45 * DAY_MS + rng() * 10 * DAY_MS)
    if (r < 0.24) return iso(FIXED_NOW - 45 * DAY_MS - rng() * 10 * DAY_MS)
    if (r < 0.265) return 'next-message'
    return null
  }
  const deferCache = mints.map(deferOf)

  // vClosed recency plan: grace rows finished recently (open lane), tucked and
  // abandoned rows finished long ago (folded either way).
  const vClosedIdx = byRole('vClosed')
  const graceSet = new Set(vClosedIdx.slice(0, VCLOSED_GRACE * scale))

  const issues: IssueWire[] = []
  const issueProjections: IssueProjection[] = []
  mints.forEach((m, i) => {
    const repo = repoOf[i] as number
    const wt = issueWt[i]
    const origin = originOf.get(i)
    const title = titleOf(i, m)
    const createdAt = ago(20 * DAY_MS, 400 * DAY_MS)
    const recentFinish = m.role === 'vClosed' && graceSet.has(i)
    const updatedAt = m.closed
      ? recentFinish
        ? ago(1 * 60 * 60 * 1000, 20 * 60 * 60 * 1000)
        : ago(26 * 60 * 60 * 1000, 300 * DAY_MS)
      : m.role === 'vWork' || m.role === 'vChild'
        ? ago(5 * 60 * 1000, 3 * DAY_MS)
        : ago(1 * DAY_MS, 200 * DAY_MS)
    const closedAt = m.closed ? updatedAt : null
    const deletedAt = m.deleted ? ago(30 * DAY_MS, 200 * DAY_MS) : null
    const wire = {
      id: idOf(i),
      title,
      description: `Body ${i}`,
      seq: i + 1,
      stage: m.stage,
      parentBranch: 'main',
      blockedByNotes: [],
      deps: origin === undefined ? [] : [{ id: idOf(origin), type: 'discovered-from' }],
      dependents: [],
      ready: true,
      blocked: false,
      deferred: false,
      childCount: 0,
      childDoneCount: 0,
      createdAt,
      updatedAt,
      archived: m.archived,
      pinned: false,
      readAt: null,
      origin: 'human',
      audience: m.audience,
      draft: false,
      repoPath: altPathIdx.has(i) ? `/other-path-${repo}` : `/repo-${repo}`,
      repoId: rng() < 0.1 ? undefined : `r${repo}`,
      parentId: m.parent === null ? undefined : idOf(m.parent),
      closedAt,
      closedReason: m.closedReason,
      deferUntil: deferCache[i],
      tuckedAt: null,
      sortKey: null,
      worktreePath: wt,
      branch: null,
      needsHuman: false,
      priority: 2,
      type: 'task',
      labels: [],
    } as unknown as Record<string, unknown>
    if (deletedAt !== null) wire['deletedAt'] = deletedAt
    const projection = {
      id: idOf(i),
      seq: i + 1,
      title,
      description: { value: `Body ${i}` },
      stage: m.stage,
      archived: m.archived,
      priority: 2,
      type: 'task',
      labels: [],
      blockedByNotes: [],
      worktreePath: wt,
      branch: null,
      parentBranch: 'main',
      defaultAgent: 'auto',
      defaultModel: 'auto',
      defaultEffort: 'auto',
      needsHuman: false,
      owner: 'u-bench',
      visibility: 'personal',
      createdAt,
      updatedAt,
      createdBy: { actor: { kind: 'user', id: 'u-bench' }, onBehalfOf: 'u-bench' },
      parentId: m.parent === null ? undefined : idOf(m.parent),
      repoId: wire['repoId'],
      deferUntil: deferCache[i],
      sortKey: null,
      closedAt,
      closedReason: m.closedReason,
      deletedAt,
      audience: m.audience,
    } as unknown as Record<string, unknown>
    issues.push(wire as unknown as IssueWire)
    issueProjections.push(projection as unknown as IssueProjection)
  })

  // Role overlays: pins, drafts, sort keys, tucks, merge state, read cursors.
  for (const i of vWorkIdx.slice(0, 4 * scale)) {
    ;(issues[i] as unknown as Record<string, unknown>)['pinned'] = true
  }
  let pinnedClosed = 0
  mints.forEach((m, i) => {
    if (m.role === 'vClosed' && pinnedClosed < 2 * scale) {
      ;(issues[i] as unknown as Record<string, unknown>)['pinned'] = true
      pinnedClosed++
    }
  })
  let drafts = 0
  mints.forEach((m, i) => {
    if (m.role === 'vWork' && m.stage === 'backlog' && drafts < 2 * scale) {
      ;(issues[i] as unknown as Record<string, unknown>)['draft'] = true
      ;(issueProjections[i] as unknown as Record<string, unknown>)['draft'] = true
      drafts++
    }
  })
  // Sibling sort keys (R-ORDER step 2; POD-4550 at POD-4547's request). The
  // legacy order puts keyed siblings before unkeyed ones and orders keyed
  // siblings by key; without keys it is creation order, newest first. Keys go
  // where they CHANGE that order. Siblings are rows the order compares
  // directly: children of one parent, and roots sharing a repo group. In
  // every such group of two or more rows the worklist can show, the OLDEST
  // row is keyed (it jumps ahead of newer unkeyed siblings); in groups of
  // three or more the second-oldest is keyed too, with a LATER key (keyed
  // order runs against creation order). Everything else stays unkeyed, so
  // keyed and unkeyed siblings mix. Every third vWork root is keyed as well,
  // for share. Deterministic and rng-free: the rest of the corpus is
  // unchanged.
  const setSortKey = (i: number, key: string): void => {
    ;(issues[i] as unknown as Record<string, unknown>)['sortKey'] = key
    ;(issueProjections[i] as unknown as Record<string, unknown>)['sortKey'] = key
  }
  const showable = new Set<BulkKind>(['vWork', 'vChild', 'vSessless', 'vClosed', 'vMerge'])
  const siblingGroups = new Map<string, number[]>()
  mints.forEach((m, i) => {
    if (!showable.has(m.role)) return
    const wire = issues[i] as unknown as Record<string, unknown>
    const key =
      m.parent !== null ? `p:${m.parent}` : `repo:${String(wire['repoId'] ?? wire['repoPath'])}`
    const list = siblingGroups.get(key) ?? []
    list.push(i)
    siblingGroups.set(key, list)
  })
  const createdMs = (i: number): number => Date.parse(issues[i]!.createdAt)
  vWorkIdx.forEach((root, k) => {
    if (k % 3 === 0) setSortKey(root, `r${k}`)
  })
  for (const group of siblingGroups.values()) {
    if (group.length < 2) continue
    const oldestFirst = [...group].sort((a, b) => createdMs(a) - createdMs(b))
    setSortKey(oldestFirst[0]!, 'a0')
    if (oldestFirst.length >= 3) setSortKey(oldestFirst[1]!, 'a1')
  }
  // Tucked closed rows (explicit dismissal into the closed fold).
  let tucked = 0
  mints.forEach((m, i) => {
    if (
      m.role === 'vClosed' &&
      m.closedReason === 'done' &&
      !graceSet.has(i) &&
      tucked < VCLOSED_TUCKED * scale
    ) {
      ;(issues[i] as unknown as Record<string, unknown>)['tuckedAt'] = ago(
        30 * 60 * 1000,
        5 * 60 * 60 * 1000,
      )
      tucked++
    }
  })
  // Awaiting-merge rows: finished + unmerged delivery on a private branch.
  mints.forEach((m, i) => {
    if (m.role === 'vMerge') {
      const wire = issues[i] as unknown as Record<string, unknown>
      wire['branch'] = `podium/merge-${i}`
      wire['gitState'] = { shared: false, merged: false, ahead: 2 }
    }
  })
  // Read cursors: everything historical reads as read; live issues read too
  // except a budgeted few unread ones on visible rows.
  issues.forEach((wire, i) => {
    const m = mints[i]!
    const w = wire as unknown as Record<string, unknown>
    if (m.closed || m.archived || m.deleted) {
      w['readAt'] = wire.updatedAt as string
    } else {
      w['readAt'] = ago(30 * 60 * 1000, 2 * DAY_MS)
    }
  })

  // -- sessions ------------------------------------------------------------------------
  const sessions: SessionMeta[] = []
  const sessionIssueIds = new Set<string>()
  const liveOn = new Set<number>()
  const pushSession = (s: Record<string, unknown>): void => {
    sessions.push(s as unknown as SessionMeta)
    if (typeof s['issueId'] === 'string') sessionIssueIds.add(s['issueId'] as string)
  }
  const baseSession = (cwd: string): Record<string, unknown> => ({
    sessionId: `s${sessions.length}`,
    agentKind: rng() < 0.7 ? 'codex' : 'claude-code',
    title: `Session ${sessions.length}`,
    cwd,
    status: 'live',
    controllerId: `c${sessions.length}`,
    geometry: { cols: 80, rows: 24 },
    epoch: 1,
    clientCount: 1,
    createdAt: ago(10 * DAY_MS, 60 * DAY_MS),
    lastActiveAt: ago(60 * 1000, 30 * 60 * 1000),
    origin: { kind: 'spawn' },
    archived: false,
    readAt: ago(5 * 60 * 1000, 60 * 60 * 1000),
    unread: false,
  })
  const cwdFor = (issueIdx: number): string => {
    const wt = issueWt[issueIdx]
    if (wt !== null) return `${wt}/src`
    return `/repo-${repoOf[issueIdx] as number}`
  }
  const workingOn = (issueIdx: number, recent: boolean): void => {
    const activeAt = recent ? ago(30 * 1000, 25 * 60 * 1000) : ago(25 * 60 * 1000, 3 * 60 * 60 * 1000)
    pushSession({
      ...baseSession(cwdFor(issueIdx)),
      issueId: idOf(issueIdx),
      lastActiveAt: activeAt,
      readAt: iso(Date.parse(activeAt) + 5 * 60 * 1000),
      agentState: { phase: 'working', since: activeAt, nativeSubagentCount: 0 },
    })
    liveOn.add(issueIdx)
  }
  const waitingOn = (issueIdx: number): void => {
    const activeAt = ago(10 * 60 * 1000, 3 * 60 * 60 * 1000)
    pushSession({
      ...baseSession(cwdFor(issueIdx)),
      issueId: idOf(issueIdx),
      lastActiveAt: activeAt,
      readAt: iso(Date.parse(activeAt) + 5 * 60 * 1000),
      agentState: { phase: 'idle', since: activeAt, nativeSubagentCount: 0 },
      offer: {
        message: 'Review ready',
        actions: [{ label: 'Approve', prompt: 'approve' }],
        createdAt: activeAt,
      },
    })
    liveOn.add(issueIdx)
  }
  const queuedOn = (issueIdx: number): void => {
    const activeAt = ago(60 * 60 * 1000, 20 * 60 * 60 * 1000)
    pushSession({
      ...baseSession(cwdFor(issueIdx)),
      issueId: idOf(issueIdx),
      lastActiveAt: activeAt,
      readAt: iso(Date.parse(activeAt) + 5 * 60 * 1000),
    })
    liveOn.add(issueIdx)
  }
  const endedRetainedOn = (issueIdx: number): void => {
    const stoppedAt = ago(2 * 60 * 60 * 1000, 20 * 60 * 60 * 1000)
    pushSession({
      ...baseSession(cwdFor(issueIdx)),
      issueId: idOf(issueIdx),
      status: 'live',
      lastActiveAt: stoppedAt,
      stoppedAt,
      readAt: null,
      unread: true,
      agentState: { phase: 'ended', since: stoppedAt, nativeSubagentCount: 0 },
    })
    liveOn.add(issueIdx)
  }

  // Live sessions on the visible core.
  mints.forEach((m, i) => {
    if (m.role === 'vWork') {
      if (m.stage === 'review') {
        waitingOn(i)
        waitingOn(i)
      } else {
        workingOn(i, true)
        const r = rng()
        if (r < 0.4) waitingOn(i)
        else if (r < 0.7) queuedOn(i)
        else workingOn(i, false)
      }
    } else if (m.role === 'vChild') {
      workingOn(i, rng() < 0.6)
      if (rng() < 0.45) waitingOn(i)
    } else if (m.role === 'vMerge') {
      const stoppedAt = ago(2 * DAY_MS, 6 * DAY_MS)
      pushSession({
        ...baseSession(cwdFor(i)),
        issueId: idOf(i),
        status: 'exited',
        lastActiveAt: stoppedAt,
        stoppedAt,
        readAt: iso(Date.parse(stoppedAt) + 60 * 60 * 1000),
        agentState: { phase: 'ended', since: stoppedAt, nativeSubagentCount: 0 },
      })
    }
  })
  let retainedClosed = 0
  mints.forEach((m, i) => {
    if (m.role === 'vClosed' && retainedClosed < 4 * scale) {
      endedRetainedOn(i)
      retainedClosed++
    }
  })
  // Live sessions on agent issues (rows build, then the nesting pass drops them).
  for (const i of agentLiveIdx) {
    workingOn(i, rng() < 0.7)
    if (rng() < 0.3) waitingOn(i)
  }
  // Shell / headless / archived sessions (excluded from every membership).
  for (let k = 0; k < 12 * scale; k++) {
    const target = pick(vWorkIdx)
    pushSession({
      ...baseSession(`${issueWt[target] ?? `/repo-${repoOf[target] as number}`}/shell`),
      issueId: idOf(target),
      agentKind: 'shell',
      status: 'live',
    })
  }
  for (let k = 0; k < 6 * scale; k++) {
    pushSession({
      ...baseSession('/w/0/headless'),
      headless: true,
      status: 'live',
    })
  }
  for (let k = 0; k < 20 * scale; k++) {
    const stoppedAt = ago(40 * DAY_MS, 200 * DAY_MS)
    pushSession({
      ...baseSession(`/w/${k % worktreeTarget}/old`),
      status: 'exited',
      archived: true,
      lastActiveAt: stoppedAt,
      stoppedAt,
      readAt: iso(Date.parse(stoppedAt) + 60 * 60 * 1000),
      agentState: { phase: 'ended', since: stoppedAt, nativeSubagentCount: 0 },
    })
  }

  // R3 orphans: no issueId, cwd under a worktree. Live ones join visible or
  // agent rows; decayed ones resolve nowhere retained.
  const orphanTargets = [...vWorkIdx, ...agentLiveIdx]
  const liveOrphans = Math.floor(430 * scale * 0.21)
  for (let k = 0; k < liveOrphans; k++) {
    const target = pick(orphanTargets)
    const wt = issueWt[target] ?? wtByRepo[int(0, worktreeTarget - 1)]!
    const activeAt = ago(2 * 60 * 1000, 90 * 60 * 1000)
    const s: Record<string, unknown> = {
      ...baseSession(`${wt}/sub${k % 3 === 0 ? '/deep' : ''}`),
      lastActiveAt: activeAt,
      readAt: iso(Date.parse(activeAt) + 5 * 60 * 1000),
    }
    const kind = rng()
    if (kind < 0.55) s['agentState'] = { phase: 'working', since: activeAt, nativeSubagentCount: 0 }
    else if (kind < 0.8) {
      s['agentState'] = { phase: 'idle', since: activeAt, nativeSubagentCount: 0 }
      s['offer'] = { message: 'Needs input', actions: [], createdAt: activeAt }
    }
    pushSession(s)
  }
  // Decayed fill to the exact session target. First pass covers ~60% of open
  // bulk issues with one decayed session each; the rest lands on closed bulk.
  const openBulk: number[] = []
  const closedBulk: number[] = []
  mints.forEach((m, i) => {
    if (m.role === 'vSessless' || m.role === 'rescueParent') return
    if (m.role === 'vClosed' || m.role === 'vMerge') return
    if (sessionIssueIds.has(idOf(i))) return
    if (m.closed || m.archived || m.deleted) closedBulk.push(i)
    else openBulk.push(i)
  })
  const decayedOn = (issueIdx: number | null, cwd: string): void => {
    const stoppedAt = ago(8 * DAY_MS, 300 * DAY_MS)
    const s: Record<string, unknown> = {
      ...baseSession(cwd),
      status: 'exited',
      lastActiveAt: stoppedAt,
      stoppedAt,
      readAt: iso(Date.parse(stoppedAt) + 60 * 60 * 1000),
      agentState: { phase: 'ended', since: stoppedAt, nativeSubagentCount: 0 },
    }
    if (issueIdx === null) delete s['issueId']
    else {
      s['issueId'] = idOf(issueIdx)
      sessionIssueIds.add(idOf(issueIdx))
    }
    pushSession(s)
  }
  // Cover open bulk (~60% incl. the live-covered ones above).
  const openCoverTarget = Math.floor(openBulk.length * 0.62)
  let covered = 0
  let guard = 0
  while (covered < openCoverTarget && sessions.length < sessionTarget && guard < openCoverTarget * 20) {
    guard++
    const i = openBulk[int(0, openBulk.length - 1)] as number
    if (sessionIssueIds.has(idOf(i))) continue
    decayedOn(i, cwdFor(i))
    covered++
  }
  // Decayed orphans (~10% of sessions carry no issueId in the end).
  const orphanTotal = Math.floor(sessionTarget * 0.1)
  let orphanCount = sessions.filter((s) => s.issueId == null).length
  while (orphanCount < orphanTotal && sessions.length < sessionTarget) {
    const wt = wtByRepo[int(0, worktreeTarget - 1)]!
    decayedOn(null, `${wt}/archive`)
    orphanCount++
  }
  // Remainder onto closed bulk, round-robin.
  const remainderStart = sessions.length
  let closedCursor = 0
  while (sessions.length < sessionTarget) {
    if (closedBulk.length === 0) fail('no closed bulk to absorb decayed sessions')
    const i = closedBulk[closedCursor % closedBulk.length] as number
    closedCursor++
    decayedOn(i, cwdFor(i))
  }
  if (sessions.length !== sessionTarget) fail(`sessions ${sessions.length} != ${sessionTarget}`)

  // -- unscanned worktree (POD-4550, handover from POD-4546) ---------------------------
  // A live issue can name a worktree the discovery scan never reported (a
  // checkout on another machine, one made outside Podium, a scan that has not
  // run yet). Its path lives ONLY on `issue.worktreePath`: it is in no repo's
  // `worktrees` and no session's cwd equals it. A prefix relation that only
  // materialises worktrees the scan reached silently drops the sessions under
  // it. The case: the last sessionless visible root (so the seat is the ONLY
  // thing that can make it working) gets an unscanned path, and the first live
  // working orphan moves under it. Deterministic, and it draws nothing from
  // `rng`, so every other row is byte-identical to the corpus without it.
  const unscannedIdx = byRole('vSessless').at(-1)
  if (unscannedIdx === undefined) fail('no sessionless visible root for the unscanned worktree')
  const unscannedPath = `/w/unscanned-${idOf(unscannedIdx)}`
  issueWt[unscannedIdx] = unscannedPath
  ;(issues[unscannedIdx] as unknown as Record<string, unknown>)['worktreePath'] = unscannedPath
  ;(issueProjections[unscannedIdx] as unknown as Record<string, unknown>)['worktreePath'] = unscannedPath
  const unscannedOrphan = sessions.find(
    (s) =>
      s.issueId == null &&
      s.status === 'live' &&
      s.agentState?.phase === 'working' &&
      /\/sub(\/deep)?$/.test(s.cwd),
  )
  if (unscannedOrphan === undefined) fail('no live working orphan to seat under the unscanned worktree')
  ;(unscannedOrphan as unknown as Record<string, unknown>)['cwd'] = `${unscannedPath}/sub`

  // -- hidden askers and resume twins (POD-4551) ----------------------------------
  // Both shapes reuse rows the corpus already has instead of minting new ones,
  // so every count stays exact, and they draw nothing from `rng`, so every row
  // they do not touch is byte-identical to the corpus without them. Sessions
  // come from the tail of the closed-bulk remainder (decayed, invisible rows
  // on closed issues); the roots are sessionless visible roots (active human
  // stage, no sessions, no children, no worktree), so each shape alone decides
  // what its root's row shows.
  const donors = sessions.slice(remainderStart).reverse()
  const takeDonor = (): Record<string, unknown> => {
    const donor = donors.shift()
    if (donor === undefined) fail('closed-bulk remainder too small for the POD-4551 shapes')
    return donor as unknown as Record<string, unknown>
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
    s['cwd'] = cwdFor(issueIdx)
    s['status'] = fields.status
    s['archived'] = false
    s['lastActiveAt'] = activeAt
    s['readAt'] = iso(FIXED_NOW - fields.activeAgoMs + 5 * 60 * 1000)
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
  const sessionlessRoots = byRole('vSessless').filter(
    (i) => i !== unscannedIdx && mints[i]!.stage !== 'review',
  )
  const HOUR_MS = 60 * 60 * 1000

  // Hidden askers (the L1d shape, POD-4549): an asking session on an archived
  // or proposed child of a visible root. The legacy flat pass skips hidden
  // issues (rows.ts:63-69) and the worktree lanes suppress their sessions
  // (rows.ts:201-210), so the ask detaches: the root must NOT read asking. A
  // pool that bubbles through the formal subtree turns the root amber.
  const hasChild = new Set(mints.flatMap((m) => (m.parent === null ? [] : [m.parent])))
  // Open leaves only (a closed child's offer no longer asks, motionPhase), with
  // no origin edge and no worktree; an archived leaf may leave a bulk parent
  // (it is a leaf, so only its own depth moves). Archived and proposed
  // alternate until the scarcer runs out.
  const hiddenLeaf = (m: Mint, i: number): boolean =>
    !hasChild.has(i) && !originOf.has(i) && issueWt[i] === null && !m.closed
  const archivedLeaves = byRole('archived').filter((i) => hiddenLeaf(mints[i]!, i))
  const proposedLeaves = byRole('proposed').filter((i) => hiddenLeaf(mints[i]!, i) && mints[i]!.parent === null)
  const ASKERS_1X = 20
  const edgedAskers: EdgedAsker[] = []
  for (let k = 0; k < ASKERS_1X * scale; k++) {
    const pool = k % 2 === 0 && archivedLeaves.length > 0 ? archivedLeaves : proposedLeaves
    const child = pool.shift()
    const root = sessionlessRoots[k]
    if (child === undefined || root === undefined) fail('not enough hidden leaves or roots for the askers')
    mints[child]!.parent = root
    mints[child]!.depth = mints[root]!.depth + 1
    ;(issues[child] as unknown as Record<string, unknown>)['parentId'] = idOf(root)
    ;(issueProjections[child] as unknown as Record<string, unknown>)['parentId'] = idOf(root)
    const sessionId = reseat(child, { status: 'live', activeAgoMs: 20 * 60 * 1000 + k * 60 * 1000, phase: 'idle', offer: true })
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
  for (let k = 0; k < scale; k++) {
    const kinds: ResumeTwinKind[] = ['inactive', 'tie', 'live']
    kinds.forEach((kind, g) => {
      const root = sessionlessRoots[ASKERS_1X * scale + 3 * k + g]
      if (root === undefined) fail('not enough sessionless roots for the resume twins')
      const ref = { kind: 'codex-thread', value: `thread-twin-${kind}-${k}` }
      const ask = reseat(root, { status: 'hibernated', activeAgoMs: 6 * HOUR_MS, phase: 'idle', offer: true, resume: ref })
      const other =
        kind === 'inactive'
          ? reseat(root, { status: 'exited', activeAgoMs: 3 * HOUR_MS, phase: 'ended', stoppedAgoMs: 3 * HOUR_MS, resume: ref })
          : kind === 'tie'
            ? reseat(root, { status: 'hibernated', activeAgoMs: 2 * HOUR_MS, phase: 'idle', resume: ref })
            : reseat(root, { status: 'live', activeAgoMs: 60 * 1000, phase: 'working', resume: ref })
      resumeTwins.push({
        kind,
        issueId: idOf(root),
        ref,
        sessionIds: [ask, other],
        keptSessionIds: kind === 'live' ? [ask, other] : kind === 'inactive' ? [ask] : [other],
      })
    })
  }

  // -- unread rollups (same derivation the replica runs) -------------------------
  const sessionInputs = sessions.map((s) => ({
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

  // -- slice projections -------------------------------------------------------------
  const prefixByRepo = new Map<string, string | null>(
    repoProjections.map((r) => [r.id, (r as { prefix?: string }).prefix ?? null]),
  )
  const sliceIssues: SliceIssue[] = issues.map((wire, i) => {
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
      draft: (w['draft'] as boolean) ?? false,
      pinned: (w['pinned'] as boolean) ?? false,
      sortKey: (w['sortKey'] as string | null) ?? null,
      deferUntil: (w['deferUntil'] as string | null) ?? null,
      tuckedAt: (w['tuckedAt'] as string | null) ?? null,
      repoId: (w['repoId'] as string | null) ?? null,
      repoPath: wire.repoPath,
      worktreePath: (w['worktreePath'] as string | null) ?? null,
      coordinatorSessionId: null,
      startedBySession: null,
      deps: ((w['deps'] as Array<{ id: string; type: string }>) ?? []).map((d) => ({
        id: d.id,
        type: d.type,
      })),
      needsHuman: false,
      blocked: false,
      readAt: (w['readAt'] as string | null) ?? null,
      unread: (w['unread'] as boolean) ?? false,
      title: wire.title,
    }
  })
  const sliceSessions: SliceSession[] = sessions.map((s) => ({
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
  const sliceWorktrees: SliceWorktree[] = []
  wtByRepo.forEach((wt, k) => {
    if (wt === null) return
    sliceWorktrees.push({
      path: wt,
      repoId: `r${k}`,
      repoPath: `/repo-${k}`,
      repoName: `repo-${k}`,
      prefix: prefixByRepo.get(`r${k}`) ?? null,
    })
  })

  // -- stats ----------------------------------------------------------------------------
  const depthHistogram: Record<string, number> = {}
  let maxDepth = 1
  mints.forEach((m) => {
    depthHistogram[String(m.depth)] = (depthHistogram[String(m.depth)] ?? 0) + 1
    if (m.depth > maxDepth) maxDepth = m.depth
  })
  const stats: CorpusStats = {
    issues: issues.length,
    sessions: sessions.length,
    repos: repos.length,
    worktrees: sliceWorktrees.length,
    withParent: mints.filter((m) => m.parent !== null).length,
    withOriginEdge: originOf.size,
    open: mints.filter((m) => !m.closed).length,
    depthHistogram,
    prefixOwnedSessions: sessions.filter((s) => s.issueId == null).length,
    maxDepth,
    resumeTwinGroups: resumeTwins.length,
    edgedAskers: edgedAskers.length,
  }
  if (stats.issues !== issueTarget) fail('issue count drift')
  if (stats.repos !== repoTarget) fail('repo count drift')
  if (stats.worktrees !== worktreeTarget) fail('worktree count drift')

  return {
    seed,
    scale,
    fixedNow: FIXED_NOW,
    issues,
    issueProjections,
    sessions,
    repoProjections,
    issueDeps,
    repos,
    machines,
    pins: { panels: [], worktrees: [], repos: [] },
    sliceIssues,
    sliceSessions,
    sliceWorktrees,
    unscannedWorktree: {
      issueId: idOf(unscannedIdx),
      path: unscannedPath,
      sessionId: unscannedOrphan.sessionId,
    },
    resumeTwins,
    edgedAskers,
    stats,
  }
}

function baseMint(role: BulkKind): Mint {
  switch (role) {
    case 'vWork':
      return { role, stage: 'in_progress', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'vChild':
      return { role, stage: 'in_progress', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 2 }
    case 'vDoneChild':
      return { role, stage: 'done', audience: 'human', archived: false, deleted: false, closed: true, closedReason: null, parent: null, depth: 2 }
    case 'vSessless':
      return { role, stage: 'in_progress', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'vClosed':
      return { role, stage: 'done', audience: 'human', archived: false, deleted: false, closed: true, closedReason: 'done', parent: null, depth: 1 }
    case 'vMerge':
      return { role, stage: 'done', audience: 'human', archived: false, deleted: false, closed: true, closedReason: 'done', parent: null, depth: 1 }
    case 'rescueParent':
      return { role, stage: 'backlog', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'agentBacklog':
      return { role, stage: 'backlog', audience: 'agent', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'agentDone':
      return { role, stage: 'done', audience: 'agent', archived: false, deleted: false, closed: true, closedReason: null, parent: null, depth: 1 }
    case 'humanBacklog':
      return { role, stage: 'backlog', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'humanDone':
      return { role, stage: 'done', audience: 'human', archived: false, deleted: false, closed: true, closedReason: null, parent: null, depth: 1 }
    case 'archived':
      return { role, stage: 'backlog', audience: 'human', archived: true, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'deleted':
      return { role, stage: 'backlog', audience: 'human', archived: false, deleted: true, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'proposed':
      return { role, stage: 'proposed', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
    case 'shipping':
      return { role, stage: 'shipping', audience: 'human', archived: false, deleted: false, closed: false, closedReason: null, parent: null, depth: 1 }
  }
}
