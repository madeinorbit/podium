/**
 * POD-4746 — the changed item's own neighbourhood, computed from the corpus.
 *
 * The scale check (`scale-check.ts`) lets a change's work grow from 1x to 4x
 * only by the size of the neighbourhood of what it changed: the rows a correct
 * store may have to touch to handle it. Nothing here is typed in; it is read
 * off the engine store and the oracle's order, before and after the write:
 *
 * - THE CHANGED ITEMS: the rows the step's feed events name, and the rows
 *   whose row view the oracle changed, entered or left (a locals-only step,
 *   a click or a tick, names its rows only through the oracle).
 * - THE FAMILY of each changed issue (a session stands for its issue): the
 *   issue and every ancestor, and for each of them its direct children and
 *   its sessions. A roll-up that re-reads a level's siblings stays inside it.
 * - THE GROUPS a MOVED row leaves and enters: when a changed issue's place in
 *   the list differs (it entered, left, changed section, has a different
 *   neighbour, or its section moved among the sections), every row of its
 *   section before and after (a project group's open lane and closed fold, or
 *   the pinned section). A placement that scans the lane it lands in stays
 *   inside it; a re-sort of the whole list does not.
 *
 * Both states are measured and the union taken, so a row that leaves one
 * family for another (a reparent) has both.
 */

import type { SliceOrder } from '../../shared/src/slice-types'

/** One side of a step, as the neighbourhood reads it. */
export interface NeighbourhoodState {
  /** Issue rows with their parent link (the store's `issueProjections`). */
  issues: readonly { id: string; parentId?: string | null }[]
  /** Session rows with their issue (the store's `sessions`). */
  sessions: readonly { sessionId: string; issueId?: string | null }[]
  /** The oracle's list order in this state (`snapshotFromStore(…).order`). */
  order: SliceOrder
}

export interface Neighbourhood {
  /** `issue:<id>` / `session:<id>` / `worktree:<path>` keys. */
  members: ReadonlySet<string>
  /** Changed issues whose place in the list moved (their sections are in `members`). */
  moved: readonly string[]
}

interface Indexed {
  parentOf: Map<string, string>
  childrenOf: Map<string, string[]>
  sessionsOf: Map<string, string[]>
  issueOfSession: Map<string, string>
  /** Row id → its section's key, the section's place among the sections, and its neighbours. */
  placeOf: Map<string, string>
  /** Section key → its row ids. */
  sections: Map<string, readonly string[]>
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [value])
  else list.push(value)
}

function indexed(state: NeighbourhoodState): Indexed {
  const parentOf = new Map<string, string>()
  const childrenOf = new Map<string, string[]>()
  for (const issue of state.issues) {
    if (typeof issue.parentId !== 'string' || issue.parentId.length === 0) continue
    parentOf.set(issue.id, issue.parentId)
    push(childrenOf, issue.parentId, issue.id)
  }
  const sessionsOf = new Map<string, string[]>()
  const issueOfSession = new Map<string, string>()
  for (const session of state.sessions) {
    if (typeof session.issueId !== 'string' || session.issueId.length === 0) continue
    issueOfSession.set(session.sessionId, session.issueId)
    push(sessionsOf, session.issueId, session.sessionId)
  }
  const placeOf = new Map<string, string>()
  const sections = new Map<string, readonly string[]>()
  const place = (key: string, ids: readonly string[]): void => {
    const at = sections.size
    sections.set(key, ids)
    ids.forEach((id, index) => {
      placeOf.set(id, `${key}|${at}|${ids[index - 1] ?? ''}|${ids[index + 1] ?? ''}`)
    })
  }
  place('pinned', state.order.pinnedIds)
  for (const group of state.order.groups) {
    place(`group:${group.key}:open`, group.rowIds)
    place(`group:${group.key}:closed`, group.closedIds)
  }
  return { parentOf, childrenOf, sessionsOf, issueOfSession, placeOf, sections }
}

/** The family of `issueId` in one state: its chain, and each level's children and sessions. */
function addFamily(index: Indexed, issueId: string, members: Set<string>): void {
  const seen = new Set<string>()
  let current: string | undefined = issueId
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    members.add(`issue:${current}`)
    for (const child of index.childrenOf.get(current) ?? []) members.add(`issue:${child}`)
    for (const session of index.sessionsOf.get(current) ?? []) members.add(`session:${session}`)
    current = index.parentOf.get(current)
  }
}

/**
 * The neighbourhood of a step's changed items. `named` are `kind:id` keys (the
 * feed events' rows); `rows` are row (issue) ids the oracle changed, entered
 * or left.
 */
export function neighbourhoodOf(
  before: NeighbourhoodState,
  after: NeighbourhoodState,
  named: Iterable<string>,
  rows: Iterable<string>,
): Neighbourhood {
  const states = [indexed(before), indexed(after)]
  const members = new Set<string>()
  const issues = new Set<string>(rows)
  for (const key of named) {
    members.add(key)
    const at = key.indexOf(':')
    const kind = key.slice(0, at)
    const id = key.slice(at + 1)
    if (kind === 'issue') issues.add(id)
    if (kind === 'session') {
      for (const state of states) {
        const issue = state.issueOfSession.get(id)
        if (issue !== undefined) issues.add(issue)
      }
    }
  }
  const moved: string[] = []
  for (const issue of issues) {
    for (const state of states) addFamily(state, issue, members)
    const [was, is] = states.map((state) => state.placeOf.get(issue))
    if (was === is) continue
    moved.push(issue)
    for (const [state, place] of [
      [states[0]!, was],
      [states[1]!, is],
    ] as const) {
      if (place === undefined) continue
      const section = state.sections.get(place.slice(0, place.indexOf('|'))) ?? []
      for (const id of section) members.add(`issue:${id}`)
    }
  }
  return { members, moved: moved.sort() }
}
