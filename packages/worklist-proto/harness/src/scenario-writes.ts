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
