/**
 * POD-4444 — the thirteen scenario replay library (methodology §5.8).
 *
 * Every arm replays the SAME scenarios against the SAME row-source input, so
 * arms never diff collections and never read the kernel themselves. Each
 * scenario builds a seeded kernel corpus (`MemCache` + `createKernelReplica`
 * + `ClientRuntime`, the way `apps/web/src/perf/kernel-scenarios` does with a
 * stubbed hub/transport), primes a `createRowSource` over it, performs ONE
 * action, and returns `{events, before, after}`:
 *
 * - `events` — the `RowSourceEvent`s the action published (the arm input).
 * - `before` / `after` — the oracle's delta surface: the folded snapshot rows
 *   the legacy derivation projects (G2's parity oracle consumes these to
 *   check visible rows, order, per-row fields and groups after every
 *   scenario). The delta is asserted in `scenarios.test.ts` at the snapshot
 *   level; the SliceSnapshot projection is G2's (POD-4443), which owns the
 *   fixture and oracle folders — this module keeps its seed helpers LOCAL
 *   (unexported `seedCorpus`) so the sibling's fixture work never collides
 *   with it.
 *
 * SCENARIO → METHODOLOGY MAP (§5.8 scenarios and budgets; #14 growth and #15
 * coexistence belong to the G4 harness, not here):
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
 * | parentReassignment | #7 | both chains | 1 update, 1 row |
 * | clockTick | #8 | bands | 0 (time is a local) |
 * | optimisticEchoAndRejection | #9 | as #2 | press, echo, press, rollback |
 * | burst50 | #10 | bounded | 1 update, 50 rows |
 * | principalSwitch | #11 | full once | 1 replace, full (kernel install) |
 * | coldBootstrap | #12 | full once | 0 events; arms snapshot (finding) |
 * | rescopeGrowth | #13 | full each | 2 replaces |
 *
 * DUAL-WRITE. Seed and scenario writes update wire AND projection rows
 * together, as the authority does during the normalized migration: a
 * projection change always arrives with its wire change in the same batch and
 * dedupes to one `issue` row (see `row-source.ts`).
 *
 * EVICT. `evictWithoutRevision` drops the rows from the cache and fires
 * `evicted` (not `removed`): an authority snapshot omitting the row. Evict
 * and delete look the same to the arm (row gone) and that is intended
 * (spec §2).
 *
 * CLOCK AND SELECTION are locals (`SliceLocals`), never rows. `clockTick`
 * advances the local clock without touching the kernel and yields no events;
 * arms re-derive bands from `coarseNow`. `selectionClick` drives the real
 * `setSelectedIssueId` publication and likewise yields no row event.
 *
 * PRINCIPAL SWITCH disposes the runtime AND the row source; a new runtime
 * over a FRESH replica bootstraps exactly once. The old source is asserted
 * silent afterwards.
 */

import type { EntityRecord } from '@podium/sync/replica'
import type { PodiumClientApi } from '@podium/client-core/api'
import { createClientRuntime } from '@podium/client-core/engine'
import { asClientPrincipal } from '@podium/client-core/principal'
import {
  createKernelReplica,
  createSideCache,
  memoryStorage,
  type KernelCacheRead,
} from '@podium/client-core/replica'
import type { SocketHub } from '@podium/client-core/socket-transport'
import type { RouterWindow } from '@podium/client-core/ui-state'
import { asIssueId, asUserId } from '@podium/model'
import { createRowSource } from './row-source'
import type { RowSourceEvent } from './stats'

// ------------------------------------------------------------------ scales

export interface CorpusSpec {
  issues: number
  sessions: number
  repos: number
  worktreesPerRepo: number
}

/** Functional scale: every scenario's event counts and delta, fast in CI. */
export const SMALL_CORPUS: CorpusSpec = {
  issues: 60,
  sessions: 50,
  repos: 6,
  worktreesPerRepo: 2,
}

/** Live-shaped corpus sizes for the growth slope (methodology §1a/§5.7):
 *  1×, 2× and 4× issues. Only the heartbeat replays at these scales. */
