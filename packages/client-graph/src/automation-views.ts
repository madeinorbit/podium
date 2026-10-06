import { keyedComputed } from '@podium/mobx-helpers'
import { agentExecutionRejection, type MachineWire, machinePathBasename, structuralRejection } from '@podium/model/browser'
import { compareStructural } from 'mobx'
import type { AutomationRows } from './automation-schema'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import type { SettingsRows } from './settings-schema'
import { LOADING } from './worklist/rollup'

export type TargetAvailability = 'available' | 'unauthorized' | 'unreachable' | 'incapable' | 'disabled' | 'degraded'
export interface AutomationTarget { value: string; label: string; availability: TargetAvailability; opaque?: true }
export type TargetExclusions = Record<Exclude<TargetAvailability, 'available'>, number>
export const EMPTY_EXCLUSIONS: TargetExclusions = { unauthorized: 0, unreachable: 0, incapable: 0, disabled: 0, degraded: 0 }
const label = (path: string) => machinePathBasename(path) || path

/** Value reads always use pool.row. Memos live only while observed. Catalog
 * relations cover resident definitions/runs, and cold sessions contribute only
 * the existing declared summary. This layer owns no runtime or mutations. */
export function createAutomationViews(pool: MobxPool) {
  // Summaries build fresh arrays/records; equal answers must not wake consumers.
  const cache = keyedComputed(
    (key: string) => debugName(() => `automations.${key}`),
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  function list() {
    return memo('list', () => {
      const catalog = pool.row('automationCatalog', 'catalog')
      const automations: AutomationRows['automation'][] = [], runs: AutomationRows['automationRun'][] = []
      const runGroups: Record<string, AutomationRows['automationRun'][]> = {}
      let pending = catalog === LOADING ? 1 : 0
      if (catalog && catalog !== LOADING) {
        for (const id of catalog.automations) {
          const row = pool.row('automation', id)
          if (row === LOADING) { pending++; continue }
          if (!row || Reflect.get(row, 'system') === true) continue
          automations.push(row)
          runGroups[id] = pool.sources.related('automation', id, 'runs').flatMap(runId => {
            const run = pool.row('automationRun', runId)
            if (run === LOADING) { pending++; return [] }
            return run ? [run] : []
          }).sort((a, b) => b.firedAt.localeCompare(a.firedAt))
        }
        for (const id of catalog.runs) {
          const row = pool.row('automationRun', id)
          if (row === LOADING) pending++
          else if (row) runs.push(row)
        }
      }
      return { automations, automationRuns: runs, runGroups, pending }
    })
  }
  function repositories() {
    return memo('repositories', () => {
      const catalog = pool.row('settingsCatalog', 'catalog')
      const repos: SettingsRows['settingsRepository'][] = []
      let pending = catalog === LOADING ? 1 : 0
      if (catalog && catalog !== LOADING) for (const id of catalog.repositories) {
        const row = pool.row('settingsRepository', id)
        if (row === LOADING) pending++
        else if (row) repos.push(row)
      }
      return { repos, pending }
    })
  }
  function targets(currentPath: string | null = null) {
    return memo(`targets:${currentPath ?? ''}`, () => {
      const { repos, pending: repoPending } = repositories()
      const catalog = pool.row('settingsCatalog', 'catalog')
      const machines: MachineWire[] = []
      let pending = repoPending
      if (catalog && catalog !== LOADING) for (const id of catalog.machines) {
        const row = pool.row('settingsMachine', id)
        if (row === LOADING) pending++
        else if (row) machines.push(row)
      }
      const scoped = machines.some(machine => machine.use !== undefined)
      const availability = new Map(machines.map(machine => {
        const state: TargetAvailability = scoped && machine.use !== 'granted' ? 'unauthorized'
          : structuralRejection(machine) === 'no-daemon' ? 'incapable'
          : !machine.online ? 'unreachable'
          : agentExecutionRejection(machine) === 'agents-disabled' ? 'disabled'
          : agentExecutionRejection(machine) === 'agents-unavailable' ? 'degraded' : 'available'
        return [machine.id, state] as const
      }))
      const excluded = { ...EMPTY_EXCLUSIONS }, choices: AutomationTarget[] = [], withheld: AutomationTarget[] = []
      for (const repo of repos) {
        if (repo.kind === 'worktree') continue
        const state = repo.machineId === undefined ? 'available' : availability.get(repo.machineId) ?? 'unauthorized'
        const choice = { value: repo.path, label: label(repo.path), availability: state }
        if (state === 'available') choices.push(choice)
        else { excluded[state]++; withheld.push(choice) }
      }
      const usage = new Map<string, number>()
      for (const repo of repos) if (!usage.has(repo.path)) usage.set(repo.path,
        pool.queries.activity({ kind: 'commandRootActivity', roots: [repo.path, ...repo.worktrees.map(row => row.path)] }))
      choices.sort((a, b) => (usage.get(b.value) ?? 0) - (usage.get(a.value) ?? 0))
      choices.push({ value: '__global__', label: 'Global (home directory)', availability: 'available' })
      if (currentPath !== null && !choices.some(choice => choice.value === currentPath)) {
        const state = withheld.find(choice => choice.value === currentPath)?.availability ?? 'unauthorized'
        const reason = { unauthorized: 'not available to you', unreachable: 'machine offline', incapable: 'machine runs no daemon', disabled: 'agent hosting disabled', degraded: 'agent hosting unavailable', available: '' }[state]
        choices.push({ value: currentPath, label: `${label(currentPath)} — ${reason}`, availability: state, opaque: true })
      }
      return { repos, choices, excluded, pending }
    })
  }
  function session(id: string | undefined) {
    if (!id) return undefined
    return pool.queries.setupSessionPresent(id) ? pool.row('setupSession', id) : undefined
  }
  return { list, repositories, targets, session, dispose: () => cache.clear() }
}
export function automationViews(pool: MobxPool) {
  return pool.sources.view('automations', () => createAutomationViews(pool))
}
