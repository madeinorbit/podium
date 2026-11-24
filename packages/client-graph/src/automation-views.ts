import { keyedComputed } from '@podium/mobx-helpers'
import { compareStructural } from 'mobx'
import { createAutomationTargets } from './automation-targets'
import { debugName } from './debug-name'
import { here, omitGone } from './lookup'
import type { AutomationModel } from './models'
import type { MobxPool } from './pool'
import { LOADING } from './worklist/rollup'

export type TargetAvailability =
  | 'available'
  | 'unauthorized'
  | 'unreachable'
  | 'reconnecting'
  | 'incapable'
  | 'disabled'
  | 'degraded'
export interface AutomationTarget {
  value: string
  label: string
  availability: TargetAvailability
  opaque?: true
}
export type TargetExclusions = Record<Exclude<TargetAvailability, 'available'>, number>
export const EMPTY_EXCLUSIONS: TargetExclusions = {
  unauthorized: 0,
  unreachable: 0,
  reconnecting: 0,
  incapable: 0,
  disabled: 0,
  degraded: 0,
}

/** Records use the pool's shared models and catalog rows. Memos live only while observed. Catalog
 * relations cover resident definitions/runs, and cold sessions contribute only
 * the existing declared summary. This layer owns no runtime or mutations. */
export function createAutomationViews(pool: MobxPool) {
  const targetViews = createAutomationTargets(pool)
  // Summaries build fresh arrays/records; equal answers must not wake consumers.
  const cache = keyedComputed(
    (key: string) => debugName(() => `automations.${key}`),
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  /** Membership only. Run payloads are read when a card's history shows
   * them (`run`), from the window that history asked the server for. */
  function list() {
    return memo('list', () => {
      const catalog = omitGone(pool.row('automationCatalog', 'catalog'))
      const automations: AutomationModel[] = []
      let pending = catalog === LOADING ? 1 : 0
      if (catalog && catalog !== LOADING) {
        for (const id of catalog.automations) {
          const row = omitGone(pool.model('automation', id))
          if (row === LOADING) {
            pending++
            continue
          }
          if (!row || Reflect.get(here(row.row) ?? {}, 'system') === true) continue
          automations.push(row)
        }
      }
      return { automations, pending }
    })
  }
  function run(id: string) {
    return omitGone(pool.model('automationRun', id))
  }
  function session(id: string | undefined) {
    if (!id) return undefined
    const present = pool.queries.setupSessionPresent(id)
    return present ? omitGone(pool.model('session', id)) : undefined
  }
  return {
    list,
    targets: targetViews.targets,
    target: targetViews.target,
    targetMachine: targetViews.targetMachine,
    targetForPath: targetViews.targetForPath,
    run,
    session,
    dispose: () => {
      cache.clear()
      targetViews.dispose()
    },
  }
}
export function automationViews(pool: MobxPool) {
  return createAutomationViews(pool)
}