export const GROWTH_CORPORA: Record<'x1' | 'x2' | 'x4', CorpusSpec> = {
  x1: { issues: 4867, sessions: 4304, repos: 500, worktreesPerRepo: 1 },
  x2: { issues: 9734, sessions: 8608, repos: 1000, worktreesPerRepo: 1 },
  x4: { issues: 19468, sessions: 17216, repos: 2000, worktreesPerRepo: 1 },
}

// ------------------------------------------------------------- kernel fake

export class ScenarioCache implements KernelCacheRead {
  records: EntityRecord[] = []
  readCursor() {
    return null
  }
  readEntities(): readonly EntityRecord[] {
    return this.records
  }
  read(entity: string, entityId: string): EntityRecord | undefined {
    return this.records.find((r) => r.entity === entity && r.entityId === entityId)
  }
  durability(): 'durable' {
    return 'durable'
  }
  put(entity: string, entityId: string, value: unknown): void {
    this.records = [
      ...this.records.filter((r) => !(r.entity === entity && r.entityId === entityId)),
      { entity, entityId, value, provenance: { seq: 1 } },
    ]
  }
  /** Bulk install for seeding: one array build, not one spread per row. The
   *  per-row `put` above is O(corpus) itself, so seeding live-shaped corpora
   *  through it is O(corpus²) — minutes at 4×. Seeds go through here. */
  install(rows: { entity: string; entityId: string; value: unknown }[]): void {
    const byId = new Map(this.records.map((r) => [`${r.entity}:${r.entityId}`, r]))
    for (const row of rows) {
      byId.set(`${row.entity}:${row.entityId}`, {
        entity: row.entity,
        entityId: row.entityId,
        value: row.value,
        provenance: { seq: 1 },
      })
    }
    this.records = [...byId.values()]
  }
  drop(entity: string, entityId: string): void {
    this.records = this.records.filter(
      (r) => !(r.entity === entity && r.entityId === entityId),
    )
  }
}

class FakeHub {
  private handlers = new Map<string, Set<(...a: unknown[]) => void>>()
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

// biome-ignore lint/suspicious/noExplicitAny: scenario API stub — shaped per-test like engine runtime.test.ts
function scenarioApi(repos: any[], opts: { rejectMarkRead?: () => boolean } = {}): any {
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
        mutate: async () => ({ repositories: repos, diagnostics: [], machines: [] }),
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
      markRead: {
        mutate: async () => {
          if (opts.rejectMarkRead?.()) {
            throw Object.assign(new Error('scenario rejection'), {
              data: { code: 'BAD_REQUEST', httpStatus: 400 },
            })
          }
          return {}
        },
      },
    },
  }
}

// --------------------------------------------------------------- seed data

const iso = (base: number, offsetMs: number): string =>
  new Date(base + offsetMs).toISOString()
const T0 = Date.parse('2026-09-18T12:00:00Z')

function repoPath(i: number): string {
  return `/repo-${i}`
}

