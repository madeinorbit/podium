/**
 * POD-4445 — shared scenario writes for engine-backed count runs.
 *
 * The G3 scenario library (`shared/src/scenarios.ts`) builds each scenario's
 * engine internally and returns events + delta snapshots; engine-backed count
 * runs instead boot ONE engine (`startScenarioEngine`), mount the arm, then
 * perform the same writes the scenarios perform. These helpers are those
 * writes, factored so the web control test and the native lane run identical
 * inputs: a heartbeat on an archived issue's session (#1), a phase change on
 * a visible working session (#2), and a selection click (#3, locals plus the
 * eager mark-read row — see the finding noted on `selectionClick`).
 *
 * Each helper settles the engine the way the scenarios do. Callers still own
 * the row-source `flush()` (deterministic drain) and disposal.
 */

import { asIssueId } from '@podium/model'
import { startScenarioEngine } from '../../shared/src/scenarios'

export type ScenarioEngine = Awaited<ReturnType<typeof startScenarioEngine>>

async function settle(ctx: ScenarioEngine): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ctx.settleMs))
}

/** #1 — heartbeat on a session of an archived (invisible) issue. */
export async function writeHeartbeat(ctx: ScenarioEngine): Promise<string> {
  const snap = ctx.engine.getSnapshot()
  const target =
    snap.sessions.find(
      (session) => typeof session.issueId === 'string' && session.issueId.endsWith('19'),
    )?.sessionId ?? 's0'
  const current = snap.sessions.find((session) => session.sessionId === target)
  if (!current) throw new Error(`heartbeat target ${target} missing from snapshot`)
  const next = { ...current, lastActiveAt: new Date().toISOString() }
  ctx.cache.put('session', target, next)
  ctx.replica.onKernelEvent({
    type: 'upserted',
    record: { entity: 'session', entityId: target, value: next, provenance: { seq: 2 } },
    readmitted: false,
  } as never)
  await settle(ctx)
  return target
}

/** #2 — a session on a visible row changes phase (working → idle). */
export async function writePhaseChange(ctx: ScenarioEngine): Promise<string> {
  const snap = ctx.engine.getSnapshot()
  const target =
    snap.sessions.find((session) => session.agentState?.phase === 'working')?.sessionId ?? 's0'
  const current = snap.sessions.find((session) => session.sessionId === target)
  if (!current) throw new Error(`phase-change target ${target} missing from snapshot`)
  const next = {
    ...current,
    agentState: { phase: 'idle', since: new Date().toISOString() },
    lastActiveAt: new Date().toISOString(),
  }
  ctx.cache.put('session', target, next)
  ctx.replica.onKernelEvent({
    type: 'upserted',
    record: { entity: 'session', entityId: target, value: next, provenance: { seq: 2 } },
    readmitted: false,
  } as never)
  await settle(ctx)
  return target
}

/** #3 — a selection click (locals + the eager mark-read row). */
export async function writeSelectionClick(ctx: ScenarioEngine, id = 'i1'): Promise<string> {
  ctx.engine.getSnapshot().setSelectedIssueId(asIssueId(id))
  await settle(ctx)
  return id
}

function repoPath(index: number): string {
  return `/repo-${index}`
}

/** Dual-write an issue change across wire + projection in one replica batch
 *  (mirrors G3 `upsertIssue`: the authority dual-writes during the normalized
 *  migration and the pair dedupes to one `issue` row in the stream). */
function dualWriteIssue(
  ctx: ScenarioEngine,
  id: string,
  wirePatch: Record<string, unknown>,
  projectionPatch: Record<string, unknown> = {},
): void {
  const snap = ctx.engine.getSnapshot()
  const wire = snap.issues.find((issue) => issue.id === id)
  if (!wire) throw new Error(`issue ${id} missing from snapshot`)
  const nextWire = { ...wire, ...wirePatch }
  const projection = ctx.cache.read('issueProjection', id)
  const nextProjection = {
    ...((projection as { value?: object } | undefined)?.value ?? {}),
    ...projectionPatch,
  }
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
      record: {
        entity: 'issueProjection',
        entityId: id,
        value: nextProjection,
        provenance: { seq: 2 },
      },
      readmitted: false,
    } as never)
  })
}

