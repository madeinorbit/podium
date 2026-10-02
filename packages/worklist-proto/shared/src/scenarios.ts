import { allIssueViewModels } from '@podium/client-core/replica'
import type { IssueViewModel } from '@podium/client-core/replica'
import { fixtureMarkers, fixtureGitStates, fixtureProjection } from '../../harness/src/fixture/normalized-issues'
/**
 * POD-4444 / POD-4550 — the scenario replay library (methodology §5.8), over
 * the ONE corpus.
 *
 * Every arm replays the SAME scenarios against the SAME row-source input, so
 * arms never diff collections and never read the kernel themselves. Each
 * scenario boots a kernel over the live-shaped fixture (`buildCorpus(scale,
 * seed)`: 4,867 issues / 4,304 sessions / 211 visible rows at 1x) —
 * `ScenarioCache` + `createKernelReplica` + `ClientRuntime` with a stubbed
 * hub/transport — primes a `createRowSource` over it, performs ONE write, and
 * returns `{events, before, after, targets}`:
 *
 * - `events` — the `RowSourceEvent`s the write published (the arm input).
 * - `before` / `after` — the oracle's delta surface: the folded snapshot rows
 *   the legacy derivation projects.
 * - `targets` — the rows the writes aimed at, chosen BY RULE from the corpus
 *   (`pickTargets`), so parity checks and the browser driver hit the same
 *   rows the count runs hit.
 *
 * ONE INPUT (POD-4550). The writes (`writeHeartbeat`, `writeTitleRename`, …)
 * live here and ARE the scenarios: a scenario function is "boot, run one
 * write under a row source". Engine-backed count runs boot one engine with
 * `startScenarioEngine` and call the same writes. There is no second corpus
 * and no second copy of any write.
 *
 * SCENARIO → METHODOLOGY MAP (§5.8; #14 growth and #15 coexistence belong to
 * the count harness, not here):
 *
 * | fn | methodology | rows committed (arm) | row-source events asserted |
 * |---|---|---|---|
 * | unrelatedHeartbeat | #1 | 0 | 1 update, 1 row |
 * | visibleSessionPhaseChange | #2 | 1 + ancestors | 1 update, 1 row |
 * | selectionClick | #3 | 2 (latch) | 1 update, 1 row (eager mark-read; finding) |
 * | visibleTitleRename | #4 | 1 | 1 update, 1 row |
 * | stageMoveAcrossGroups | #5 | affected + order | 1 update, 1 row |
 * | newIssue | #6a | order + row | 1 update, 2 rows |
 * | archiveIssue | #6b | order + row | 1 update, 1 row |
 * | evictWithoutRevision | #6c | order + row | 1 update, 1 row gone |
 * | evictKeeperWithoutRevision | #6d | rescue parent + row | 1 update, 1 row gone |
 * | parentReassignment | #7 | both chains | 1 update, 1 row |
 * | clockTick | #8 | bands | 0 (time is a local) |
 * | optimisticEchoAndRejection | #9 | as #2 | press, echo, press, rollback |
 * | burst50 | #10 | bounded | 1 update, 50 rows |
 * | principalSwitch | #11 | full once | 1 replace, full (kernel install) |
 * | coldBootstrap | #12 | full once | 1 update, discovery lanes only; arms snapshot (finding) |
 * | rescopeGrowth | #13 | full each | 2 replaces |
 *
 * DUAL-WRITE. Issue writes update wire AND projection rows together, as the
 * authority does during the normalized migration: a projection change always
 * arrives with its wire change in the same batch and dedupes to one `issue`
 * row (see `row-source.ts`).
 *
 * EVICT. `evictWithoutRevision` drops the rows from the cache and fires
 * `evicted` (not `removed`): an authority snapshot omitting the row. Evict
 * and delete look the same to the arm (row gone) and that is intended
 * (spec §2).
 *
 * KEEPER EVICT (POD-4503). `#6c` evicts a root that keeps nothing, so a
 * missing keeper-seat cleanup stays parity-green there. `#6d` evicts the only
 * child of one of the fixture's rescue parents (a sessionless `backlog`
 * parent kept visible only by that child): the oracle drops the parent with
 * it, and an arm that forgot the keeper-seat cleanup keeps a ghost parent and
 * fails parity. The fixture carries these pairs itself; nothing is seeded.
 *
 * CLOCK. The runtime's coarse clock is pinned to the corpus clock
 * (`FIXED_NOW`, inside every band threshold) through the runtime's
 * `coarseClock` seam, and `clockTick` advances it THROUGH THE ENGINE: the
 * `after` snapshot's `coarseNow` is what the runtime published, never a
 * number synthesised here. Every timestamp a write mints comes from the same
 * clock (`ctx.stamp()`), so a wall-clock date never lands in a row.
 *
 * SELECTION is a local (`SliceLocals`), never a row. `selectionClick` drives
 * the real `setSelectedIssueId` publication.
 *
 * PRINCIPAL SWITCH disposes the runtime AND the row source; a new runtime
 * over a FRESH replica bootstraps exactly once. The old source is asserted
 * silent afterwards.
 */

import type { EntityRecord } from '@podium/sync/replica'
import type { PodiumClientApi } from '@podium/client-core/api'
import { type CoarseClock, createClientRuntime, openKernelEngineOutbox } from '@podium/client-core/engine'
import type { OnlineEvents } from '@podium/client-core/outbox'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  memoryStorage,
  type KernelCacheRead,
  type KernelEntity,
} from '@podium/client-core/replica'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RouterWindow } from '@podium/client-core/ui-state'
import { asIssueId, asUserId, issueUserStateRowId, type SessionMeta } from '@podium/model'
import { InMemoryOutboxStore } from '@podium/sync/outbox'
import { buildCorpus, type CorpusScale, type FixtureCorpus } from '../../harness/src/fixture/index'
import { createRowSource } from '@podium/client-graph/shared/row-source'
import type { RowSourceEvent } from './stats'

// ------------------------------------------------------------------ corpus

/** Fixture scale: 1x is the live installation, 2x/4x the growth slope. */
export type FixtureScale = CorpusScale

/** The seed every count, parity check and browser page uses unless a test
 *  deliberately varies it. */
export const FIXTURE_SEED = 4443

// ------------------------------------------------------------- kernel fake

const keyOf = (entity: string, entityId: string): string => `${entity}:${entityId}`

/** The kernel cache the scenario replica reads. Keyed by `entity:id`, so
 *  every read and write is O(1); `records` is materialised on demand and
 *  cached until the next write. */
export class ScenarioCache implements KernelCacheRead {
  private readonly byKey = new Map<string, EntityRecord>()
  private materialised: EntityRecord[] | null = null

  get records(): EntityRecord[] {
    this.materialised ??= [...this.byKey.values()]
    return this.materialised
  }
  readCursor() {
    return null
  }
  readEntities(): readonly EntityRecord[] {
    return this.records
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.byKey.get(keyOf(entity, entityId))
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: KernelEntity, entityId: string, value: unknown): void {
    const key = keyOf(entity, entityId)
    // Re-insert at the end, like an upsert into an append log.
    this.byKey.delete(key)
    this.byKey.set(key, { entity, entityId, value, provenance: { seq: 1 } })
    this.materialised = null
  }
  /** Bulk install for seeding. Entities are the kernel's names (`repo`, not
   *  the kind `repos`): an unmapped name is dropped silently (POD-4624). */
  install(rows: { entity: KernelEntity; entityId: string; value: unknown }[]): void {
    for (const row of rows) {
      this.byKey.set(keyOf(row.entity, row.entityId), {
        entity: row.entity,
        entityId: row.entityId,
        value: row.value,
        provenance: { seq: 1 },
      })
    }
    this.materialised = null
  }
  drop(entity: KernelEntity, entityId: string): void {
    if (this.byKey.delete(keyOf(entity, entityId))) this.materialised = null
  }
}