function seedCorpus(cache: ScenarioCache, spec: CorpusSpec): void {
  const rows: { entity: string; entityId: string; value: unknown }[] = []
  const put = (entity: string, entityId: string, value: unknown): void => {
    rows.push({ entity, entityId, value })
  }
  // Repos (prefix join + worktree lanes).
  for (let r = 0; r < spec.repos; r += 1) {
    put('repo', `r${r}`, { id: `r${r}`, prefix: `P${r}` })
  }
  // Issues: wire + projection dual-written. Every 5th is a formal child of
  // its predecessor (R1); every 20th archived (invisible); every 25th done +
  // tucked (closed fold); two pinned; three snoozed (band 2); a few
  // discovered-from edges (R4) on the first issues.
  for (let i = 0; i < spec.issues; i += 1) {
    const id = `i${i}`
    const repo = i % spec.repos
    const archived = i % 20 === 19
    const done = i % 25 === 24
    const stage = archived ? 'in_progress' : done ? 'done' : i % 3 === 0 ? 'review' : 'in_progress'
    const wire = {
      id,
      seq: i + 1,
      title: `Issue ${i}`,
      stage,
      parentId: i > 0 && i % 5 === 4 ? `i${i - 1}` : null,
      createdAt: iso(T0, i * 1000),
      updatedAt: iso(T0, i * 1000 + 500),
      ...(done ? { closedAt: iso(T0, i * 1000 + 800), closedReason: 'shipped' } : {}),
      ...(done && i % 50 === 49 ? { tuckedAt: iso(T0, i * 1000 + 900) } : {}),
      archived,
      pinned: i === 1 || i === 2,
      ...(i % 9 === 8 ? { deferUntil: iso(T0 + 3600_000, 0) } : {}),
      repoId: `r${repo}`,
      repoPath: repoPath(repo),
      readAt: i % 4 === 0 ? null : iso(T0, i * 1000),
      unread: i % 4 === 0,
      needsHuman: i % 7 === 6,
      blocked: false,
    }
    const projection = {
      id,
      seq: i + 1,
      title: `Issue ${i}`,
      stage,
      repoId: `r${repo}`,
      description: { value: '' },
      createdAt: iso(T0, i * 1000),
      updatedAt: iso(T0, i * 1000 + 500),
      archived,
      priority: 2,
      type: 'task',
    }
    put('issue', id, wire)
    put('issueProjection', id, projection)
  }
  for (let d = 0; d < Math.min(5, spec.issues - 1); d += 1) {
    put('issueDep', `dep${d}`, { id: `dep${d}`, fromId: `i${d + 1}`, toId: `i${d}`, type: 'discovered-from' })
  }
  // Sessions: most bound to an issue (R2); every 7th unbound but cwd under a
  // worktree (R3 prefix ownership); every 11th a shell (excluded from
  // membership); one archived. Phases spread working/waiting/idle.
  for (let s = 0; s < spec.sessions; s += 1) {
    const id = `s${s}`
    const repo = s % spec.repos
    const unbound = s % 7 === 6
    const shell = s % 11 === 10
    const phase = s % 3 === 0 ? 'working' : s % 3 === 1 ? 'waiting' : 'idle'
    put('session', id, {
      sessionId: id,
      ...(unbound ? {} : { issueId: `i${s % spec.issues}` }),
      agentKind: shell ? 'shell' : 'codex',
      cwd: unbound ? `${repoPath(repo)}/wt-0/sub` : repoPath(repo),
      title: `Session ${s}`,
      status: 'live',
      controllerId: `c${s}`,
      geometry: { cols: 80, rows: 24 },
      epoch: 1,
      clientCount: 1,
      createdAt: iso(T0, s * 1000),
      lastActiveAt: iso(T0, s * 1000),
      origin: { kind: 'spawn' },
      archived: s === spec.sessions - 1,
      readAt: iso(T0, s * 1000),
      unread: false,
      agentState: { phase, since: iso(T0, s * 1000) },
      ...(phase === 'waiting' ? { offer: { createdAt: iso(T0, s * 1000) } } : {}),
    })
  }
  cache.install(rows)
}

function scenarioRepos(spec: CorpusSpec): { path: string; repoId: string; worktrees: { path: string }[] }[] {
  return Array.from({ length: spec.repos }, (_, r) => ({
    path: repoPath(r),
    kind: 'repository',
    branch: 'main',
    repoId: `r${r}`,
    worktrees: Array.from({ length: spec.worktreesPerRepo }, (_, j) => ({
      path: `${repoPath(r)}/wt-${j}`,
      branch: 'task',
    })),
  }))
}

// ------------------------------------------------------------------ engine

export interface ScenarioEngine {
  engine: ReturnType<typeof createClientRuntime>
  replica: ReturnType<typeof createKernelReplica>
  cache: ScenarioCache
  rejectNextMarkRead: () => void
  settleMs: number
}

