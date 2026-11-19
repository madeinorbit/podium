/** Fleet execution is one per installation (POD-6959 design 2.1). The
 * checkpoint is an install key of meta, shared by every workspace. */
import { eq, sql } from 'drizzle-orm'
import { captureWrite } from '../sync/capture-pg'
import { preparedGlobal, type StoreDb } from './executor/sync-drizzle'

const CHECKPOINT_KEY = 'updates.execution.v1'
const checkpoint = preparedGlobal((db, t) =>
  db.select({ value: t.meta.value }).from(t.meta).where(eq(t.meta.key, CHECKPOINT_KEY)).prepare(),
)
const saveCheckpoint = preparedGlobal((db, t) =>
  captureWrite(
    db
      .insert(t.meta)
      .values({ key: CHECKPOINT_KEY, value: sql.placeholder('value') })
      .onConflictDoUpdate({ target: t.meta.key, set: { value: sql.placeholder('value') } }),
  ).prepare(),
)

export async function readUpdateRecoveryValue(db: StoreDb): Promise<string | undefined> {
  return (await checkpoint(db).get())?.value
}

export async function writeUpdateRecoveryValue(db: StoreDb, value: string): Promise<void> {
  await saveCheckpoint(db).run({ value })
}