/** Install the fixture rows as kernel entities, in bulk: the fixture's own
 *  objects, or (POD-4747 `ownRows`) a copy of each, as a kernel reading its
 *  disk holds. */
export function seedCacheFromCorpus(
  corpus: FixtureCorpus,
  options: { ownRows?: boolean } = {},
): ScenarioCache {
  const cache = new ScenarioCache()
  const own = <T>(value: T): T => (options.ownRows === true ? structuredClone(value) : value)
  const rows: { entity: KernelEntity; entityId: string; value: unknown }[] = []
  for (const projection of corpus.issueProjections)
    rows.push({ entity: 'issueProjection', entityId: projection.id, value: own(projection) })
  for (const state of corpus.issueUserStates ?? fixtureMarkers(corpus.issues))
    rows.push({ entity: 'issueUserState', entityId: issueUserStateRowId(state.userId, state.entityId), value: own(state) })
  for (const git of corpus.issueGitStates ?? fixtureGitStates(corpus.issues))
    rows.push({ entity: 'issueGitState', entityId: git.id, value: own(git) })
  for (const session of corpus.sessions)
    rows.push({ entity: 'session', entityId: session.sessionId, value: own(session) })
  for (const repo of corpus.repoProjections)
    rows.push({ entity: 'repo', entityId: repo.id, value: own(repo) })
  for (const dep of corpus.issueDeps)
    rows.push({ entity: 'issueDep', entityId: dep.id, value: own(dep) })
  cache.install(rows)
  return cache
}

