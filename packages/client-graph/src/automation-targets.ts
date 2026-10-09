import { omitGone } from './lookup'
import { keyedComputed } from '@podium/mobx-helpers'
import { agentExecutionRejection, machinePathBasename, machinePathKey, machinePathsEqual, structuralRejection } from '@podium/model/browser'
import type { AutomationTarget, TargetAvailability, TargetExclusions } from './automation-views'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import { createQueryResult, joinQueryResults } from './query-result'
import { LOADING } from './worklist/rollup'

const GLOBAL = '__global__'
const SAVED = 'saved:'
const EMPTY_IDS: string[] = []
const STATES = ['available', 'unauthorized', 'unreachable', 'incapable', 'disabled', 'degraded'] as const
const REASONS = ['', 'not available to you', 'machine offline', 'machine runs no daemon', 'agent hosting disabled', 'agent hosting unavailable']
const label = (path: string) => machinePathBasename(path) || path
const usageOrder = (at: number) => String(Number.MAX_SAFE_INTEGER - at).padStart(16, '0')

/** Automation-owned, demand-scoped presentation. Queries publish ordered IDs
 * and counts; an option observes only its own scalar metadata. Each external
 * worktree root contributes one activity number to the existing sorted query. */
export function createAutomationTargets(pool: MobxPool) {
  const cache = keyedComputed(
    (key: string) => debugName(() => `automations.${key}`),
    (_key: string, read: () => unknown) => read(),
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  const catalog = () => memo('targetCatalog', () => omitGone(pool.row('settingsCatalog', 'catalog')))
  const path = (id: string): string => {
    const value = memo(`targetPath:${id}`, () => {
      const row = omitGone(pool.row('settingsRepository', id))
      return row === LOADING ? LOADING : row?.path
    })
    return value === LOADING ? '' : value ?? ''
  }
  const byPath = () => memo('targetPaths', () => {
    const rows = catalog()
    const paths = new Map<string, string[]>()
    if (rows && rows !== LOADING) for (const id of rows.repositories) {
      const key = machinePathKey(path(id)), group = paths.get(key)
      if (group) group.push(id)
      else paths.set(key, [id])
    }
    return paths
  })
  const kind = (id: string) => memo(`targetKind:${id}`, () => {
    const row = omitGone(pool.row('settingsRepository', id))
    return row === LOADING ? LOADING : row?.kind
  })
  const machineId = (id: string) => memo(`targetMachine:${id}`, () => {
    const row = omitGone(pool.row('settingsRepository', id))
    return row === LOADING ? LOADING : row?.machineId
  })
  const worktrees = (id: string) => memo(`targetWorktrees:${id}`, () => {
    const row = omitGone(pool.row('settingsRepository', id))
    return row === LOADING ? LOADING : row?.worktrees
  })
  const scoped = () => memo('targetsScoped', () => {
    const rows = catalog()
    return !!rows && rows !== LOADING && rows.machines.some(id => {
      const row = omitGone(pool.model('machine', id))
      return !!row && row !== LOADING && row.use !== undefined
    })
  })
  const machineState = (id: string) => memo(`targetMachineState:${id}`, (): TargetAvailability | typeof LOADING => {
    const machine = omitGone(pool.model('machine', id))
    if (machine === LOADING) return LOADING
    if (!machine || scoped() && machine.use !== 'granted') return 'unauthorized'
    if (structuralRejection(machine) === 'no-daemon') return 'incapable'
    if (!machine.online) return 'unreachable'
    const execution = agentExecutionRejection(machine)
    return execution === 'agents-disabled' ? 'disabled'
      : execution === 'agents-unavailable' ? 'degraded' : 'available'
  })
  const state = (id: string) => memo(`targetState:${id}`, () => {
    const machine = machineId(id)
    return machine === LOADING ? LOADING : machine === undefined ? 'available' as const : machineState(machine)
  })
  const roots = (id: string) => memo(`targetRoots:${id}`, () => {
    const trees = worktrees(id)
    return trees === LOADING ? LOADING : [path(id), ...(trees ?? []).map(tree => tree.path)]
  })
  const activity = (root: string) => memo(`targetRootActivity:${machinePathKey(root)}`, () =>
    pool.queries.activity({ kind: 'commandRootActivity', roots: [root] }))
  const rootQuery = (id: string) => memo(`targetRootQuery:${id}`, () => {
    const ids = roots(id)
    if (ids === LOADING) return LOADING
    const membership = new Set(ids.map(machinePathKey))
    return createQueryResult<number>({
      name: debugName(() => `automations.rootUsage:${id}`) ?? 'automation root usage',
      ids: () => membership,
      has: root => membership.has(root),
      read: activity,
      order: root => usageOrder(activity(root)),
      // This query's membership is an immutable computed input. A new root
      // snapshot creates a new query; the old demand releases its row watches.
      subscribe: () => () => {},
    })
  })
  const usage = (id: string) => memo(`targetUsage:${id}`, () => {
    // Duplicate paths retain the first discovery row's usage, as the form did.
    const first = byPath().get(machinePathKey(path(id)))?.[0] ?? id
    const query = rootQuery(first)
    if (query === LOADING) return 0
    const values = query.get()
    return values === LOADING ? 0 : values?.[0] ?? 0
  })
  const status = (id: string) => memo(`targetStatus:${id}`, () => {
    const type = kind(id)
    if (type === LOADING) return LOADING
    if (type === undefined || type === 'worktree') return undefined
    const availability = state(id)
    return availability === LOADING ? LOADING : STATES.indexOf(availability)
  })
  const queries = () => memo('targetQueries', () => {
    const rows = catalog()
    if (rows === LOADING) return LOADING
    const ids = rows?.repositories ?? EMPTY_IDS
    const positions = new Map(ids.map((id, index) => [id, String(index).padStart(12, '0')]))
    const membership = new Set(ids)
    const members = { ids: () => ids, has: (id: string) => membership.has(id), subscribe: () => () => {} }
    return {
      choices: createQueryResult<string>({
        ...members, name: 'automations.orderedTargets',
        read: id => {
          const code = status(id)
          return code === LOADING ? LOADING : code === 0 ? id : undefined
        },
        order: id => status(id) === 0 ? `${usageOrder(usage(id))}:${positions.get(id)}` : '',
      }),
      exclusions: createQueryResult<number>({
        ...members, name: 'automations.targetExclusions', read: status,
        matches: STATES.slice(1).map((_, index) => (code: number) => code === index + 1),
      }),
    }
  })
  const savedState = (currentPath: string) => memo(`savedTargetState:${machinePathKey(currentPath)}`, () => {
    let first: TargetAvailability | undefined
    for (const id of byPath().get(machinePathKey(currentPath)) ?? EMPTY_IDS) {
      const code = status(id)
      if (code === 0) return 'available'
      if (code !== undefined && code !== LOADING && first === undefined) first = STATES[code]
    }
    return first ?? 'unauthorized'
  })
  const fixedQuery = (currentPath: string | null) => memo(`fixedTargets:${currentPath ?? ''}`, () => {
    const id = currentPath === null ? GLOBAL : `${SAVED}${currentPath}`
    return createQueryResult<string>({
      name: 'automations.fixedTarget', ids: () => [id], has: key => key === id,
      read: () => currentPath === null || savedState(currentPath) !== 'available' ? id : undefined,
      order: () => currentPath === null ? 'z' : 'zz', subscribe: () => () => {},
    })
  })
  function targets(currentPath: string | null = null) {
    return memo(`targets:${currentPath ?? ''}`, () => {
      const query = queries()
      const excluded: TargetExclusions = { unauthorized: 0, unreachable: 0, incapable: 0, disabled: 0, degraded: 0 }
      let pending = query === LOADING ? 1 : 0
      const choices = query === LOADING ? LOADING : query.choices.get()
      if (choices === LOADING) pending++
      if (query !== LOADING) for (let index = 1; index < STATES.length; index++) {
        const count = query.exclusions.countMatch(index - 1)
        if (count === LOADING) pending++
        else excluded[STATES[index] as keyof TargetExclusions] = count ?? 0
      }
      const rows = catalog()
      if (rows && rows !== LOADING) for (const id of rows.machines)
        if (omitGone(pool.model('machine', id)) === LOADING) pending++
      const global = fixedQuery(null).get()
      const saved = currentPath === null ? undefined : fixedQuery(currentPath).get()
      const ids = choices === LOADING || global === LOADING || saved === LOADING ? EMPTY_IDS
        : joinQueryResults(saved ? [choices ?? EMPTY_IDS, global ?? EMPTY_IDS, saved] : [choices ?? EMPTY_IDS, global ?? EMPTY_IDS])
      return { ids, excluded, pending: pending ? 1 : 0 }
    })
  }
  function target(id: string): AutomationTarget | undefined {
    return memo<AutomationTarget | undefined>(`target:${id}`, () => {
      if (id === GLOBAL) return { value: GLOBAL, label: 'Global (home directory)', availability: 'available' }
      if (id.startsWith(SAVED)) {
        const value = id.slice(SAVED.length), availability = savedState(value)
        return { value, label: `${label(value)} — ${REASONS[STATES.indexOf(availability)]}`, availability, opaque: true }
      }
      const availability = state(id)
      return availability === LOADING ? undefined : { value: path(id), label: label(path(id)), availability }
    })
  }
  function targetMachine(currentPath: string) {
    return memo(`selectedTargetMachine:${machinePathKey(currentPath)}`, () => {
      const id = byPath().get(machinePathKey(currentPath))?.[0]
      const machine = id === undefined ? undefined : machineId(id)
      return machine === LOADING ? undefined : machine
    })
  }
  function targetForPath(value: string, savedPath: string | null) {
    return memo(`targetForPath:${JSON.stringify([value, savedPath])}`, () => {
      if (value === GLOBAL) return target(GLOBAL)
      for (const id of byPath().get(machinePathKey(value)) ?? EMPTY_IDS)
        if (status(id) === 0) return target(id)
      return savedPath !== null && machinePathsEqual(value, savedPath) ? target(`${SAVED}${value}`) : undefined
    })
  }
  return { targets, target, targetMachine, targetForPath, dispose: () => cache.clear() }
}
