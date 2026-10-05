import { keyedComputed } from '@podium/mobx-helpers'
import { dedupeSessionsByResume } from '@podium/model'
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import { compareStructural } from 'mobx'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import type { SetupSession } from './settings-schema'
import { LOADING } from './worklist/rollup'

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
  function sessions() {
    return memo('sessions', () => {
      const rows: SetupSession[] = []
      let pending = 0
      for (const id of pool.queries.ids({ kind: 'setupSessions' })) {
        const row = memo(`session:${id}`, () => pool.row('setupSession', id))
        if (row === LOADING) pending++
        else if (row) rows.push(row)
      }
      // Source positions preserve legacy ties even across a mixed cold/hot
      // partition. Sorting this temporary summary result creates no index.
      rows.sort((a, b) => a.setupOrder - b.setupOrder)
      return { rows: dedupeSessionsByResume(rows), pending }
    })
  }
  function setup(paths: readonly string[] = []) {
    return memo(`setup:${JSON.stringify(paths)}`, () => {
      const usage = new Map<string, number>()
      for (const path of paths) {
        const at = pool.queries.activity({ kind: 'commandRootActivity', roots: [path], agentsOnly: true })
        if (at > 0) usage.set(path, at)
      }
      return { usage, defaultAgent: pool.queries.setupDefaultAgent() ?? DEFAULT_HARNESS_AGENT, pending: 0 }
    })
  }
  function sessionPresent(id: string) {
    return pool.queries.setupSessionPresent(id)
  }
  return { setup, sessions, sessionPresent, sessionCount: () => pool.queries.setupSessionCount(), clear: () => cache.clear() }
}