class FakeHub {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
  /** A server push, delivered to whatever the runtime subscribed (POD-4555:
   *  `worktreesChanged` drives the runtime's own discovery refresh). */
  emit(kind: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(kind) ?? []) cb(...args)
  }
  on(kind: string, cb: (...a: unknown[]) => void): () => void {
    let set = this.handlers.get(kind)
    if (!set) {
      set = new Set()
      this.handlers.set(kind, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }
  connectionHealth() {
    return { status: 'down' as const, rttMs: null, since: 0 }
  }
  seedMetadata(): void {}
  connect(): void {}
  connectNow(): void {}
  dispose(): void {}
  setVisible(): void {}
  setViewState(): void {}
  sendSessionDraft(): void {}
  sendDraftEdit(): boolean {
    return true
  }
}

function fakeRouterWindow(): RouterWindow {
  const listeners = new Set<() => void>()
  return {
    location: { pathname: '/', search: '' },
    history: { pushState: () => {}, replaceState: () => {} },
    addEventListener: (_t: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_t: string, cb: () => void) => listeners.delete(cb),
  } as unknown as RouterWindow
}

/**
 * POD-4555 — the server's answers to the slice's write commands. Each gets
 * the exact tRPC input the kernel outbox sent (patch plus `mutationId`), so a
 * scripted server can hold the call, answer it later, refuse it, or fail it
 * transiently. Absent: applied at once (mark-read still honours
 * `rejectNextMarkRead`).
 */
export interface ScenarioServer {
  issueUpdate?: (input: { id: string; patch: Record<string, unknown>; mutationId: string }) => Promise<unknown>
  issueMarkRead?: (input: { id: string; mutationId: string }) => Promise<unknown>
}

// biome-ignore lint/suspicious/noExplicitAny: scenario API stub — shaped per-test like engine runtime.test.ts
function scenarioApi(
  discovery: { repos: unknown[] },
  opts: {
    rejectMarkRead?: () => boolean
    server?: ScenarioServer
    /** The server acknowledged a mark-read of this issue (its receipt). */
    markReadAcknowledged?: (id: string) => void
  } = {},
): any {
  return {
    sync: {
      changesSince: {
        query: async () => ({
          kind: 'snapshot',
          sessions: [],
          issues: [],
          conversations: [],
          diagnostics: [],
          cursor: 0,
        }),
      },
    },
    discovery: {
      refreshRepos: {
        mutate: async () => ({ repositories: discovery.repos, diagnostics: [], machines: [] }),
      },
    },
    pins: { list: { query: async () => ({ panels: [], worktrees: [], repos: [] }) } },
    tabs: { listOrders: { query: async () => ({}) } },
    settings: {
      get: {
        query: async () => ({ sidebar: { repoSort: 'lastUsed', repoOrder: [] } }),
      },
    },
    superagent: { listThreads: { query: async () => [] } },
    sessions: { markRead: { mutate: async () => ({}) } },
    issues: {
      update: {
        mutate: async (input: Parameters<NonNullable<ScenarioServer['issueUpdate']>>[0]) =>
          opts.server?.issueUpdate ? opts.server.issueUpdate(input) : {},
      },
      markRead: {
        mutate: async (input: Parameters<NonNullable<ScenarioServer['issueMarkRead']>>[0]) => {
          if (opts.server?.issueMarkRead) {
            const answer = await opts.server.issueMarkRead(input)
            opts.markReadAcknowledged?.(input.id)
            return answer
          }
          if (opts.rejectMarkRead?.()) {
            throw Object.assign(new Error('scenario rejection'), {
              data: { code: 'BAD_REQUEST', httpStatus: 400 },
            })
          }
          opts.markReadAcknowledged?.(input.id)
          return {}
        },
      },
    },
  }
}

/** A coarse clock the scenario drives by hand: pinned at `start`, advanced
 *  only by `advance`, which publishes through the runtime's own tick path. */
interface ManualClock extends CoarseClock {
  advance(ms: number): void
}

function manualClock(start: number): ManualClock {
  let now = start
  const ticks = new Set<(now: number) => void>()
  return {
    now: () => now,
    subscribe: (tick) => {
      ticks.add(tick)
      return () => ticks.delete(tick)
    },
    advance: (ms) => {
      now += ms
      for (const tick of ticks) tick(now)
    },
  }
}

// ----------------------------------------------------------------- targets

/** The rows the scenario writes aim at, chosen by rule from the corpus.
 *  Scenario results carry them so parity checks and the browser driver use
 *  the same rows. */
export interface ScenarioTargets {
  /** #1: a session bound to a closed agent root (a row the worklist never
   *  shows) that no issue names as its spin-off origin, so no visible row
   *  reads it (POD-4635: origins are common on the live-shaped fixture) —
   *  its heartbeat must move no visible row. */
  heartbeatSessionId: string
  /** #2/#3/#4, #9 supplement: an open human root with children whose ONLY
   *  working session is one bound live session — no other session working
   *  anywhere in its subtree, bound or seated by prefix (a row reads working
   *  if any descendant does) — so #2
   *  (that session going idle) flips the row's `working` at every scale and
   *  cross-scale counts compare the same workload. Its family (the sessions
   *  bound to it) is larger than one level of the #2 reads budget
   *  ({@link PHASE_FAMILY_FLOOR}), so a pool that re-reads the family on a
   *  phase change fails the fence (POD-4635, from Ma4 POD-4568). */
  visibleRootId: string
  /** #2: that root's first live working session. */
  phaseSessionId: string
  /** #5: a childless open root; done + tucked moves it from the open lane
   *  into the closed fold. */
  stageMoveId: string
  /** #6b: another childless open root. */
  archiveId: string
  /** #6c: another childless open root; keeps nothing. */
  evictId: string
  /** #6d: the only child of a rescue parent, itself childless. */
  keeperLeafId: string
  /** #6d: that rescue parent (sessionless `backlog`, visible only through
   *  the leaf). */
  keeperParentId: string
  /** #7: a visible child moved from its parent to `reparentToId`. */
  reparentId: string
  reparentToId: string
  /** #9: a childless open root whose read cursor is pressed. */
  markReadId: string
  /** #10: the 50 issues the burst's sessions bind to. */
  burstIssueIds: string[]
  /** #6a: repo the new issue lands in. */
  newIssueRepo: { repoId: string; repoPath: string }
}

const ACTIVE_STAGES = new Set(['in_progress', 'planning', 'review'])

interface IssueFacts {
  id: string
  parentId?: string | null
  stage: string
  archived: boolean
  audience?: string
  closedAt?: string | null
  deletedAt?: string | null
  pinned?: boolean
  draft?: boolean
}

const numericId = (id: string): number => Number(id.slice(1))

/** An open human issue: the population every row target is drawn from. */
/**
 * The #2 reads budget per chain level (`READ_BUDGETS.phaseChangePerLevel` in
 * `harness/src/count-harness.tsx`; `scenarios.test.ts` holds the two equal).
 * The #2 target's family must be LARGER than this: on a family of exactly
 * the budget, re-reading every sibling on a phase change costs the budget
 * and passes (Ma4, POD-4568), so the fence could not catch it.
 */
export const PHASE_FAMILY_FLOOR = 3

function isOpenHuman(i: IssueFacts): boolean {
  return (
    i.audience === 'human' &&
    !i.archived &&
    !i.deletedAt &&
    !i.closedAt &&
    !i.draft &&
    ACTIVE_STAGES.has(i.stage)
  )
}

/** Parents in the corpus (issues some other issue names as its parent). */
function parentIds(issues: readonly IssueFacts[]): Set<string> {
  const parents = new Set<string>()
  for (const issue of issues) if (issue.parentId) parents.add(issue.parentId)
  return parents
}

/**
 * The target rules as predicates over issue ids, ONE definition for every
 * caller: `pickTargets` below, and the browser page (POD-4558/POD-4559), which
 * picks among rows drawn on screen rather than the whole corpus. The page
 * and the engine must pick identical targets, so neither restates a rule.
 * `openRootWithChildren` is the rename's rule; `phaseRoot` is the same rule
 * plus #2's session condition (a drawn row need not be the #2 row).
 */
export function targetRules(corpus: FixtureCorpus): {
  root: (id: string) => boolean
  openRootWithChildren: (id: string) => boolean
  childlessRoot: (id: string) => boolean
  phaseRoot: (id: string) => boolean
  /** The live working session a #2 target's phase change flips. */
  phaseSession: (id: string) => SessionMeta | undefined
  /** The visible heartbeat's session on a drawn row (POD-4560): the row's
   *  lowest-numbered bound session, headless excepted. Its `lastActiveAt` is
   *  the row's recency anchor (`activityAt`), so bumping it redraws the row. */
  heartbeatSession: (id: string) => SessionMeta | undefined
} {
  const issues = corpus.issues as unknown as IssueFacts[]
  const byId = new Map(issues.map((i) => [i.id, i]))
  const parents = parentIds(issues)
  const children = new Map<string, string[]>()
  for (const issue of issues) {
    if (!issue.parentId) continue
    const list = children.get(issue.parentId) ?? []
    list.push(issue.id)
    children.set(issue.parentId, list)
  }
  const sessionsOf = new Map<string, SessionMeta[]>()
  for (const s of corpus.sessions) {
    if (!s.issueId) continue
    const list = sessionsOf.get(s.issueId) ?? []
    list.push(s)
    sessionsOf.set(s.issueId, list)
  }
  const isLiveWorking = (s: SessionMeta): boolean =>
    s.status === 'live' && s.agentState?.phase === 'working' && s.agentKind !== 'shell'
  const liveOrphanCwds = corpus.sessions
    .filter((s) => !s.issueId && isLiveWorking(s))
    .map((s) => s.cwd)
  const seatsOrphans = (i: IssueFacts): boolean => {
    const wt = (i as { worktreePath?: string | null }).worktreePath
    return !!wt && liveOrphanCwds.some((cwd) => cwd === wt || cwd.startsWith(`${wt}/`))
  }
  const workingIn = (i: IssueFacts): number =>
    (sessionsOf.get(i.id) ?? []).filter(isLiveWorking).length + (seatsOrphans(i) ? 1 : 0)
  const subtreeWorking = (id: string): number =>
    (children.get(id) ?? []).reduce((sum, child) => {
      const issue = byId.get(child)
      return sum + (issue ? workingIn(issue) + subtreeWorking(child) : 0)
    }, 0)
  // The family is every session bound to the issue (`issue.sessions`, the
  // schema's R2 membership: headless sessions excepted).
  const familyOf = (id: string): number =>
    (sessionsOf.get(id) ?? []).filter((s) => (s as { headless?: boolean }).headless !== true)
      .length
  const openRoot = (id: string): boolean => {
    const i = byId.get(id)
    return i !== undefined && isOpenHuman(i) && !i.parentId && !i.pinned
  }
  const openRootWithChildren = (id: string): boolean => openRoot(id) && parents.has(id)
  return {
    root: (id) => byId.get(id) !== undefined && !byId.get(id)?.parentId,
    openRootWithChildren,
    childlessRoot: (id) => openRoot(id) && !parents.has(id),
    // #2: one bound live working session and nothing else working in the
    // subtree, bound or seated by prefix (a row reads working if any
    // descendant does), and a family larger than one level of the budget.
    phaseRoot: (id) => {
      const i = byId.get(id)
      return (
        i !== undefined &&
        openRootWithChildren(id) &&
        workingIn(i) === 1 &&
        !seatsOrphans(i) &&
        subtreeWorking(id) === 0 &&
        familyOf(id) > PHASE_FAMILY_FLOOR
      )
    },
    phaseSession: (id) => (sessionsOf.get(id) ?? []).find(isLiveWorking),
    heartbeatSession: (id) =>
      (sessionsOf.get(id) ?? [])
        .filter((s) => (s as { headless?: boolean }).headless !== true)
        .sort((a, b) => numericId(a.sessionId) - numericId(b.sessionId))[0],
  }
}

/**
 * The browser page's visible heartbeat target (POD-4560): among `window` (the
 * drawn roots, in the oracle's list order), the first row with a
 * {@link targetRules} `heartbeatSession` that neither the rename nor the stage
 * move rule wants, else the first with one. One definition for the page and
 * the test that proves the bump redraws exactly that row.
 */
export function pickVisibleHeartbeat(
  rules: ReturnType<typeof targetRules>,
  window: readonly string[],
): { issueId: string; sessionId: string } | undefined {
  const withSession = window.filter((id) => rules.heartbeatSession(id) !== undefined)
  const issueId =
    withSession.find((id) => !rules.openRootWithChildren(id) && !rules.childlessRoot(id)) ??
    withSession[0]
  if (issueId === undefined) return undefined
  return { issueId, sessionId: (rules.heartbeatSession(issueId) as SessionMeta).sessionId }
}

/**
 * Pick every scenario target by rule. Deterministic in the corpus; throws
 * when a rule finds nothing, so a corpus that cannot express a scenario fails
 * loudly instead of silently aiming at the wrong row. `scenarios.test.ts`
 * checks each pick against the oracle (visible or not, group crossed).
 */
export function pickTargets(corpus: FixtureCorpus): ScenarioTargets {
  const issues = [...(corpus.issues as unknown as IssueFacts[])].sort(
    (a, b) => numericId(a.id) - numericId(b.id),
  )
  const byId = new Map(issues.map((i) => [i.id, i]))
  const children = new Map<string, string[]>()
  for (const issue of issues) {
    if (!issue.parentId) continue
    const list = children.get(issue.parentId) ?? []
    list.push(issue.id)
    children.set(issue.parentId, list)
  }
  const sessionsOf = new Map<string, typeof corpus.sessions>()
  for (const s of corpus.sessions) {
    if (!s.issueId) continue
    const list = sessionsOf.get(s.issueId) ?? []
    list.push(s)
    sessionsOf.set(s.issueId, list)
  }
  const isLiveWorking = (s: (typeof corpus.sessions)[number]): boolean =>
    s.status === 'live' && s.agentState?.phase === 'working' && s.agentKind !== 'shell'
  const openHuman = isOpenHuman
  const childless = (i: IssueFacts): boolean => (children.get(i.id)?.length ?? 0) === 0
  const fail = (rule: string): never => {
    throw new Error(`[scenarios] corpus seed ${corpus.seed} scale ${corpus.scale}: no ${rule}`)
  }

  const used = new Set<string>([corpus.unscannedWorktree.issueId])
  const take = (rule: string, predicate: (i: IssueFacts) => boolean): IssueFacts => {
    const hit = issues.find((i) => !used.has(i.id) && predicate(i)) ?? fail(rule)
    used.add(hit.id)
    return hit
  }

  const rules = targetRules(corpus)
  const root = take(
    `open human root with children, exactly one working session and a family over ${PHASE_FAMILY_FLOOR}`,
    (i) => rules.phaseRoot(i.id),
  )
  const phaseSession = rules.phaseSession(root.id) ?? fail('working session on the root')
  const childlessRoot = (rule: string): IssueFacts => take(rule, (i) => rules.childlessRoot(i.id))
  const stageMove = childlessRoot('childless open root for the stage move')
  const archive = childlessRoot('childless open root to archive')
  const evict = childlessRoot('childless open root to evict')
  const markRead = childlessRoot('childless open root to mark read')
  const keeperLeaf = take('rescue-parent leaf', (i) => {
    if (!openHuman(i) || !i.parentId || !childless(i)) return false
    const parent = byId.get(i.parentId)
    return (
      parent !== undefined &&
      parent.stage === 'backlog' &&
      !parent.closedAt &&
      !parent.archived &&
      !parent.deletedAt &&
      (sessionsOf.get(parent.id)?.length ?? 0) === 0 &&
      children.get(parent.id)?.length === 1
    )
  })
  const reparent = take(
    'visible child of another open root',
    (i) =>
      openHuman(i) &&
      !!i.parentId &&
      i.parentId !== root.id &&
      (sessionsOf.get(i.id) ?? []).some(isLiveWorking) &&
      openHuman(byId.get(i.parentId) ?? ({} as IssueFacts)),
  )
  const origins = new Set(
    issues.flatMap((i) =>
      ((i as { deps?: { id: string; type: string }[] }).deps ?? [])
        .filter((dep) => dep.type === 'discovered-from')
        .map((dep) => dep.id),
    ),
  )
  const heartbeat =
    corpus.sessions
      .filter((s) => {
        const issue = s.issueId ? byId.get(s.issueId) : undefined
        return (
          issue !== undefined &&
          issue.audience === 'agent' &&
          !!issue.closedAt &&
          !issue.parentId &&
          childless(issue) &&
          !origins.has(issue.id)
        )
      })
      .sort((a, b) => numericId(a.sessionId) - numericId(b.sessionId))[0] ??
    fail('session on a closed agent root')
  const burstIssueIds = issues.filter((i) => openHuman(i)).slice(0, 50).map((i) => i.id)
  if (burstIssueIds.length < 50) fail('50 open human issues for the burst')
  const repo = corpus.repos[0] ?? fail('repo for the new issue')

  return {
    heartbeatSessionId: heartbeat.sessionId,
    visibleRootId: root.id,
    phaseSessionId: phaseSession.sessionId,
    stageMoveId: stageMove.id,
    archiveId: archive.id,
    evictId: evict.id,
    keeperLeafId: keeperLeaf.id,
    keeperParentId: keeperLeaf.parentId as string,
    reparentId: reparent.id,
    reparentToId: root.id,
    markReadId: markRead.id,
    burstIssueIds,
    newIssueRepo: { repoId: repo.repoId as string, repoPath: repo.path },
  }
}

// ------------------------------------------------------------------ engine

export interface ScenarioEngine {
  /** Replaced by {@link ScenarioEngine.reload}. */
  engine: ReturnType<typeof createClientRuntime>
  /** Replaced by {@link ScenarioEngine.reload} (a fresh facade over `cache`). */
  replica: ReturnType<typeof createKernelReplica>
  cache: ScenarioCache
  /** The socket hub the current runtime subscribed; `emit` is a server push. */
  hub: { emit(kind: string, ...args: unknown[]): void }
  /** What `discovery.refreshRepos` answers. Replace `repos` to move worktrees,
   *  then push `worktreesChanged` through `hub`. */
  discovery: { repos: unknown[] }
  /**
   * POD-4555 — a tab reload: destroy the runtime and boot a new one over a
   * fresh replica facade on the SAME durable cache and the SAME outbox store,
   * so queued and awaiting writes replay under their mutation ids. Callers
   * holding the old `engine`/`replica` (a row source) must re-bind.
   */
  reload: () => Promise<void>
  corpus: FixtureCorpus
  targets: ScenarioTargets
  rejectNextMarkRead: () => void
  /** Issue ids whose mark-read the server acknowledged, in receipt order. */
  markReadReceipts: readonly string[]
  /** Advance the runtime's coarse clock by `ms` through its own tick path. */
  advanceClock: (ms: number) => void
  /** A fresh ISO timestamp on the corpus clock, strictly increasing per
   *  engine: every write stamps rows with this, never the wall clock. */
  stamp: () => string
  settleMs: number
}

export interface EngineOptions {
  principal?: string
  settleMs?: number
  /** Build the runtime without starting it or installing the corpus
   *  (`coldBootstrap` primes its source first). */
  start?: boolean
  /** POD-4555: the server's answers to the slice's write commands. */
  server?: ScenarioServer
  /**
   * POD-4555: which queue carries writes. `'kernel'` is the production web
   * queue (`openKernelEngineOutbox` over an in-memory store, stamped by the
   * corpus clock): per-issue partitions, the mark-read collapse (supersede),
   * durable across {@link ScenarioEngine.reload}. Default `'legacy'`, the
   * compatibility queue the round-two counts ran on.
   */
  outbox?: 'legacy' | 'kernel'
  /** POD-4555: the outbox's connectivity. Default: the platform probes. */
  network?: { isOnline: () => boolean; onlineEvents: OnlineEvents }
  /**
   * POD-4747: awaited once the durable cache is seeded (`'cache'`), before
   * the replica and the runtime exist: the layer-split driver takes the heap
   * there (`harness/web/entrylib.ts` `stagePoint`).
   */
  stage?: (name: 'cache') => Promise<void>
  /**
   * POD-4747: seed the durable cache with its OWN copy of every row, as the
   * kernel holds rows it decoded from disk, instead of the fixture's objects
   * by reference. The layer split sets it, so the kernel's rows are measured
   * as the kernel's and the fixture's as the harness's.
   */
  ownRows?: boolean
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Boot a `ClientRuntime` over a fixture corpus and publish the seeded rows as
 * ONE addressed bootstrap (not 2N events). The one boot path: the scenarios,
 * the engine-backed count runs and the browser pages all come through here.
 */
export async function startEngineOnCorpus(
  corpus: FixtureCorpus,
  opts: EngineOptions = {},
): Promise<ScenarioEngine> {
  const cache = seedCacheFromCorpus(corpus, { ownRows: opts.ownRows === true })
  await opts.stage?.('cache')
  const side = createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] })
  const newReplica = () => createKernelReplica({ cache, side })
  let rejectArmed = false
  const markReadReceipts: string[] = []
  const discovery = { repos: corpus.repos as unknown[] }
  const api = scenarioApi(discovery, {
    rejectMarkRead: () => {
      if (!rejectArmed) return false
      rejectArmed = false
      return true
    },
    markReadAcknowledged: (id) => markReadReceipts.push(id),
    ...(opts.server ? { server: opts.server } : {}),
  })
  const clock = manualClock(corpus.fixedNow)
  const principal = opts.principal ?? 'operator'
  const outboxStore = opts.outbox === 'kernel' ? new InMemoryOutboxStore() : null
  const boot = async (replica: ReturnType<typeof createKernelReplica>) => {
    const hub = new FakeHub()
    const createOutboxFn = outboxStore
      ? await openKernelEngineOutbox({
          store: outboxStore,
          principal,
          api: api as PodiumClientApi,
          now: clock.now,
          onDegraded: (detail) => {
            throw new Error(`[scenarios] kernel outbox degraded: ${String(detail)}`)
          },
        })
      : undefined
    const engine = createClientRuntime({
      principal: asClientPrincipal(asUserId(principal)),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: api as PodiumClientApi,
      onFatalError: (message) => {
        throw new Error(message)
      },
      createReplicaFn: () => replica,
      routerWindow: fakeRouterWindow(),
      createHub: () => hub as unknown as SocketHub,
      coarseClock: clock,
      ...(createOutboxFn ? { createOutboxFn } : {}),
      ...(opts.network ? { isOnline: opts.network.isOnline, onlineEvents: opts.network.onlineEvents } : {}),
    })
    return { engine, hub }
  }
  const install = async (ctx: ScenarioEngine): Promise<void> => {
    ctx.engine.start()
    await settle(ctx.settleMs)
    ctx.replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'cold-start',
      snapshotSeq: 1,
      entityCount: cache.records.length,
      bufferedFramesApplied: 0,
    } as never)
    await settle(ctx.settleMs)
  }
  const replica = newReplica()
  const first = await boot(replica)
  let stamps = 0
  const settleMs = opts.settleMs ?? (corpus.issues.length > 1000 ? 600 : 60)
  const ctx: ScenarioEngine = {
    engine: first.engine,
    replica,
    cache,
    hub: first.hub,
    discovery,
    reload: async () => {
      ctx.engine.destroy()
      const fresh = newReplica()
      const next = await boot(fresh)
      ctx.engine = next.engine
      ctx.replica = fresh
      ctx.hub = next.hub
      await install(ctx)
    },
    corpus,
    targets: pickTargets(corpus),
    rejectNextMarkRead: () => {
      rejectArmed = true
    },
    markReadReceipts,
    advanceClock: (ms) => clock.advance(ms),
    stamp: () => {
      stamps += 1
      return new Date(clock.now() + stamps).toISOString()
    },
    settleMs,
  }
  if (opts.start === false) return ctx
  await install(ctx)
  return ctx
}

