/** One pool for the admin-area harness (POD-6299); no server, no sync. */
import { MobxPool } from '@podium/client-graph/pool'

const pool = new MobxPool({ selectedIssueId: null, coarseNow: 0 })
export const useWorklistPool = (): MobxPool | null => pool
export const useWorklistPoolProjection = <T>(read: (pool: MobxPool) => T, _fallback: T): T =>
  read(pool)
