import { keyedComputed } from '@podium/mobx-helpers'
import type { MachineFacts } from '@podium/model'
import { DEFAULT_HARNESS_AGENT, machinePathKey } from '@podium/model/browser'
import { compareStructural } from 'mobx'
import { debugName } from './debug-name'
import { here, omitGone } from './lookup'
import { machineFacts } from './machine-facts'
import type { MobxPool } from './pool'
import { type SettingsRows, type SetupSession, setupSessionSummary } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

type SettingsMemo = <T>(key: string, read: () => T) => T
const readUncached: SettingsMemo = (_key, read) => read()

/** Observed summaries suspend when settings/setup unmounts. No full-session
 * mirror or cold-row index; every value is read through the pool's one reader. */
export function createSettingsViews(pool: MobxPool) {
  // Summaries build fresh arrays/records; equal answers must not wake consumers.
  const cache = keyedComputed(
    (key: string) => debugName(() => `settings.${key}`),
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  const catalog = () => memo('catalog', () => readSettingsCatalog(pool, memo))
  function setup(paths: readonly string[] = []) {
    return memo(`setup:${JSON.stringify(paths.map(machinePathKey))}`, () => {
      const usage = new Map<string, number>()
      for (const path of paths) {
        const at = memo(`setup:activity:${machinePathKey(path)}`, () =>
          pool.queries.activity({
            kind: 'commandRootActivity',
            roots: [path],
            agentsOnly: true,
          }),
        )
        if (at > 0) usage.set(machinePathKey(path), at)
      }
      return {
        usage,
        defaultAgent: pool.queries.setupDefaultAgent() ?? DEFAULT_HARNESS_AGENT,
        pending: 0,
      }
    })
  }
  function sessionPresent(id: string) {
    return pool.queries.setupSessionPresent(id)
  }
  function setupCatalog() {
    // Catalog membership and activity have separate dependencies: one updated
    // session must not reread every repository to rebuild the same path list.
    const paths = memo('setup:catalog-paths', () => {
      const repos = catalog().repos
      return [
        ...new Set(
          repos.flatMap((repo) => [repo.path, ...repo.worktrees.map((tree) => tree.path)]),
        ),
      ]
    })
    return setup(paths)
  }
  return {
    catalog,
    setup,
    setupCatalog,
    sessionPresent,
    sessionCount: () => pool.queries.setupSessionCount(),
    clear: () => cache.clear(),
    dispose: () => cache.clear(),
  }
}

/** The opening root owns this reader and its cached answers. */
export function settingsView(pool: MobxPool): ReturnType<typeof createSettingsViews> {
  return createSettingsViews(pool)
}

/** Setup decoration and the first-task decision belong to the setup screen. */
export function readSetupSession(pool: MobxPool, id: string): Loaded<SetupSession> {
  const row = omitGone(pool.row('session', id))
  return row && row !== LOADING
    ? setupSessionSummary(
        row as unknown as Readonly<Record<string, unknown>>,
        pool.sourcePosition('session', id),
      )
    : row
}
/** Any undeleted issue: one the device holds answers at once, else the stubs (POD-7088). */
export function settingsHasFirstTask(pool: MobxPool): Loaded<boolean> {
  if (pool.heldUndeletedIssueCount > 0) return true
  const count = pool.undeletedIssueCount
  return count === LOADING ? LOADING : count > 0
}

/** What New Task picks from: the machines I may see, as plain facts, and the
 *  repositories. Facts, not live models, so a picker that renders every
 *  machine per repository reads each machine once per change (POD-2630). */
export interface SettingsCatalog {
  machines: MachineFacts[]
  repos: SettingsRows['settingsRepository'][]
}
const EMPTY_SETTINGS_CATALOG: SettingsCatalog = { machines: [], repos: [] }
const loaded = <T extends object>(row: T | symbol | undefined): row is T =>
  typeof row === 'object' && row !== null

export function readSettingsCatalog(
  pool: MobxPool,
  memo: SettingsMemo = readUncached,
): SettingsCatalog {
  const catalog = omitGone(pool.row('settingsCatalog', 'catalog'))
  if (!loaded(catalog)) return EMPTY_SETTINGS_CATALOG
  return {
    // The machines I may see: those with my own access row.
    machines: catalog.machines.flatMap((id) => {
      const machine = memo(`catalog:machine:${id}`, () => {
        const model = here(pool.model('machine', id))
        return model && model.use !== undefined ? machineFacts(model) : undefined
      })
      return machine ? [machine] : []
    }),
    repos: readCatalogRepositories(pool, catalog, memo),
  }
}

function readCatalogRepositories(
  pool: MobxPool,
  catalog: SettingsRows['settingsCatalog'],
  memo: SettingsMemo,
): SettingsRows['settingsRepository'][] {
  return catalog.repositories.flatMap((id) => {
    const row = memo(`catalog:repository:${id}`, () => omitGone(pool.row('settingsRepository', id)))
    return loaded(row) ? [row] : []
  })
}