/** Boot a runtime over `buildCorpus(scale, seed)`. */
export function startScenarioEngine(
  scale: FixtureScale = 1,
  opts: EngineOptions & { seed?: number } = {},
): Promise<ScenarioEngine> {
  return startEngineOnCorpus(buildCorpus(scale, opts.seed ?? FIXTURE_SEED), opts)
}

// ---------------------------------------------------------------- snapshots

/** The oracle's delta surface: folded rows before/after plus the locals. */
export interface ScenarioSnapshot {
  issues: { id: string; title: string; stage: string; archived: boolean; readAt: unknown }[]
  sessions: { sessionId: string; lastActiveAt: string; phase: unknown }[]
  selectedIssueId: string | null
  coarseNow: number
}

export function captureSnapshot(engine: ScenarioEngine['engine']): ScenarioSnapshot {
  const snap = engine.getSnapshot()
  return {
    issues: allIssueViewModels(engine.replica, snap.issueProjections, snap.issueUserStates).map((i) => ({
      id: i.id,
      title: (i as { title?: unknown }).title as string,
      stage: (i as { stage?: unknown }).stage as string,
      archived: Boolean((i as { archived?: unknown }).archived),
      readAt: (i as { readAt?: unknown }).readAt ?? null,
    })),
    sessions: snap.sessions.map((s) => ({
      sessionId: s.sessionId,
      lastActiveAt: s.lastActiveAt,
      phase: (s.agentState as { phase?: unknown } | undefined)?.phase ?? null,
    })),
    selectedIssueId: snap.selectedIssueId as unknown as string | null,
    coarseNow: snap.coarseNow,
  }
}

