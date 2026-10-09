import { omitGone } from './lookup'
import { keyedComputed } from '@podium/mobx-helpers'
import { compareStructural } from 'mobx'
import type { AutomationModel } from './models'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import type { SettingsRows } from './settings-schema'
import { LOADING } from './worklist/rollup'
import { createAutomationTargets } from './automation-targets'

export type TargetAvailability = 'available' | 'unauthorized' | 'unreachable' | 'incapable' | 'disabled' | 'degraded'
export interface AutomationTarget { value: string; label: string; availability: TargetAvailability; opaque?: true }
export type TargetExclusions = Record<Exclude<TargetAvailability, 'available'>, number>
export const EMPTY_EXCLUSIONS: TargetExclusions = { unauthorized: 0, unreachable: 0, incapable: 0, disabled: 0, degraded: 0 }

/** Value reads always use pool.row. Memos live only while observed. Catalog
 * relations cover resident definitions/runs, and cold sessions contribute only
 * the existing declared summary. This layer owns no runtime or mutations. */
function createAutomationViews(pool: MobxPool) {
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
          if (row === LOADING) { pending++; continue }
          if (!row || Reflect.get(omitGone(row.row) ?? {}, 'system') === true) continue
          automations.push(row)
        }
      }
      return { automations, pending }
    })
  }
  function repositories() {
    return memo('repositories', () => {
      const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
      const repos: SettingsRows['settingsRepository'][] = []
      let pending = catalog === LOADING ? 1 : 0
      if (catalog && catalog !== LOADING) for (const id of catalog.repositories) {
        const row = omitGone(pool.row('settingsRepository', id))
        if (row === LOADING) pending++
        else if (row) repos.push(row)
      }
      return { repos, pending }
    })
  }
  function run(id: string) {
    return omitGone(pool.model('automationRun', id))
  }
  function session(id: string | undefined) {
    if (!id) return undefined
    return pool.queries.setupSessionPresent(id) ? omitGone(pool.model('session', id)) : undefined
  }
  return { list, repositories, targets: targetViews.targets, target: targetViews.target,
    targetMachine: targetViews.targetMachine, targetForPath: targetViews.targetForPath, run, session,
    dispose: () => { cache.clear(); targetViews.dispose() } }
}
export function automationViews(pool: MobxPool) {
  return pool.sources.view('automations', () => createAutomationViews(pool))
}
