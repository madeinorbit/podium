/** Diagnostic only. Legacy and pool see one publication; only IDs, counts and
 * comparison positions leave this module. Never hydrate or observe here. */
import { missionIssueIds, missionRootFor } from '@podium/client-core/values'
import type { MissionIssueTopology } from '@podium/client-core/values'
import type { SessionView } from '@podium/client-core/session-values'
import { asIssueId } from '@podium/model/browser'
import type { MobxPool } from '../../../packages/client-graph/src/pool'
import { knownIds } from '../../../packages/client-graph/src/enumerate'
import { missions } from '../../../packages/client-graph/src/mission'
import { LOADING } from '../../../packages/client-graph/src/worklist/rollup'

export interface MissionCheckRow {
  readonly id: string
  readonly root: string | null | typeof LOADING
  readonly members: readonly string[] | typeof LOADING | null
}
export interface MissionDifference {
  readonly issueId: string
  readonly position: number | null
  readonly field: 'issue' | 'root' | 'member' | 'duplicateIssue' | 'duplicateMember'
  readonly expectedId: string | null
  readonly actualId: string | null
}
export interface MissionCheckResult {
  readonly issues: number
  readonly roots: number
  readonly memberships: number
  readonly differences: number
  readonly pending: number
  readonly first: MissionDifference | null
}

export function legacyMissionSnapshot(issues: readonly MissionIssueTopology[], sessions: readonly SessionView[]): MissionCheckRow[] {
  return issues.map(issue => {
    const root = missionRootFor(issues, asIssueId(issue.id))?.id ?? null
    return { id: issue.id, root, members: root === issue.id ? [...missionIssueIds(issues, root, sessions)].sort() : null }
  })
}

export function poolMissionSnapshot(pool: MobxPool): MissionCheckRow[] {
  const view = missions(pool)
  return knownIds(pool, 'issue').map(id => {
    const root = view.rootFor(id) ?? null
    const members = root === LOADING ? LOADING : root === id ? view.members(id) : null
    return { id, root, members: members === LOADING || members === null ? members : [...members].sort() }
  })
}

export function compareMissionSnapshots(expected: readonly MissionCheckRow[], actual: readonly MissionCheckRow[],
  onDifference?: (difference: MissionDifference) => void): MissionCheckResult {
  let differences = 0, pending = 0
  let first: MissionDifference | null = null
  const flag = (difference: MissionDifference) => { differences++; first ??= difference; onDifference?.(difference) }
  const index = (rows: readonly MissionCheckRow[]) => {
    const map = new Map<string, MissionCheckRow>()
    for (const row of rows) {
      if (map.has(row.id)) flag({ issueId: row.id, field: 'duplicateIssue', position: null, expectedId: null, actualId: row.id })
      map.set(row.id, row)
    }
    return map
  }
  const left = index(expected), right = index(actual)
  for (const id of [...new Set([...left.keys(), ...right.keys()])].sort()) {
    const e = left.get(id), a = right.get(id)
    const location = { issueId: id, position: null }
    if (!e || !a) { flag({ ...location, field: 'issue', expectedId: e?.id ?? null, actualId: a?.id ?? null }); continue }
    if (e.root === LOADING || a.root === LOADING) pending++
    else if (e.root !== a.root) flag({ ...location, field: 'root', expectedId: e.root, actualId: a.root })
    if (e.members === LOADING || a.members === LOADING) { pending++; continue }
    if (e.members === null || a.members === null) {
      if (e.members !== a.members) flag({ ...location, field: 'member', expectedId: e.members === null ? null : id, actualId: a.members === null ? null : id })
      continue
    }
    for (const rows of [e.members, a.members]) {
      const seen = new Set<string>()
      for (const [position, member] of rows.entries()) {
        if (seen.has(member)) flag({ ...location, position, field: 'duplicateMember', expectedId: null, actualId: member })
        seen.add(member)
      }
    }
    const wanted = [...e.members].sort(), got = [...a.members].sort()
    for (let position = 0; position < Math.max(wanted.length, got.length); position++) {
      if (wanted[position] !== got[position]) flag({ ...location, position, field: 'member', expectedId: wanted[position] ?? null, actualId: got[position] ?? null })
    }
  }
  return {
    issues: expected.length,
    roots: new Set(expected.flatMap(row => row.root === null || row.root === LOADING ? [] : [row.root])).size,
    memberships: expected.reduce((n, row) => n + (row.members === LOADING || row.members === null ? 0 : row.members.length), 0),
    differences, pending, first,
  }
}

export function checkMissions(pool: MobxPool, issues: readonly MissionIssueTopology[], sessions: readonly SessionView[],
  onDifference?: (difference: MissionDifference) => void): MissionCheckResult {
  return compareMissionSnapshots(legacyMissionSnapshot(issues, sessions), poolMissionSnapshot(pool), onDifference)
}