export interface ScenarioResult {
  /** Scenario function name, e.g. `visibleTitleRename`. */
  scenario: string
  /** Methodology §5.8 number, e.g. `#4` (`#6a` for the new/archive/evict set). */
  methodology: string
  /** The corpus the scenario ran on. */
  corpus: { scale: FixtureScale; seed: number; issues: number; sessions: number }
  /** The rows the write aimed at (see `pickTargets`). */
  targets: ScenarioTargets
  events: RowSourceEvent[]
  before: ScenarioSnapshot
  after: ScenarioSnapshot
  stats: { rowsVisited: number; enumerations: number; events: number }
}

export const EMPTY_SNAPSHOT: ScenarioSnapshot = {
  issues: [],
  sessions: [],
  selectedIssueId: null,
  coarseNow: 0,
}

function corpusLabel(corpus: FixtureCorpus): ScenarioResult['corpus'] {
  return {
    scale: corpus.scale,
    seed: corpus.seed,
    issues: corpus.issues.length,
    sessions: corpus.sessions.length,
  }
}

/** Run `action` under a fresh row source, then drain it. Every write settles
 *  the engine itself. */
async function runWithSource(
  scenario: string,
  methodology: string,
  ctx: ScenarioEngine,
  action: () => unknown,
  opts: { before?: ScenarioSnapshot } = {},
): Promise<ScenarioResult> {
  const handle = createRowSource(ctx.engine, ctx.replica, { mode: 'overlaid' })
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    const before = opts.before ?? captureSnapshot(ctx.engine)
    await action()
    handle.flush()
    const after = captureSnapshot(ctx.engine)
    return {
      scenario,
      methodology,
      corpus: corpusLabel(ctx.corpus),
      targets: ctx.targets,
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        enumerations: handle.stats.enumerations,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
  }
}

/** Boot on the fixture, run one write under a row source, tear down. */
async function scenario(
  name: string,
  methodology: string,
  scale: FixtureScale,
  write: (ctx: ScenarioEngine) => unknown,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(scale)
  try {
    return await runWithSource(name, methodology, ctx, () => write(ctx))
  } finally {
    ctx.engine.destroy()
  }
}

// ------------------------------------------------------------------ writes

/** How many of `ctx.markReadReceipts` a write has already taken. */
const takenReceipts = new WeakMap<ScenarioEngine, number>()

/** The mark-reads the server acknowledged since the last take, deduplicated.
 *  The server answers inside the write itself, so this is a cursor, not a
 *  count taken at the settle. */
function takeMarkReadReceipts(ctx: ScenarioEngine): string[] {
  const from = takenReceipts.get(ctx) ?? 0
  takenReceipts.set(ctx, ctx.markReadReceipts.length)
  return [...new Set(ctx.markReadReceipts.slice(from))]
}

/**
 * A write, settled: the engine settles, and every mark-read the write provoked
 * (the eager mark-read-on-view of the selected row) is acknowledged by the
 * server and then ECHOED as truth — `readAt` at the server's clock — before
 * the step ends (POD-4618).
 *
 * Without the echo the runtime keeps that read awaiting truth until its 60 s
 * WALL-CLOCK sweep (`AWAITING_TRUTH_TTL_MS`), which retires it in whichever
 * later step is running then and charges that step a row it did not change.
 * Only an explicit press (#9a) is left un-echoed, on purpose: its echo is #9b.
 */
async function settled(ctx: ScenarioEngine): Promise<void> {
  await settle(ctx.settleMs)
  if (echoAcknowledgedMarkReads(ctx).length === 0) return
  await settle(ctx.settleMs)
}

/**
 * The server's echo of every mark-read it acknowledged since the last call:
 * `readAt` at the server's clock, one replica batch, synchronously. Returns
 * the ids echoed. `settled` (the count harness) and the browser page
 * (`harness/web/entrylib.ts`, POD-4559) both settle a step's own mark-reads
 * through this, so no step's awaiting read retires in a later one.
 */
