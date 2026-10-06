import type { ReferenceState as Store } from './reference-state'
import type { MobxPool } from '@podium/client-graph/pool'
import { automationViews, type AutomationTarget, type TargetExclusions } from '@podium/client-graph/automation-views'
import { LOADING } from '@podium/client-graph/worklist/rollup'
import { compareSidebarSnapshots, type CheckSection, type SidebarSnapshot } from './sidebar-check'

export type AutomationCheckStore = Pick<Store, 'automations' | 'automationRuns' | 'repos' | 'sessions'>
export type LegacyTargets = (path: string | null) => { choices: readonly AutomationTarget[]; excluded: TargetExclusions }
const rows = (values: readonly { id: string }[]) => values.map(row => ({ id: row.id, fields: { value: row } }))

/** Uses the caller's actual legacy target policy, so it is independent of the
 * new projection. Payloads never leave this process. */
export function legacyAutomationSnapshot(state: AutomationCheckStore, targets: LegacyTargets, paths: readonly (string | null)[] = [null]): SidebarSnapshot {
  const automations = state.automations.filter(row => Reflect.get(row, 'system') !== true)
  const sections: CheckSection[] = [
    { key: 'automations', fields: {}, rows: rows(automations) },
    { key: 'runs', fields: {}, rows: state.automationRuns.map(row => ({ id: row.id, fields: {
      value: row, session: state.sessions.some(session => session.sessionId === row.sessionId) ? row.sessionId : null,
    } })) },
    { key: 'runGroups', fields: {}, rows: automations.map(row => ({ id: row.id, fields: {
      ids: state.automationRuns.filter(run => run.automationId === row.id).sort((a, b) => b.firedAt.localeCompare(a.firedAt)).map(run => run.id),
    } })) },
    { key: 'repositories', fields: { paths: [...new Set(state.repos.map(repo => repo.path))] }, rows: [] },
    ...paths.map((path, index) => ({ key: `targets:${index}`, fields: targets(path), rows: [] })),
  ]
  return { sections, pending: 0 }
}

export function poolAutomationSnapshot(pool: MobxPool, paths: readonly (string | null)[] = [null]): SidebarSnapshot {
  const view = automationViews(pool), list = view.list(), repos = view.repositories()
  let pending = list.pending + repos.pending
  const runRows = list.automationRuns.map(row => {
    const session = view.session(row.sessionId ?? undefined)
    if (session === LOADING) pending++
    return { id: row.id, pending: session === LOADING, fields: { value: row, session: session && session !== LOADING ? session.sessionId : null } }
  })
  const sections: CheckSection[] = [
    { key: 'automations', fields: {}, rows: rows(list.automations) },
    { key: 'runs', fields: {}, rows: runRows },
    { key: 'runGroups', fields: {}, rows: list.automations.map(row => ({ id: row.id, fields: { ids: list.runGroups[row.id]?.map(run => run.id) ?? [] } })) },
    { key: 'repositories', fields: { paths: [...new Set(repos.repos.map(repo => repo.path))] }, rows: [] },
    ...paths.map((path, index) => {
      const { choices, excluded, pending: loading } = view.targets(path)
      pending += loading
      return { key: `targets:${index}`, fields: { choices, excluded }, pendingFields: loading ? ['choices', 'excluded'] : [], rows: [] }
    }),
  ]
  return { sections, pending }
}

export function checkAutomations(pool: MobxPool, state: AutomationCheckStore, targets: LegacyTargets, paths?: readonly (string | null)[]) {
  const expected = legacyAutomationSnapshot(state, targets, paths), actual = poolAutomationSnapshot(pool, paths)
  const result = compareSidebarSnapshots(expected, actual)
  // Repository IDs and target keys can contain paths: retain positions only.
  return { differences: result.differences, pending: result.pending, sections: result.sections, positions: result.rows,
    first: result.first ? { section: result.first.sectionIndex, row: result.first.rowIndex, field: result.first.field } : null }
}
