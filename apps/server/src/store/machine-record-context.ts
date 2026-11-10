import { UpdateChannel } from '@podium/model'
import { eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { meta } from '../migrations/schema'
import type { StoreDrizzle, StoreQueries } from './executor/sync-drizzle'
import { prepared } from './executor/sync-drizzle'

const FLEET_CHANNEL = 'machines.fleet-channel.v1'
const UPDATE_EXECUTION = 'updates.execution.v1'
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
  withdrawnTargets: z.array(z.tuple([UpdateChannel, z.object({ reason: z.string() })])).optional(),
})

export class MachineRecordContextRepository {
  private readonly db: StoreDrizzle
  constructor(queries: StoreQueries) {
    this.db = queries.rootDb
  }

  /** The server's last resolution of the effective fleet channel. Environment
   * changes are observed at the next boot, as by the existing execution path. */
  async setFleetChannel(channel: UpdateChannel): Promise<boolean> {
    return (await setChannel(this.db).get({ channel: UpdateChannel.parse(channel) })) !== undefined
  }

  async read(): Promise<{
    fleetChannel: UpdateChannel
    targets: ReadonlyMap<UpdateChannel, { version?: string; unavailableReason?: string }>
  }> {
    const rows = new Map((await contextRows(this.db).all()).map(({ key, value }) => [key, value]))
    const fleetChannel = UpdateChannel.parse(rows.get(FLEET_CHANNEL) ?? 'stable')
    const targets = new Map<UpdateChannel, { version?: string; unavailableReason?: string }>()
    const bytes = rows.get(UPDATE_EXECUTION)
    if (bytes) {
      const stored = StoredTargets.parse(JSON.parse(bytes))
      for (const [channel, target] of stored.targets) targets.set(channel, target)
      for (const [channel, withdrawal] of stored.withdrawnTargets ?? []) {
        if (!targets.has(channel)) targets.set(channel, { unavailableReason: withdrawal.reason })
      }
    }
    return { fleetChannel, targets }
  }
}