export function echoAcknowledgedMarkReads(ctx: ScenarioEngine): string[] {
  const acknowledged = takeMarkReadReceipts(ctx)
  if (acknowledged.length === 0) return acknowledged
  ctx.replica.batch(() => {
    for (const id of acknowledged) echoIssueRead(ctx, id, ctx.stamp())
  })
  return acknowledged
}

/** A kernel upsert through the replica facade: the cache takes the row, then
 *  the facade hears `upserted` (exported for the change generator, POD-4555;
 *  `readmitted` marks a row returning after an evict). */
export function upsert(
  ctx: ScenarioEngine,
  entity: KernelEntity,
  entityId: string,
  value: unknown,
  seq = 2,
  readmitted = false,
): void {
  ctx.cache.put(entity, entityId, value)
  ctx.replica.onKernelEvent({ type: 'upserted', record: { entity, entityId, value, provenance: { seq } }, readmitted } as never)
}

/** The authority's snapshot omitted the row: `evicted`, not `removed`. */
export function evict(ctx: ScenarioEngine, entity: KernelEntity, entityId: string): void {
  ctx.cache.drop(entity, entityId)
  ctx.replica.onKernelEvent({ type: 'evicted', entity, entityId } as never)
}

/** A real deletion (POD-4555): the kernel event is `removed`. */
export function remove(ctx: ScenarioEngine, entity: KernelEntity, entityId: string): void {
  ctx.cache.drop(entity, entityId)
  ctx.replica.onKernelEvent({ type: 'removed', entity, entityId } as never)
}

// Server writes build on SERVER truth: the kernel cache the replica reads,
// never the runtime snapshot. The snapshot is painted: it carries the
// client's pending overlays, so a write built from it would echo a pending
// value back as if the server had written it (POD-4551, as the change
// generator does, gen/run.ts). The cache also keeps every resume twin the
// snapshot's session list collapses.

function patchSession(ctx: ScenarioEngine, sessionId: string, patch: Record<string, unknown>): void {
  const current = ctx.cache.read('session', sessionId)?.value as object | undefined
  if (!current) throw new Error(`session ${sessionId} missing from the server cache`)
  upsert(ctx, 'session', sessionId, { ...current, ...patch })
}

/** Apply own facts and personal markers through their independent feed rows. */
function patchIssue(ctx: ScenarioEngine, id: string, modelPatch: Record<string, unknown>, projectionPatch: Record<string, unknown> = {}): void {
  const projection = ctx.cache.read('issueProjection', id)?.value as object | undefined
  if (!projection) throw new Error(`issue ${id} missing from the server cache`)
  ctx.replica.batch(() => {
    upsert(ctx, 'issueProjection', id, { ...projection, ...projectionPatch })
    const markers = Object.fromEntries(Object.entries(modelPatch).filter(([key]) => ['readAt', 'tuckedAt', 'pinned'].includes(key)))
    if (Object.keys(markers).length) patchIssueMarkers(ctx, id, markers)
  })
}
function patchIssueMarkers(ctx: ScenarioEngine, id: string, patch: Record<string, unknown>, seq = 2): void {
  const rowId = issueUserStateRowId(asUserId('u-bench'), asIssueId(id))
  const state = ctx.cache.read('issueUserState', rowId)?.value as object | undefined
  upsert(ctx, 'issueUserState', rowId, { userId: 'u-bench', entityId: id, readAt: null, tuckedAt: null, pinned: false, ...state, ...patch }, seq)
}
function evictIssueRows(ctx: ScenarioEngine, id: string): void {
  evict(ctx, 'issueProjection', id)
}

function liveSession(
  ctx: ScenarioEngine,
  sessionId: string,
  fields: { issueId: string; cwd: string; title: string },
): Record<string, unknown> {
  const now = ctx.stamp()
  return {
    sessionId,
    issueId: fields.issueId,
    agentKind: 'codex',
    cwd: fields.cwd,
    title: fields.title,
    status: 'live',
    controllerId: `c-${sessionId}`,
    geometry: { cols: 80, rows: 24 },
    epoch: 1,
    clientCount: 1,
    createdAt: now,
    lastActiveAt: now,
    origin: { kind: 'spawn' },
    archived: false,
    readAt: now,
    unread: false,
    agentState: { phase: 'working', since: now },
  }
}

function freshIssue(
  ctx: ScenarioEngine,
  id: string,
  seq: number,
  title: string,
): { wire: Record<string, unknown>; projection: Record<string, unknown> } {
  const now = ctx.stamp()
  const { repoId, repoPath } = ctx.targets.newIssueRepo
  return {
    wire: {
      id,
      seq,
      title,
      stage: 'in_progress',
      parentId: null,
      createdAt: now,
      updatedAt: now,
      archived: false,
      audience: 'human',
      repoId,
      repoPath,
      readAt: null,
      unread: true,
      needsHuman: false,
      blocked: false,
    },
    projection: {
      id,
      seq,
      title,
      stage: 'in_progress',
      repoId,
      description: { value: '' },
      createdAt: now,
      updatedAt: now,
      archived: false,
      audience: 'human',
      priority: 2,
      type: 'task',
    },
  }
}

// Each `apply*` is the synchronous write (what a browser page times); each
// `write*` is the same write followed by the engine settle (what a count run
// awaits). One body per write.

/** #1 — heartbeat on a session of a row the worklist never shows. */
export function applyHeartbeat(ctx: ScenarioEngine, sessionId = ctx.targets.heartbeatSessionId): string {
  patchSession(ctx, sessionId, { lastActiveAt: ctx.stamp() })
  return sessionId
}

export async function writeHeartbeat(ctx: ScenarioEngine): Promise<string> {
  const target = applyHeartbeat(ctx)
  await settled(ctx)
  return target
}

/** #2 — a session on a visible row changes phase (working → idle). */
export async function writePhaseChange(ctx: ScenarioEngine): Promise<string> {
  const target = ctx.targets.phaseSessionId
  const now = ctx.stamp()
  patchSession(ctx, target, { agentState: { phase: 'idle', since: now }, lastActiveAt: now })
  await settled(ctx)
  return target
}

/** The ledger entities an optimistic write can paint. */
const OVERLAY_ENTITIES = ['sessions', 'sessionUserStates', 'issueUserStates', 'issueProjections'] as const

/**
 * The rows the runtime's optimism ledger still holds a write for — queued,
 * in flight, or resolved and AWAITING TRUTH — as `<entity>:<id>`, sorted.
 * Empty when every optimistic write has settled.
 *
 * A write left here outlives its step: the runtime retires an awaiting write
 * only on covering truth or on its 60 s WALL-CLOCK sweep
 * (`AWAITING_TRUTH_TTL_MS`), and the sweep lands in whichever later step is
 * running then (POD-4618).
 */
export function pendingWrites(ctx: ScenarioEngine): string[] {
  const pending: string[] = []
  for (const entity of OVERLAY_ENTITIES) {
    for (const id of ctx.engine.pendingOverlaysByRow(entity).keys()) pending.push(`${entity}:${id}`)
  }
  return pending.sort()
}

/** The server echoes an issue's read cursor at its own clock. */
function echoIssueRead(ctx: ScenarioEngine, id: string, readAt: string, seq = 2): void {
  patchIssueMarkers(ctx, id, { readAt }, seq)
}

/** #3 — a selection click: locals, plus the eager mark-read of the clicked
 *  row, which `settled` has the server acknowledge and echo within the step
 *  (the feed carries the row painted, then as truth). */
export async function writeSelectionClick(
  ctx: ScenarioEngine,
  id = ctx.targets.visibleRootId,
): Promise<string> {
  ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(id))
  await settled(ctx)
  return id
}

