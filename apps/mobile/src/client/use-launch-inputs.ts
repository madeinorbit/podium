import type { MobxPool } from '@podium/client-graph/pool'
import type { GitRepositoryWire, MachineWire } from '@podium/model'
import { useMobilePoolProjection } from './mobile-pool'

const EMPTY = { repos: [] as GitRepositoryWire[], machines: [] as MachineWire[] }
/** Existing resident header membership; entity values come only through pool.row. */
function readInputs(pool: MobxPool) {
  return {
    repos: pool.headerViews.ids('repository').flatMap(id => {
      const row = pool.row('repository', id) as GitRepositoryWire | undefined
      return row ? [row] : []
    }),
    machines: pool.headerViews.machines(),
  }
}
export function useLaunchInputs() { return useMobilePoolProjection(readInputs, EMPTY) }
