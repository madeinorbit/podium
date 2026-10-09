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
function createSettingsViews(pool: MobxPool) {
  // Summaries build fresh arrays/records; equal answers must not wake consumers.
  const cache = keyedComputed(
    (key: string) => debugName(() => `settings.${key}`),
    (_key: string, read: () => unknown) => read(),
    { equals: compareStructural },
  )
  const memo = <T>(key: string, read: () => T): T => cache(key, read) as T
  function sessions() {
    return pool.queries.summarize(
      { kind: 'setupSessions' }, 'settings.sessions', (id) => omitGone(pool.row('setupSession', id)), {
        // Resume winners occupy their group's first source position, including
        // ties across cold/hot partitions. Headless rows remain independent.
        order: (id) => String(pool.sourcePosition('session', id) ?? 0).padStart(16, '0'),
        collapse: {
          key: (row) => row.resume && !row.headless
            ? JSON.stringify([row.resume.kind, row.resume.value]) : undefined,
          keepsGroup: (row) => ['live', 'starting', 'reconnecting'].includes(row.status),
          compare: (a, b) => resumeRank(b) - resumeRank(a) ||
            (a.lastActiveAt > b.lastActiveAt ? -1 : a.lastActiveAt < b.lastActiveAt ? 1 : 0),
        },
      },
    )
  }
  function setup(paths: readonly string[] = []) {
    return memo(`setup:${JSON.stringify(paths.map(machinePathKey))}`, () => {
      const usage = new Map<string, number>()
      for (const path of paths) {
        const at = pool.queries.activity({ kind: 'commandRootActivity', roots: [path], agentsOnly: true })
        if (at > 0) usage.set(machinePathKey(path), at)
      }
      return { usage, defaultAgent: pool.queries.setupDefaultAgent() ?? DEFAULT_HARNESS_AGENT, pending: 0 }
    })
  }
  function sessionPresent(id: string) {
    return pool.queries.setupSessionPresent(id)
  }
  return { setup, sessions, sessionPresent, sessionCount: () => pool.queries.setupSessionCount(), clear: () => cache.clear() }
}

/** The screen registry owns creation and teardown of this view. */
export function settingsView(pool: MobxPool): ReturnType<typeof createSettingsViews> & { dispose(): void } {
  return pool.sources.view('settings.views', () => {
    const view = createSettingsViews(pool)
    return Object.assign(view, { dispose: () => view.clear() })
  })
}

/** Setup decoration and the first-task decision belong to the setup screen. */
export function readSetupSession(pool: MobxPool, id: string): Loaded<SetupSession> {
  const row = omitGone(pool.row('session', id, 'summary-fields'))
  return row && row !== LOADING
    ? setupSessionSummary(row as unknown as Readonly<Record<string, unknown>>, pool.sourcePosition('session', id))
    : row
}
function resumeRank(row: SetupSession): number {
  return row.status === 'live' ? 3 : row.status === 'starting' || row.status === 'reconnecting'
    ? 2 : row.status === 'hibernated' ? 1 : 0
}
export function settingsHasFirstTask(pool: MobxPool): Loaded<boolean> {
  return pool.undeletedIssueCount > 0
}