/** #4 — a title rename on a visible row. */
export function applyTitleRename(
  ctx: ScenarioEngine,
  id = ctx.targets.visibleRootId,
  title = 'Renamed visible row',
): string {
  patchIssue(ctx, id, { title }, { title })
  return id
}

export async function writeTitleRename(
  ctx: ScenarioEngine,
  id = ctx.targets.visibleRootId,
): Promise<string> {
  applyTitleRename(ctx, id)
  await settled(ctx)
  return id
}

/** #5 — a stage change moving a row across groups (open lane → closed fold). */
export function applyStageMove(ctx: ScenarioEngine, id = ctx.targets.stageMoveId): string {
  const now = ctx.stamp()
  patchIssue(
    ctx,
    id,
    { stage: 'done', closedAt: now, closedReason: 'done', tuckedAt: now },
    { stage: 'done', closedAt: now, closedReason: 'done' },
  )
  return id
}

export async function writeStageMove(ctx: ScenarioEngine, id = ctx.targets.stageMoveId): Promise<string> {
  applyStageMove(ctx, id)
  await settled(ctx)
  return id
}

/** #6a — a new issue with its working session arrives. */
export async function writeNewIssue(ctx: ScenarioEngine, id = 'i-new'): Promise<string> {
  const { wire, projection } = freshIssue(ctx, id, ctx.corpus.issues.length + 1, 'Brand new issue')
  const sessionId = `s-${id}`
  const session = liveSession(ctx, sessionId, {
    issueId: id,
    cwd: ctx.targets.newIssueRepo.repoPath,
    title: 'Session new',
  })
  ctx.replica.batch(() => {
    patchIssueMarkers(ctx, id, { readAt: wire.readAt ?? null, pinned: wire.pinned ?? false })
    upsert(ctx, 'issueProjection', id, projection)
    upsert(ctx, 'session', sessionId, session)
  })
  await settled(ctx)
  return id
}

/** #6b — an issue is archived. */
export async function writeArchiveIssue(ctx: ScenarioEngine, id = ctx.targets.archiveId): Promise<string> {
  patchIssue(ctx, id, { archived: true }, { archived: true })
  await settled(ctx)
  return id
}

/** #6c — the authority snapshot omits a row (`evicted`, not `removed`). */
export async function writeEvictIssue(ctx: ScenarioEngine, id = ctx.targets.evictId): Promise<string> {
  evictIssueRows(ctx, id)
  await settled(ctx)
  return id
}

/** #6d — evict the only child of a rescue parent: the parent must leave the
 *  visible set with it. */
export async function writeEvictKeeperIssue(
  ctx: ScenarioEngine,
  id = ctx.targets.keeperLeafId,
): Promise<string> {
  evictIssueRows(ctx, id)
  await settled(ctx)
  return id
}

/** #7 — a parent reassignment moves a subtree between chains. */
export async function writeParentReassignment(
  ctx: ScenarioEngine,
  id = ctx.targets.reparentId,
  parentId = ctx.targets.reparentToId,
): Promise<string> {
  patchIssue(ctx, id, { parentId }, { parentId })
  await settled(ctx)
  return id
}

/** #8 — the runtime's coarse clock ticks by `ms` (default one period) with no
 *  row change. */
export async function writeClockTick(ctx: ScenarioEngine, ms = 60_000): Promise<number> {
  ctx.advanceClock(ms)
  await settled(ctx)
  return ctx.engine.getSnapshot().coarseNow
}

/** #9 press — optimistic mark-read through the engine. Resolves after the
 *  server confirms (or the kernel rolls back on rejection). */
export async function writeOptimisticPress(ctx: ScenarioEngine, id = ctx.targets.markReadId): Promise<void> {
  await ctx.engine.getSnapshot().markIssueRead(asIssueId(id))
  // Not `settled`: the press stays awaiting truth; #9b is its echo.
  await settle(ctx.settleMs)
  takeMarkReadReceipts(ctx)
}

/** #9 echo — the server confirms the mark-read with its own timestamp. */
export const OPTIMISTIC_ECHO_READ_AT = '2026-07-09T00:00:00.000Z'

export async function writeOptimisticEcho(ctx: ScenarioEngine, id = ctx.targets.markReadId): Promise<void> {
  echoIssueRead(ctx, id, OPTIMISTIC_ECHO_READ_AT, 3)
  await settled(ctx)
}

/** #9 rejection — arm the next mark-read to fail, so the kernel rolls back. */
export function armMarkReadRejection(ctx: ScenarioEngine): void {
  ctx.rejectNextMarkRead()
}

/** #10 — a 50-event burst through one `replica.batch()`: one row-source
 *  event carrying 50 new working sessions on 50 open issues. */
export async function writeBurst50(ctx: ScenarioEngine): Promise<void> {
  ctx.replica.batch(() => {
    ctx.targets.burstIssueIds.forEach((issueId, n) => {
      const sessionId = `s-burst-${n}`
      upsert(
        ctx,
        'session',
        sessionId,
        liveSession(ctx, sessionId, {
          issueId,
          cwd: ctx.targets.newIssueRepo.repoPath,
          title: `Burst ${n}`,
        }),
      )
    })
  })
  await settled(ctx)
}

/** #13 grow — ten new issues put silently, then one rescope install. */
export async function writeRescopeGrow(ctx: ScenarioEngine): Promise<void> {
  const base = ctx.corpus.issues.length
  ctx.replica.batch(() => {
    for (let n = 0; n < 10; n += 1) {
      const { wire, projection } = freshIssue(ctx, `i-grow-${n}`, base + n + 1, `Grown ${n}`)
      const marker = fixtureMarkers([wire as never])[0]!
      ctx.cache.put('issueUserState', issueUserStateRowId(marker.userId, marker.entityId), marker)
      ctx.cache.put('issueProjection', projection.id as string, projection)
    }
  })
  rescope(ctx, 2)
  await settled(ctx)
}

/** #13 back — drop the grown rows silently, then rescope again. */
export async function writeRescopeBack(ctx: ScenarioEngine): Promise<void> {
  ctx.replica.batch(() => {
    for (let n = 0; n < 10; n += 1) {
      ctx.cache.drop('issueUserState', issueUserStateRowId(asUserId('u-bench'), asIssueId(`i-grow-${n}`)))
      ctx.cache.drop('issueProjection', `i-grow-${n}`)
    }
  })
  rescope(ctx, 3)
  await settled(ctx)
}

function rescope(ctx: ScenarioEngine, snapshotSeq: number): void {
  ctx.replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'rescope',
    snapshotSeq,
    entityCount: ctx.cache.records.length,
    bufferedFramesApplied: 0,
  } as never)
}

// --------------------------------------------------------------- scenarios

/** #1 — a heartbeat on a session of an invisible row. */
export function unrelatedHeartbeat(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#1 unrelatedHeartbeat', '#1', scale, writeHeartbeat)
}

/** #2 — a session on a visible row changes phase (working → idle). */
export function visibleSessionPhaseChange(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#2 visibleSessionPhaseChange', '#2', scale, writePhaseChange)
}

/** #3 — a selection click.
 *
 * FINDING (vs the "(locals only)" parenthetical in the issue brief): on this
 * branch selection is NOT rows-free. Foregrounding the issue arms the
 * mark-on-view reaction (`reactions.ts: updateIssueMarkReadTimer`), which
 * fires EAGERLY on the leading edge (`MARK_READ_ON_VIEW_MS` throttle already
 * elapsed since boot) and paints an optimistic `issueMarkRead` for the
 * foregrounded row. The stream therefore reports one update with the clicked
 * issue's row — faithfully, like production. Arms must treat a click as
 * "locals + one mark-read row", and the methodology #3 budget ("2 rows
 * committed") reads as the arm's latch rows plus this kernel row. */
