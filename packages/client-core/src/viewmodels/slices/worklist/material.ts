import type { GitRepositoryWire, MachineWire, SessionMeta } from '@podium/model'
import type { PinState } from '../../types'
import type { IssueNavigationModel } from '../issues'

/** Input signatures, never result equality or row caches. Arrays are compared in
 * order, including their lengths: eviction, replacement and readmission cannot
 * reuse a row from outside the current visible world. Unchanged immutable rows
 * cost one reference comparison; only changed rows need a signature. */
function orderedEqual<T>(
  previous: readonly T[] | undefined,
  next: readonly T[] | undefined,
  signature: (row: T) => string | undefined,
): boolean {
  if (previous === next) return true
  if (!previous || !next || previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index++) {
    const before = previous[index]!
    const after = next[index]!
    if (before === after) continue
    const a = signature(before)
    const b = signature(after)
    if (a === undefined || b === undefined || a !== b) return false
  }
  return true
}

/** Wire data is JSON. Fail open (derive) for malformed fixtures/extensions. */
function wireSignature(value: unknown): string | undefined {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Audited exclusions only. Row renderers and menus receive SessionMeta itself,
 * so unknown fields stay material. In particular lastActiveAt is NOT a reporting
 * clock: rows, visibility, urgency and mission continuation all consume it.
 * Agent phase, since, idle/need/error, subagents and workingMsTotal are likewise
 * visible. Only observation provenance is irrelevant to these consumers.
 * See docs/measurements/POD-4316-worklist-material.md for the dependency audit. */
export function worklistSessionSignature(session: SessionMeta): string | undefined {
  const {
    geometry: _geometry,
    geometryState: _geometryState,
    controllerId: _controllerId,
    epoch: _epoch,
    clientCount: _clientCount,
    requestsGated: _requestsGated,
    requestsDuplicate: _requestsDuplicate,
    requestsUnanswered: _requestsUnanswered,
    agentState,
    ...visible
  } = session
  if (!agentState) return wireSignature(visible)
  const {
    stateSource: _source,
    stateConfidence: _confidence,
    stateObservedAt: _observedAt,
    ...state
  } = agentState
  return wireSignature({ ...visible, agentState: state })
}

export const worklistSessionsEqual = (
  a: readonly SessionMeta[],
  b: readonly SessionMeta[],
): boolean => orderedEqual(a, b, worklistSessionSignature)

/** The slice exports the complete issue model to row cells AND action menus.
 * Keep every model field, including extensions, material. Value-identical model
 * rebuilds may hit, but no issue content is dropped to save a derivation. */
export const worklistIssuesEqual = (
  a: readonly IssueNavigationModel[],
  b: readonly IssueNavigationModel[],
): boolean => orderedEqual(a, b, wireSignature)

/** reposVisibleOnMachines reads only ids. Do not sort: a reordered scoped feed
 * is deliberately a miss even if its membership happens to be identical. */
export const worklistMachinesEqual = (
  a: readonly MachineWire[] | undefined,
  b: readonly MachineWire[] | undefined,
): boolean => orderedEqual(a, b, (machine) => wireSignature(machine.id))

/** Exactly the facts reposToViews copies/groups, plus machine SEE membership. */
export const worklistReposEqual = (
  a: readonly GitRepositoryWire[],
  b: readonly GitRepositoryWire[],
): boolean =>
  orderedEqual(a, b, (repo) =>
    wireSignature([
      repo.path,
      repo.repoId,
      repo.machineId,
      repo.originUrl,
      repo.branch,
      repo.worktrees.map((worktree) => [worktree.path, worktree.branch]),
    ]),
  )

/** Panel pins do not participate in sidebarSections. Preserve path order. */
export function worklistPinsEqual(a: PinState, b: PinState): boolean {
  return (
    a === b ||
    (orderedEqual(a.repos, b.repos, wireSignature) &&
      orderedEqual(a.worktrees, b.worktrees, wireSignature))
  )
}
