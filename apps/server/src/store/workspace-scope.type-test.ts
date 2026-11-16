/**
 * THE WORKSPACE TYPE RULE, AS A NEGATIVE FIXTURE [POD-6959 design 2.5, check 1].
 *
 * Each `@ts-expect-error` below plants a breach of the workspace rule. The
 * directive passes only while tsc still rejects the line under it; if a change
 * to the handles, the definition kinds or `GlobalTables` ever makes the breach
 * compile, the directive goes unused and TS2578 fails `bun run typecheck`, the
 * ordinary gate. The positive cases are the other half: a rule that refused
 * everything would satisfy every directive on its own.
 *
 * Nothing here runs: the handles are declared, never made, and no test imports
 * this file.
 */

import { eq, sql } from 'drizzle-orm'
import {
  type FleetDb,
  param,
  prepared,
  preparedAcross,
  preparedGlobal,
  type StoreDb,
  type WorkspaceDb,
} from './executor/sync-drizzle'

declare const storeDb: StoreDb
declare const workspaceDb: WorkspaceDb
declare const fleetDb: FleetDb

const sessionById = prepared((db, t) =>
  db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(eq(t.sessions.id, param(t.sessions.id, 'id')))
    .prepare(),
)

const metaValue = preparedGlobal((db, t) =>
  db
    .select({ value: t.meta.value })
    .from(t.meta)
    .where(eq(t.meta.key, param(t.meta.key, 'key')))
    .prepare(),
)

const sessionsAcross = preparedAcross(
  {
    file: 'apps/server/src/store/workspace-scope.type-test.ts',
    name: 'sessionsAcross',
    reason: 'type fixture',
    index: 'none',
    issue: 'POD-7009',
  },
  (db, t) => db.select({ id: t.sessions.id }).from(t.sessions).prepare(),
)

// ---------------------------------------------------------------------------
// ACCEPTED — the shapes the rule must keep compiling
// ---------------------------------------------------------------------------

export async function accepted(): Promise<void> {
  // A workspace definition on a workspace handle, with the caller's values only.
  await sessionById(workspaceDb).all({ id: 's1' })
  // A global definition on a global handle, and on a workspace handle (a
  // workspace may read install tables).
  await metaValue(storeDb).get({ key: 'settings' })
  await metaValue(workspaceDb).get({ key: 'settings' })
  // A cross-workspace read on the fleet handle.
  await sessionsAcross(fleetDb).all()
  // The workspace placeholder inside a definition is the definition's business.
  void sql.placeholder('workspaceId')
}

// ---------------------------------------------------------------------------
// REJECTED — one breach each
// ---------------------------------------------------------------------------

/** A global definition naming a workspace table: `t` carries install tables only. */
export const globalNamingWorkspaceTable = preparedGlobal((db, t) =>
  // @ts-expect-error -- `sessions` is a workspace table, absent from GlobalTables.
  db.select().from(t.sessions).prepare(),
)

export async function rejected(): Promise<void> {
  // A workspace definition called with a global handle: it would run unscoped.
  // @ts-expect-error -- a StoreDb is not a WorkspaceDb.
  await sessionById(storeDb).all({ id: 's1' })

  // A caller naming the workspace: only the handle may.
  // @ts-expect-error -- `workspaceId` is `never` in the values a bound view takes.
  await sessionById(workspaceDb).all({ id: 's1', workspaceId: 'ws_other' })
}
