import type { MobxPool } from './pool'
import type { HeaderEntity } from './header-schema'

/** The header's only resident-key enumeration. It never reads row values or
 * indexes unloaded payloads. All values go through the pool's single reader. */
export function headerIds(pool: MobxPool, entity: HeaderEntity): string[] {
  return [...pool.header.tables[entity].keys()]
}
export function residentSessionIds(pool: MobxPool): string[] {
  return [...pool.header.sessionIds.keys()]
}

export function allResidentSessions(pool: MobxPool): [string, object][] {
  return [...pool.tables.session.keys()].flatMap((id) => {
    const row = pool.row('session', id)
    return typeof row === 'object' && row !== null ? [[id, row] as [string, object]] : []
  })
}

export function knownIssueIds(pool: MobxPool): string[] {
  return [...new Set([...pool.tables.issue.keys(), ...(pool.residency?.ids('issue') ?? [])])]
}
export function knownSessionIds(pool: MobxPool): string[] {
  return [...new Set([...pool.tables.session.keys(), ...(pool.residency?.ids('session') ?? [])])]
}