export function selectionClick(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#3 selectionClick', '#3', scale, (ctx) => writeSelectionClick(ctx))
}

/** #4 — a title rename on a visible row. */
export function visibleTitleRename(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#4 visibleTitleRename', '#4', scale, (ctx) => writeTitleRename(ctx))
}

/** #5 — a stage change moving a row across groups (open lane → closed fold). */
export function stageMoveAcrossGroups(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#5 stageMoveAcrossGroups', '#5', scale, (ctx) => writeStageMove(ctx))
}

/** #6a — a new issue with its session arrives. */
export function newIssue(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#6a newIssue', '#6a', scale, (ctx) => writeNewIssue(ctx))
}

/** #6b — an issue is archived. */
export function archiveIssue(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#6b archiveIssue', '#6b', scale, (ctx) => writeArchiveIssue(ctx))
}

/** #6c — the authority snapshot omits a row: evict without revision. */
export function evictWithoutRevision(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#6c evictWithoutRevision', '#6c', scale, (ctx) => writeEvictIssue(ctx))
}

/** #6d — keeper evict (POD-4503): the rescue parent's only child is evicted,
 *  so the parent must leave the visible set with it. A missing keeper-seat
 *  cleanup keeps a ghost parent and fails parity; #6c cannot fail that way. */
export function evictKeeperWithoutRevision(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#6d evictKeeperWithoutRevision', '#6d', scale, (ctx) => writeEvictKeeperIssue(ctx))
}

/** #7 — a parent reassignment moves a subtree between chains. */
export function parentReassignment(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#7 parentReassignment', '#7', scale, (ctx) => writeParentReassignment(ctx))
}

/** #8 — the coarse clock ticks with no row change: the runtime publishes a
 *  new `coarseNow` and the row stream stays silent. */
export function clockTick(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#8 clockTick', '#8', scale, (ctx) => writeClockTick(ctx))
}

/** #9 — optimistic press, server echo, second press, definitive rejection. */
export function optimisticEchoAndRejection(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#9 optimisticEchoAndRejection', '#9', scale, async (ctx) => {
    await writeOptimisticPress(ctx)
    await writeOptimisticEcho(ctx)
    armMarkReadRejection(ctx)
    await writeOptimisticPress(ctx)
  })
}

/** #10 — a 50-event burst through one `replica.batch()`. */
export function burst50(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#10 burst50', '#10', scale, writeBurst50)
}

/** #11 — principal switch: dispose everything, new runtime over a FRESH replica. */
export async function principalSwitch(scale: FixtureScale = 1): Promise<ScenarioResult> {
  const old = await startScenarioEngine(scale, { principal: 'operator' })
  const oldHandle = createRowSource(old.engine, old.replica, { mode: 'overlaid' })
  const oldEvents: RowSourceEvent[] = []
  const oldOff = oldHandle.source.subscribe((e) => oldEvents.push(e))
  const before = captureSnapshot(old.engine)
  oldOff()
  oldHandle.dispose()
  old.engine.destroy()
  // The disposed source stays silent even when its replica moves.
  old.replica.onKernelEvent({
    type: 'upserted',
    record: {
      entity: 'session',
      entityId: old.targets.phaseSessionId,
      value: { sessionId: old.targets.phaseSessionId },
      provenance: { seq: 99 },
    },
    readmitted: false,
  } as never)
  oldHandle.flush()
  if (oldEvents.length !== 0) {
    throw new Error(`disposed source emitted ${oldEvents.length} events after principal switch`)
  }
  const fresh = await startScenarioEngine(scale, { principal: 'operator-2' })
  try {
    // A fresh replica over a fresh runtime installs as one replace. The
    // source primed against the post-start snapshot, so force the install
    // signal the way a real switch does: rescope onto the same corpus.
    return await runWithSource(
      '#11 principalSwitch',
      '#11',
      fresh,
      async () => {
        rescope(fresh, 2)
        await settled(fresh)
      },
      { before },
    )
  } finally {
    fresh.engine.destroy()
  }
}

/** #12 — cold bootstrap: the source is created before `start()`.
 *
 * The natural cold path yields no issue or session row, and that is correct:
 * the hydrate-first seed is already in the snapshot the source primed against
 * (same array identities, no kernel addresses), so there is nothing to
 * report. Discovery lands after the source primed, so its lanes arrive as
 * one update (POD-4606). Arms bootstrap from `source.snapshot()`, not from an event — the
 * methodology #12 budget ("full, once") constrains ARM work, and the test
 * asserts the snapshot is full. A kernel-driven install (bootstrap,
 * rescope, principal switch) is what produces a `replace`; those paths are
 * #11 and #13. */
export async function coldBootstrap(scale: FixtureScale = 1): Promise<ScenarioResult> {
  const ctx = await startEngineOnCorpus(buildCorpus(scale, FIXTURE_SEED), { start: false })
  try {
    return await runWithSource(
      '#12 coldBootstrap',
      '#12',
      ctx,
      async () => {
        ctx.engine.start()
        await settled(ctx)
      },
      { before: EMPTY_SNAPSHOT },
    )
  } finally {
    ctx.engine.destroy()
  }
}

/** #13 — rescope growth then back: two full replaces, no leak. */
export function rescopeGrowth(scale: FixtureScale = 1): Promise<ScenarioResult> {
  return scenario('#13 rescopeGrowth', '#13', scale, async (ctx) => {
    await writeRescopeGrow(ctx)
    await writeRescopeBack(ctx)
  })
}

// ------------------------------------------------------------- registry

export interface ScenarioEntry {
  /** Scenario function name. */
  name: string
  /** Methodology §5.8 number. */
  methodology: string
  run: (scale?: FixtureScale) => Promise<ScenarioResult>
}

/** All thirteen methodology scenarios in order (the #6 set expands to four
 *  functions, #9 covers echo and rejection in one replay). */
export const SCENARIOS: ScenarioEntry[] = [
  { name: 'unrelatedHeartbeat', methodology: '#1', run: unrelatedHeartbeat },
  { name: 'visibleSessionPhaseChange', methodology: '#2', run: visibleSessionPhaseChange },
  { name: 'selectionClick', methodology: '#3', run: selectionClick },
  { name: 'visibleTitleRename', methodology: '#4', run: visibleTitleRename },
  { name: 'stageMoveAcrossGroups', methodology: '#5', run: stageMoveAcrossGroups },
  { name: 'newIssue', methodology: '#6a', run: newIssue },
  { name: 'archiveIssue', methodology: '#6b', run: archiveIssue },
  { name: 'evictWithoutRevision', methodology: '#6c', run: evictWithoutRevision },
  { name: 'evictKeeperWithoutRevision', methodology: '#6d', run: evictKeeperWithoutRevision },
  { name: 'parentReassignment', methodology: '#7', run: parentReassignment },
  { name: 'clockTick', methodology: '#8', run: clockTick },
  { name: 'optimisticEchoAndRejection', methodology: '#9', run: optimisticEchoAndRejection },
  { name: 'burst50', methodology: '#10', run: burst50 },
  { name: 'principalSwitch', methodology: '#11', run: principalSwitch },
  { name: 'coldBootstrap', methodology: '#12', run: coldBootstrap },
  { name: 'rescopeGrowth', methodology: '#13', run: rescopeGrowth },
]

/** Heartbeat cost at one fixture scale: rows visited must be 1 (the
 *  addressed row) and enumerations (whole-slice passes) 0 at every scale.
 *  Counts only — no walls under box load (methodology §5.7). */
export async function measureHeartbeat(
  scale: FixtureScale,
): Promise<{ rowsVisited: number; enumerations: number; rows: number }> {
  const result = await unrelatedHeartbeat(scale)
  return {
    rowsVisited: result.stats.rowsVisited,
    enumerations: result.stats.enumerations,
    rows: result.events[0]?.rows.length ?? 0,
  }
}
