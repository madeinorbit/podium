import { UpdateChannel } from '@podium/model'
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { meta } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries } from './executor/sync-drizzle'
import { prepared } from './executor/sync-drizzle'
import { MachineRecordWrites } from './machine-record-writes'

const FLEET_CHANNEL = 'machines.fleet-channel.v1'
const UPDATE_EXECUTION = 'updates.execution.v1'
const channelRow = prepared((db: StoreDrizzle) =>
  db.select({ value: meta.value }).from(meta).where(eq(meta.key, FLEET_CHANNEL)).prepare(),
)
const contextRows = prepared((db: StoreDrizzle) =>
  db
    .select({ key: meta.key, value: meta.value })
    .from(meta)
    .where(inArray(meta.key, [FLEET_CHANNEL, UPDATE_EXECUTION]))
    .prepare(),
)
const setChannel = prepared((db: StoreDrizzle) =>
  db
    .insert(meta)
    .values({ key: FLEET_CHANNEL, value: sql.placeholder('channel') })
    .onConflictDoUpdate({
      target: meta.key,
      set: { value: sql`excluded.value` },
      setWhere: sql`${meta.value} <> excluded.value`,
    })
    .returning({ key: meta.key })
    .prepare(),
)

// Read only the update authority's existing durable inputs, without constructing
// an UpdatesService (which would restore process state and own execution).
const StoredTargets = z.object({
  targets: z.array(z.tuple([UpdateChannel, z.object({ version: z.string() })])),
})

export class MachineRecordContextRepository {
  private readonly db: StoreDrizzle
  constructor(
    private readonly queries: StoreQueries,
    private readonly records = new MachineRecordWrites(),
    private readonly machineIds: () => Promise<readonly string[]> = async () => [],
  ) {
    this.db = queries.rootDb
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
      const current = UpdateChannel.parse((await channelRow(this.db).get())?.value ?? 'stable')
      if (current === selected) return { result: await write(), changed: false }
      return await this.records.compare({ display: this.machineIds }, async () => {
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

  async read(): Promise<{
    fleetChannel: UpdateChannel
    targets: ReadonlyMap<UpdateChannel, { version: string }>
  }> {
    const rows = new Map((await contextRows(this.db).all()).map(({ key, value }) => [key, value]))
    const fleetChannel = UpdateChannel.parse(rows.get(FLEET_CHANNEL) ?? 'stable')
    const targets = new Map<UpdateChannel, { version: string }>()
    const bytes = rows.get(UPDATE_EXECUTION)
    if (bytes) {
      const stored = StoredTargets.parse(JSON.parse(bytes))
      for (const [channel, target] of stored.targets) targets.set(channel, target)
    }
    return { fleetChannel, targets }
  }
}