/** #4 — a title rename on a visible row (mirrors G3 `visibleTitleRename`). */
export async function writeTitleRename(ctx: ScenarioEngine, id = 'i0'): Promise<string> {
  dualWriteIssue(ctx, id, { title: 'Renamed visible row' }, { title: 'Renamed visible row' })
  await settle(ctx)
  return id
}

/** #5 — a stage change moving a row across groups (mirrors G3
 *  `stageMoveAcrossGroups`: open lane → closed fold). */
export async function writeStageMove(ctx: ScenarioEngine, id = 'i3'): Promise<string> {
  const now = new Date().toISOString()
  dualWriteIssue(
    ctx,
    id,
    { stage: 'done', closedAt: now, closedReason: 'shipped', tuckedAt: now },
    { stage: 'done' },
  )
  await settle(ctx)
  return id
}

/** #6a — a new issue with its session arrives (mirrors G3 `newIssue`). */
export async function writeNewIssue(
  ctx: ScenarioEngine,
  spec: { issues: number },
  id = 'i-new',
): Promise<string> {
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
  await settle(ctx)
  return id
}

/** #6b — an issue is archived (mirrors G3 `archiveIssue`). */
export async function writeArchiveIssue(ctx: ScenarioEngine, id = 'i4'): Promise<string> {
  dualWriteIssue(ctx, id, { archived: true }, { archived: true })
  await settle(ctx)
  return id
}

/** #6c — the authority snapshot omits a row (mirrors G3
 *  `evictWithoutRevision`: `evicted`, not `removed` — no tombstone). */
export async function writeEvictIssue(ctx: ScenarioEngine, id = 'i5'): Promise<string> {
  ctx.replica.batch(() => {
    ctx.cache.drop('issue', id)
    ctx.replica.onKernelEvent({ type: 'evicted', entity: 'issue', entityId: id } as never)
    ctx.cache.drop('issueProjection', id)
    ctx.replica.onKernelEvent({
      type: 'evicted',
      entity: 'issueProjection',
      entityId: id,
    } as never)
  })
  await settle(ctx)
  return id
}

/** #7 — a parent reassignment moves a subtree between chains (mirrors G3
 *  `parentReassignment`). */
export async function writeParentReassignment(
  ctx: ScenarioEngine,
  id = 'i9',
  parentId = 'i2',
): Promise<string> {
  dualWriteIssue(ctx, id, { parentId }, {})
  await settle(ctx)
  return id
}

/** #9 press — optimistic mark-read through the engine (mirrors G3
 *  `optimisticEchoAndRejection`). Resolves after the server confirms (or the
 *  kernel rolls back on rejection). */
export async function writeOptimisticPress(ctx: ScenarioEngine, id = 'i6'): Promise<void> {
  const press = ctx.engine.getSnapshot().markIssueRead(asIssueId(id))
  await press
  await settle(ctx)
}

/** #9 echo — the server confirms the mark-read with its own timestamp. */
export async function writeOptimisticEcho(ctx: ScenarioEngine, id = 'i6'): Promise<void> {
  const wire = ctx.cache.read('issue', id)?.value as Record<string, unknown>
  const echoWire = { ...wire, readAt: '2026-07-09T00:00:00.000Z' }
  ctx.cache.put('issue', id, echoWire)
  ctx.replica.onKernelEvent({
    type: 'upserted',
    record: { entity: 'issue', entityId: id, value: echoWire, provenance: { seq: 3 } },
    readmitted: false,
  } as never)
  await settle(ctx)
}

/** #9 rejection — arm the next mark-read to fail, so the kernel rolls back. */
export function armMarkReadRejection(ctx: ScenarioEngine): void {
  ctx.rejectNextMarkRead()
}

/** #10 — a 50-event burst through one `replica.batch()` (mirrors G3
 *  `burst50`): one row-source event carrying 50 session rows. */
export async function writeBurst50(
  ctx: ScenarioEngine,
  spec: { issues: number; repos: number },
): Promise<void> {
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
  await settle(ctx)
}
