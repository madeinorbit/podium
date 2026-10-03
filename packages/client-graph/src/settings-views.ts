import { dedupeSessionsByResume } from '@podium/model'
import { DEFAULT_HARNESS_AGENT } from '@podium/model/browser'
import { _isComputingDerivation, compareStructural, computed, onBecomeUnobserved, type IComputedValue } from 'mobx'
import { debugName } from './debug-name'
import type { MobxPool } from './pool'
import type { SetupSession } from './settings-schema'
import { LOADING } from './worklist/rollup'

/** Observed summaries suspend when settings/setup unmounts. No full-session
 * mirror or cold-row index; every value is read through the pool's one reader. */
export function createSettingsViews(pool: MobxPool) {
  const cache = new Map<string, IComputedValue<unknown>>()
  function memo<T>(key: string, read: () => T): T {
    if (!_isComputingDerivation()) return read()
    let value = cache.get(key)
    if (!value) {
      value = computed(read, { equals: compareStructural, name: debugName(() => `settings.${key}`) })
      cache.set(key, value)
      onBecomeUnobserved(value, () => cache.delete(key))
    }
    return value.get() as T
  }
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
  function setup() {
    return memo('setup', () => {
      const { rows, pending } = sessions()
      const usage = new Map<string, number>()
      let last: SetupSession | undefined
      for (const row of rows) {
        if (row.agentKind === 'shell') continue
        if (!row.headless && (!last || row.lastActiveAt > last.lastActiveAt)) last = row
        const time = Date.parse(row.lastActiveAt) || 0
        if (time <= 0) continue
        const add = (path: string) => { if (time > (usage.get(path) ?? 0)) usage.set(path, time) }
        add(row.cwd)
        for (let slash = row.cwd.indexOf('/'); slash !== -1; slash = row.cwd.indexOf('/', slash + 1)) add(row.cwd.slice(0, slash))
      }
      return { usage, defaultAgent: last?.agentKind ?? DEFAULT_HARNESS_AGENT, pending }
    })
  }
  function sessionPresent(id: string) {
    const { rows, pending } = sessions()
    return rows.some((row) => row.sessionId === id) ? true : pending ? LOADING : false
  }
  return { setup, sessions, sessionPresent, clear: () => cache.clear() }
}
