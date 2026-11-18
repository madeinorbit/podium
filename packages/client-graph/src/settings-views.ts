import { omitGone } from './lookup'
import { keyedComputed } from '@podium/mobx-helpers'
import { DEFAULT_HARNESS_AGENT, machinePathKey } from '@podium/model/browser'
import { compareStructural } from 'mobx'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import { setupSessionSummary, type SetupSession } from './settings-schema'
import { LOADING, type Loaded } from './worklist/rollup'

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
  function setup(paths: readonly string[] = []) {
    return memo(`setup:${JSON.stringify(paths.map(machinePathKey))}`, () => {
      const usage = new Map<string, number>()
      for (const path of paths) {
        const at = pool.queries.activity({
          kind: 'commandRootActivity',
          roots: [path],
          agentsOnly: true,
        })
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
  return {
    setup,
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
  const row = omitGone(pool.row('session', id, 'summary-fields'))
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
