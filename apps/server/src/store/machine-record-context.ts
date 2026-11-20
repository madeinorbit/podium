// workspace-scoped (POD-6959)

import { DEFAULT_FLEET_UPDATE_CHANNEL, UpdateChannel } from '@podium/model'
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { captureWrite } from '../sync/capture-pg'
import type { StoreDb, WorkspaceQueries } from './executor/sync-drizzle'
import { preparedGlobal } from './executor/sync-drizzle'
import { MachineRecordWrites } from './machine-record-writes'

// The fleet channel and the update execution are install keys of `meta` (one per
// installation, workspace-manifest.ts INSTALL_META_KEYS), so every definition here is global.
const FLEET_CHANNEL = 'machines.fleet-channel.v1'
const UPDATE_EXECUTION = 'updates.execution.v1'
const SERVER_MOVE_AVAILABLE = 'machines.server-move.v1'
const serverMoveRow = preparedGlobal((db, t) =>
  db
    .select({ value: t.meta.value })
    .from(t.meta)
    .where(eq(t.meta.key, SERVER_MOVE_AVAILABLE))
    .prepare(),
)
const channelRow = preparedGlobal((db, t) =>
  db.select({ value: t.meta.value }).from(t.meta).where(eq(t.meta.key, FLEET_CHANNEL)).prepare(),
)
const contextRows = preparedGlobal((db, t) =>
  db
    .select({ key: t.meta.key, value: t.meta.value })
    .from(t.meta)
    .where(inArray(t.meta.key, [FLEET_CHANNEL, UPDATE_EXECUTION, SERVER_MOVE_AVAILABLE]))
    .prepare(),
)
const setChannel = preparedGlobal((db, t) =>
  captureWrite(
    db
      .insert(t.meta)
      .values({ key: FLEET_CHANNEL, value: sql.placeholder('channel') })
      .onConflictDoUpdate({
        target: t.meta.key,
        set: { value: sql`excluded.value` },
        setWhere: sql`${t.meta.value} <> excluded.value`,
      })
      .returning({ key: t.meta.key }),
  ).prepare(),
)

const setServerMove = preparedGlobal((db, t) =>
  captureWrite(
    db
      .insert(t.meta)
      .values({ key: SERVER_MOVE_AVAILABLE, value: sql.placeholder('available') })
      .onConflictDoUpdate({
        target: t.meta.key,
        set: { value: sql`excluded.value` },
        setWhere: sql`${t.meta.value} <> excluded.value`,
      })
      .returning({ key: t.meta.key }),
  ).prepare(),
)

// Read only the update authority's existing durable inputs, without constructing
// an UpdatesService (which would restore process state and own execution).
const StoredTargets = z.object({
  targets: z.array(z.tuple([UpdateChannel, z.object({ version: z.string() })])),
})

export class MachineRecordContextRepository {
  private readonly db: StoreDb
  constructor(
    private readonly queries: WorkspaceQueries,
    private readonly records = new MachineRecordWrites(),
  ) {
    this.db = queries.db
  }

  /** The resolved channel and its settings source share the source write. */
  async writeFleetChannel<T>(channel: UpdateChannel, write: () => Promise<T>): Promise<T> {
    return (await this.saveFleetChannel(channel, write)).result
  }

  private async saveFleetChannel<T>(
    channel: UpdateChannel,
    write: () => Promise<T>,
  ): Promise<{ result: T; changed: boolean }> {
    const selected = UpdateChannel.parse(channel)
    return await this.queries.createOrJoinTransaction(async () => {
      const current = UpdateChannel.parse(
        (await channelRow(this.db).get())?.value ?? DEFAULT_FLEET_UPDATE_CHANNEL,
      )
      if (current === selected) return { result: await write(), changed: false }
      return await this.records.compare(async () => {
        const result = await write()
        const changed = (await setChannel(this.db).get({ channel: selected })) !== undefined
        return { result, changed }
      })
    })
  }

  /** The server's last resolution of the effective fleet channel. Environment
   * changes are observed at the next boot, as by the existing execution path. */
  async setFleetChannel(channel: UpdateChannel): Promise<boolean> {
    return (await this.saveFleetChannel(channel, async () => undefined)).changed
  }

  /** An install capability shared with record readers in the sync worker. */
  async setServerMoveAvailable(available: boolean): Promise<boolean> {
    return await this.queries.createOrJoinTransaction(async () => {
      const current = (await serverMoveRow(this.db).get())?.value !== 'false'
      if (current === available) return false
      return await this.records.compare(
        async () =>
          (await setServerMove(this.db).get({ available: String(available) })) !== undefined,
      )
    })
  }

  async read(): Promise<{
    fleetChannel: UpdateChannel
    serverMoveAvailable: boolean
    targets: ReadonlyMap<UpdateChannel, { version: string }>
  }> {
    const rows = new Map((await contextRows(this.db).all()).map(({ key, value }) => [key, value]))
    const fleetChannel = UpdateChannel.parse(
      rows.get(FLEET_CHANNEL) ?? DEFAULT_FLEET_UPDATE_CHANNEL,
    )
    const targets = new Map<UpdateChannel, { version: string }>()
    const bytes = rows.get(UPDATE_EXECUTION)
    if (bytes) {
      const stored = StoredTargets.parse(JSON.parse(bytes))
      for (const [channel, target] of stored.targets) targets.set(channel, target)
    }
    return {
      fleetChannel,
      targets,
      serverMoveAvailable: rows.get(SERVER_MOVE_AVAILABLE) !== 'false',
    }
  }
}
