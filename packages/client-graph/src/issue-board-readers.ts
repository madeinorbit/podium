import type { MobxPool } from './pool'

/** Shared by the filter-menu hook and its structural work guard. */
export function readBoardCatalog(pool: MobxPool, open: boolean, agents: boolean) {
  return open ? pool.row('issueBoardCatalog', String(agents)) : undefined
}