const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function startScenarioEngine(
  spec: CorpusSpec,
  opts: { principal?: string; settleMs?: number } = {},
): Promise<ScenarioEngine> {
  const cache = new ScenarioCache()
  seedCorpus(cache, spec)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  let rejectArmed = false
  const api = scenarioApi(scenarioRepos(spec), {
    rejectMarkRead: () => {
      if (!rejectArmed) return false
      rejectArmed = false
      return true
    },
  })
  const engine = createClientRuntime({
    principal: asClientPrincipal(asUserId(opts.principal ?? 'operator')),
    config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
    api: api as PodiumClientApi,
    onFatalError: (message) => {
      throw new Error(message)
    },
    createReplicaFn: () => replica,
    routerWindow: fakeRouterWindow(),
    createHub: () => new FakeHub() as unknown as SocketHub,
  })
  engine.start()
  const settleMs = opts.settleMs ?? (spec.issues > 1000 ? 600 : 60)
  await settle(settleMs)
  // Install the seeded corpus as ONE addressed bootstrap (not 2N events):
  // rows were put silently above; a single cold-start install publishes them.
  replica.onKernelEvent({
    type: 'bootstrap-installed',
    cause: 'cold-start',
    snapshotSeq: 1,
    entityCount: cache.records.length,
    bufferedFramesApplied: 0,
  } as never)
  await settle(settleMs)
  return {
    engine,
    replica,
    cache,
    rejectNextMarkRead: () => {
      rejectArmed = true
    },
    settleMs,
  }
}

// ---------------------------------------------------------------- snapshots

/** The oracle's delta surface: folded rows before/after plus the locals. G2's
 *  parity oracle projects the legacy derivation over the same corpus and
 *  checks visible rows, order, per-row fields and groups; these snapshots are
 *  the `before`/`after` it diffs. */
export interface ScenarioSnapshot {
  issues: { id: string; title: string; stage: string; archived: boolean; readAt: unknown }[]
  sessions: { sessionId: string; lastActiveAt: string; phase: unknown }[]
  selectedIssueId: string | null
  coarseNow: number
}

export function captureSnapshot(
  engine: ScenarioEngine['engine'],
  coarseNowOverride?: number,
): ScenarioSnapshot {
  const snap = engine.getSnapshot()
  return {
    issues: snap.issues.map((i) => ({
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
    coarseNow: coarseNowOverride ?? snap.coarseNow,
  }
}

export interface ScenarioResult {
  /** Scenario function name, e.g. `visibleTitleRename`. */
  scenario: string
  /** Methodology §5.8 number, e.g. `#4` (`#6a` for the new/archive/evict set). */
  methodology: string
  events: RowSourceEvent[]
  before: ScenarioSnapshot
  after: ScenarioSnapshot
  stats: { rowsVisited: number; rebuilds: number; events: number }
}

export const EMPTY_SNAPSHOT: ScenarioSnapshot = {
  issues: [],
  sessions: [],
  selectedIssueId: null,
  coarseNow: 0,
}

async function runWithSource(
  scenario: string,
  methodology: string,
  ctx: ScenarioEngine,
  action: () => void | Promise<void>,
  opts: { extraSettleMs?: number } = {},
): Promise<ScenarioResult> {
  const handle = createRowSource(ctx.engine, ctx.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    const before = captureSnapshot(ctx.engine)
    await action()
    await settle(ctx.settleMs + (opts.extraSettleMs ?? 0))
    handle.flush()
    const after = captureSnapshot(ctx.engine)
    return {
      scenario,
      methodology,
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
  }
}

type Updater = (ctx: ScenarioEngine) => void

function upsertSession(
  ctx: ScenarioEngine,
  sessionId: string,
  patch: Record<string, unknown>,
): void {
  const current = ctx.engine
    .getSnapshot()
    .sessions.find((s) => s.sessionId === sessionId)
  if (!current) throw new Error(`session ${sessionId} missing from snapshot`)
  const next = { ...current, ...patch }
  ctx.cache.put('session', sessionId, next)
  ctx.replica.onKernelEvent({
    type: 'upserted',
    record: { entity: 'session', entityId: sessionId, value: next, provenance: { seq: 2 } },
    readmitted: false,
  } as never)
}

/** Dual-write an issue change across wire + projection in one replica batch. */
function upsertIssue(
  ctx: ScenarioEngine,
  id: string,
  wirePatch: Record<string, unknown>,
  projectionPatch: Record<string, unknown> = {},
): void {
  const snap = ctx.engine.getSnapshot()
  const wire = snap.issues.find((i) => i.id === id)
  if (!wire) throw new Error(`issue ${id} missing from snapshot`)
  const nextWire = { ...wire, ...wirePatch }
  const projection = ctx.cache.read('issueProjection', id)
  const nextProjection = { ...((projection as { value?: object } | undefined)?.value ?? {}), ...projectionPatch }
  ctx.replica.batch(() => {
    ctx.cache.put('issue', id, nextWire)
    ctx.replica.onKernelEvent({
      type: 'upserted',
      record: { entity: 'issue', entityId: id, value: nextWire, provenance: { seq: 2 } },
      readmitted: false,
    } as never)
    ctx.cache.put('issueProjection', id, nextProjection)
    ctx.replica.onKernelEvent({
      type: 'upserted',
      record: { entity: 'issueProjection', entityId: id, value: nextProjection, provenance: { seq: 2 } },
      readmitted: false,
    } as never)
  })
}

// --------------------------------------------------------------- scenarios

/** #1 — a heartbeat on a session of an archived (invisible) issue. */
export async function unrelatedHeartbeat(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    const target =
      ctx.engine
        .getSnapshot()
        .sessions.find((s) => typeof s.issueId === 'string' && s.issueId.endsWith('19'))
        ?.sessionId ?? 's0'
    return await runWithSource('#1 unrelatedHeartbeat', '#1', ctx, () => {
      upsertSession(ctx, target, { lastActiveAt: new Date().toISOString() })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #2 — a session on a visible row changes phase (working → idle). */
export async function visibleSessionPhaseChange(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    const target =
      ctx.engine.getSnapshot().sessions.find((s) => s.agentState?.phase === 'working')
        ?.sessionId ?? 's0'
    return await runWithSource('#2 visibleSessionPhaseChange', '#2', ctx, () => {
      upsertSession(ctx, target, {
        agentState: { phase: 'idle', since: new Date().toISOString() },
        lastActiveAt: new Date().toISOString(),
      })
    })
  } finally {
    ctx.engine.destroy()
  }
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
export async function selectionClick(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#3 selectionClick', '#3', ctx, () => {
      ctx.engine.getSnapshot().setSelectedIssueId(asIssueId('i1'))
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #4 — a title rename on a visible row. */
export async function visibleTitleRename(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#4 visibleTitleRename', '#4', ctx, () => {
      upsertIssue(ctx, 'i0', { title: 'Renamed visible row' }, { title: 'Renamed visible row' })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #5 — a stage change moving a row across groups (open lane → closed fold). */
export async function stageMoveAcrossGroups(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#5 stageMoveAcrossGroups', '#5', ctx, () => {
      const now = new Date().toISOString()
      upsertIssue(
        ctx,
        'i3',
        { stage: 'done', closedAt: now, closedReason: 'shipped', tuckedAt: now },
        { stage: 'done' },
      )
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #6a — a new issue with its session arrives. */
export async function newIssue(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#6a newIssue', '#6a', ctx, () => {
      const id = 'i-new'
      const wire = {
        id,
        seq: spec.issues + 1,
        title: 'Brand new issue',
        stage: 'in_progress',
        parentId: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        repoId: 'r0',
        repoPath: repoPath(0),
        readAt: null,
        unread: true,
        needsHuman: false,
        blocked: false,
      }
      const projection = {
        id,
        seq: spec.issues + 1,
        title: 'Brand new issue',
        stage: 'in_progress',
        repoId: 'r0',
        description: { value: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        priority: 2,
        type: 'task',
      }
      const session = {
        sessionId: 's-new',
        issueId: id,
        agentKind: 'codex',
        cwd: repoPath(0),
        title: 'Session new',
        status: 'live',
        controllerId: 'c-new',
        geometry: { cols: 80, rows: 24 },
        epoch: 1,
        clientCount: 1,
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        origin: { kind: 'spawn' },
        archived: false,
        readAt: new Date().toISOString(),
        unread: false,
        agentState: { phase: 'working', since: new Date().toISOString() },
      }
      ctx.replica.batch(() => {
        for (const [entity, entityId, value] of [
          ['issue', id, wire],
          ['issueProjection', id, projection],
          ['session', 's-new', session],
        ] as const) {
          ctx.cache.put(entity, entityId, value)
          ctx.replica.onKernelEvent({
            type: 'upserted',
            record: { entity, entityId, value, provenance: { seq: 2 } },
            readmitted: false,
          } as never)
        }
      })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #6b — an issue is archived. */
export async function archiveIssue(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#6b archiveIssue', '#6b', ctx, () => {
      upsertIssue(ctx, 'i4', { archived: true }, { archived: true })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #6c — the authority snapshot omits a row: evict without revision. */
export async function evictWithoutRevision(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#6c evictWithoutRevision', '#6c', ctx, () => {
      ctx.replica.batch(() => {
        ctx.cache.drop('issue', 'i5')
        ctx.replica.onKernelEvent({ type: 'evicted', entity: 'issue', entityId: 'i5' } as never)
        ctx.cache.drop('issueProjection', 'i5')
        ctx.replica.onKernelEvent({
          type: 'evicted',
          entity: 'issueProjection',
          entityId: 'i5',
        } as never)
      })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #7 — a parent reassignment moves a subtree between chains. */
export async function parentReassignment(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#7 parentReassignment', '#7', ctx, () => {
      upsertIssue(ctx, 'i9', { parentId: 'i2' }, {})
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #8 — the coarse clock ticks with no row change: time is a local. */
export async function clockTick(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  const handle = createRowSource(ctx.engine, ctx.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    // No kernel write and no optimistic touch: the tick is data
    // (`SliceLocals.coarseNow`), re-derived by arms, never a row event.
    const before = captureSnapshot(ctx.engine)
    const after: ScenarioSnapshot = { ...before, coarseNow: before.coarseNow + 60_000 }
    handle.flush()
    return {
      scenario: '#8 clockTick',
      methodology: '#8',
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
    ctx.engine.destroy()
  }
}

/** #9 — optimistic press, server echo, second press, definitive rejection. */
export async function optimisticEchoAndRejection(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  const handle = createRowSource(ctx.engine, ctx.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    const before = captureSnapshot(ctx.engine)
    const id = asIssueId('i6')
    const press1 = ctx.engine.getSnapshot().markIssueRead(id)
    handle.flush()
    await press1
    await settle(ctx.settleMs)
    handle.flush()
    const wire = ctx.cache.read('issue', 'i6')?.value as Record<string, unknown>
    const echoWire = { ...wire, readAt: '2026-07-09T00:00:00.000Z' }
    ctx.cache.put('issue', 'i6', echoWire)
    ctx.replica.onKernelEvent({
      type: 'upserted',
      record: { entity: 'issue', entityId: 'i6', value: echoWire, provenance: { seq: 3 } },
      readmitted: false,
    } as never)
    await settle(ctx.settleMs)
    handle.flush()
    ctx.rejectNextMarkRead()
    const press2 = ctx.engine.getSnapshot().markIssueRead(id)
    handle.flush()
    await press2
    await settle(ctx.settleMs)
    handle.flush()
    const after = captureSnapshot(ctx.engine)
    return {
      scenario: '#9 optimisticEchoAndRejection',
      methodology: '#9',
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
    ctx.engine.destroy()
  }
}

/** #10 — a 50-event burst through one `replica.batch()`. */
export async function burst50(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  try {
    return await runWithSource('#10 burst50', '#10', ctx, () => {
      ctx.replica.batch(() => {
        for (let n = 0; n < 50; n += 1) {
          const sessionId = `s-burst-${n}`
          const value = {
            sessionId,
            issueId: `i${n % spec.issues}`,
            agentKind: 'codex',
            cwd: repoPath(n % spec.repos),
            title: `Burst ${n}`,
            status: 'live',
            controllerId: `c-burst-${n}`,
            geometry: { cols: 80, rows: 24 },
            epoch: 1,
            clientCount: 1,
            createdAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            origin: { kind: 'spawn' },
            archived: false,
            readAt: new Date().toISOString(),
            unread: false,
            agentState: { phase: 'working', since: new Date().toISOString() },
          }
          ctx.cache.put('session', sessionId, value)
          ctx.replica.onKernelEvent({
            type: 'upserted',
            record: { entity: 'session', entityId: sessionId, value, provenance: { seq: 2 } },
            readmitted: false,
          } as never)
        }
      })
    })
  } finally {
    ctx.engine.destroy()
  }
}

/** #11 — principal switch: dispose everything, new runtime over a FRESH replica. */
export async function principalSwitch(
  spec: CorpusSpec = SMALL_CORPUS,
): Promise<ScenarioResult> {
  const old = await startScenarioEngine(spec, { principal: 'operator' })
  const oldHandle = createRowSource(old.engine, old.replica)
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
      entityId: 's0',
      value: { sessionId: 's0' },
      provenance: { seq: 99 },
    },
    readmitted: false,
  } as never)
  oldHandle.flush()
  if (oldEvents.length !== 0) {
    throw new Error(`disposed source emitted ${oldEvents.length} events after principal switch`)
  }
  const fresh = await startScenarioEngine(spec, { principal: 'operator-2' })
  const handle = createRowSource(fresh.engine, fresh.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    // A fresh replica over a fresh runtime installs as one replace. The
    // source primed against the post-start snapshot, so force the install
    // signal the way a real switch does: rescope onto the same corpus.
    fresh.replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 2,
      entityCount: fresh.cache.records.length,
      bufferedFramesApplied: 0,
    } as never)
    await settle(fresh.settleMs)
    handle.flush()
    const after = captureSnapshot(fresh.engine)
    return {
      scenario: '#11 principalSwitch',
      methodology: '#11',
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
    fresh.engine.destroy()
  }
}

/** #12 — cold bootstrap: the source is created before `start()`.
 *
 * The natural cold path yields ZERO events, and that is correct: the
 * hydrate-first seed is already in the snapshot the source primed against
 * (same array identities, no kernel addresses), so there is nothing to
 * report. Arms bootstrap from `source.snapshot()`, not from an event — the
 * methodology #12 budget ("full, once") constrains ARM work, and the test
 * asserts the snapshot is full. A kernel-driven install (bootstrap,
 * rescope, principal switch) is what produces a `replace`; those paths are
 * #11 and #13. */
export async function coldBootstrap(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const cache = new ScenarioCache()
  seedCorpus(cache, spec)
  const replica = createKernelReplica({
    cache,
    side: createSideCache({ storage: memoryStorage(), enumerateKeys: () => [] }),
  })
  const api = scenarioApi(scenarioRepos(spec))
  // The source primes empty: the initial install must arrive as one replace.
  const primed = new Promise<ScenarioEngine>((resolve) => {
    const engine = createClientRuntime({
      principal: asClientPrincipal(asUserId('operator')),
      config: { httpOrigin: 'http://x', wsClientUrl: 'ws://x' },
      api: api as PodiumClientApi,
      onFatalError: (message) => {
        throw new Error(message)
      },
      createReplicaFn: () => replica,
      routerWindow: fakeRouterWindow(),
      createHub: () => new FakeHub() as unknown as SocketHub,
    })
    resolve({
      engine,
      replica,
      cache,
      rejectNextMarkRead: () => {},
      settleMs: spec.issues > 1000 ? 600 : 60,
    })
  })
  const ctx = await primed
  const handle = createRowSource(ctx.engine, ctx.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    ctx.engine.start()
    await settle(ctx.settleMs)
    handle.flush()
    const after = captureSnapshot(ctx.engine)
    return {
      scenario: '#12 coldBootstrap',
      methodology: '#12',
      events,
      before: EMPTY_SNAPSHOT,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
    ctx.engine.destroy()
  }
}

/** #13 — rescope growth then back: two full replaces, no leak. */
export async function rescopeGrowth(spec: CorpusSpec = SMALL_CORPUS): Promise<ScenarioResult> {
  const ctx = await startScenarioEngine(spec)
  const handle = createRowSource(ctx.engine, ctx.replica)
  const events: RowSourceEvent[] = []
  const off = handle.source.subscribe((e) => events.push(e))
  try {
    const before = captureSnapshot(ctx.engine)
    // Grow: ten issues with sessions, then a rescope install.
    const grown: Updater = (c) => {
      c.replica.batch(() => {
        for (let n = 0; n < 10; n += 1) {
          const id = `i-grow-${n}`
          const wire = {
            id,
            seq: spec.issues + n + 1,
            title: `Grown ${n}`,
            stage: 'in_progress',
            parentId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archived: false,
            repoId: 'r0',
            repoPath: repoPath(0),
            readAt: null,
            unread: true,
            needsHuman: false,
            blocked: false,
          }
          const projection = {
            id,
            seq: spec.issues + n + 1,
            title: `Grown ${n}`,
            stage: 'in_progress',
            repoId: 'r0',
            description: { value: '' },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            archived: false,
            priority: 2,
            type: 'task',
          }
          c.cache.put('issue', id, wire)
          c.cache.put('issueProjection', id, projection)
        }
      })
    }
    grown(ctx)
    ctx.replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 2,
      entityCount: ctx.cache.records.length,
      bufferedFramesApplied: 0,
    } as never)
    await settle(ctx.settleMs)
    handle.flush()
    // Back: drop the grown rows, rescope again.
    ctx.replica.batch(() => {
      for (let n = 0; n < 10; n += 1) {
        ctx.cache.drop('issue', `i-grow-${n}`)
        ctx.cache.drop('issueProjection', `i-grow-${n}`)
      }
    })
    ctx.replica.onKernelEvent({
      type: 'bootstrap-installed',
      cause: 'rescope',
      snapshotSeq: 3,
      entityCount: ctx.cache.records.length,
      bufferedFramesApplied: 0,
    } as never)
    await settle(ctx.settleMs)
    handle.flush()
    const after = captureSnapshot(ctx.engine)
    return {
      scenario: '#13 rescopeGrowth',
      methodology: '#13',
      events,
      before,
      after,
      stats: {
        rowsVisited: handle.stats.rowsVisited,
        rebuilds: handle.stats.rebuilds,
        events: handle.stats.events,
      },
    }
  } finally {
    off()
    handle.dispose()
    ctx.engine.destroy()
  }
}

// ------------------------------------------------------------- registry

export interface ScenarioEntry {
  /** Scenario function name. */
  name: string
  /** Methodology §5.8 number. */
  methodology: string
  run: (spec?: CorpusSpec) => Promise<ScenarioResult>
}

/** All thirteen methodology scenarios in order (the #6 set expands to three
 *  functions, #9 covers echo and rejection in one replay). The G4 harness
 *  (POD-4445) drives this registry in Chromium for walls; CI asserts counts
 *  on happy-dom. */
export const SCENARIOS: ScenarioEntry[] = [
  { name: 'unrelatedHeartbeat', methodology: '#1', run: unrelatedHeartbeat },
  { name: 'visibleSessionPhaseChange', methodology: '#2', run: visibleSessionPhaseChange },
  { name: 'selectionClick', methodology: '#3', run: selectionClick },
  { name: 'visibleTitleRename', methodology: '#4', run: visibleTitleRename },
  { name: 'stageMoveAcrossGroups', methodology: '#5', run: stageMoveAcrossGroups },
  { name: 'newIssue', methodology: '#6a', run: newIssue },
  { name: 'archiveIssue', methodology: '#6b', run: archiveIssue },
  { name: 'evictWithoutRevision', methodology: '#6c', run: evictWithoutRevision },
  { name: 'parentReassignment', methodology: '#7', run: parentReassignment },
  { name: 'clockTick', methodology: '#8', run: clockTick },
  { name: 'optimisticEchoAndRejection', methodology: '#9', run: optimisticEchoAndRejection },
  { name: 'burst50', methodology: '#10', run: burst50 },
  { name: 'principalSwitch', methodology: '#11', run: principalSwitch },
  { name: 'coldBootstrap', methodology: '#12', run: coldBootstrap },
  { name: 'rescopeGrowth', methodology: '#13', run: rescopeGrowth },
]

/** Heartbeat cost at one corpus scale: rows visited must be 1 (the addressed
 *  row) at every scale; rebuilds count the legacy fold's fresh-array cost.
 *  Counts only — no walls under box load (methodology §5.7). */
export async function measureHeartbeat(
  spec: CorpusSpec,
): Promise<{ rowsVisited: number; rebuilds: number; rows: number }> {
  const result = await unrelatedHeartbeat(spec)
  return {
    rowsVisited: result.stats.rowsVisited,
    rebuilds: result.stats.rebuilds,
    rows: result.events[0]?.rows.length ?? 0,
  }
}
