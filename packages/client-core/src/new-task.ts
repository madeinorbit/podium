import type { GitRepositoryWire, MachineWire } from '@podium/model/browser'
import { machinePathKey, preferredMachineChoices } from '@podium/model/browser'
import {
  type ActivationAgentReadiness,
  AGENT_NOT_READY_COPY,
  signInInTerminalCopy,
} from './values/agent-readiness'
import { machineViewsFromWire, usableMachines } from './values/compose/machines/authority'
import { reposToViews } from './values/compose/machines/facts'
import { indexedRepoUsageAt } from './values/repository-usage'
import type { RepoView } from './values/types'

/**
 * WHICH CHECKOUT ON DISK A PICKER ENTRY MEANS (POD-1582).
 *
 * A picker entry is a repo IDENTITY, not a directory: `reposToViews` groups by
 * `repoId`, which is derived from the origin URL alone, so two clones of one
 * origin on one machine arrive as a single entry carrying two `machines[]` rows
 * with the same `machineId`. Something has to choose between them, and the two
 * ways to get that wrong are both live:
 *
 *  - SCAN ORDER. `find` took whichever row the scanner happened to append
 *    first, so which clone a mission was created in could change between
 *    refreshes. The candidates are sorted, so the answer is at least the same
 *    answer twice.
 *  - THE OPERATOR'S OWN CHOICE. A draft's `repoPath` may already name one of
 *    those checkouts — that is how `selectedRepo` matched the entry. `prefer`
 *    honours it, which is the only way the second clone is reachable at all
 *    until the picker offers both (POD-1629).
 *
 * Returns undefined when the identity has no non-worktree checkout on that
 * machine; every caller treats that as "cannot launch here" rather than as a
 * repo that merely needs setup.
 */
export function checkoutForMachine(
  repos: GitRepositoryWire[],
  repo: RepoView,
  machineId: string | undefined,
  prefer?: string,
): GitRepositoryWire | undefined {
  const onMachine = (repo.machines ?? [])
    .filter((candidate) => machineId === undefined || candidate.machineId === machineId)
    .map((candidate) => candidate.path)
    .sort()
  const ordered = [
    ...(prefer !== undefined && onMachine.includes(prefer) ? [prefer] : []),
    ...onMachine,
    repo.path,
  ]
  for (const path of ordered) {
    const found = repos.find(
      (candidate) =>
        candidate.kind !== 'worktree' &&
        candidate.path === path &&
        (machineId === undefined || candidate.machineId === machineId),
    )
    if (found) return found
  }
  return undefined
}

export function promptTitle(prompt: string): string {
  const firstLine = prompt
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  return (firstLine ?? prompt.trim()).slice(0, 120)
}

/** Optional instructions for coordinating a complex epic. */
export const COORDINATOR_PROMPT =
  'This is a complex epic. You are the designated coordinator. Organize your work accordingly. Check with me on key decisions.'

/** Words, as a person counts them: runs of non-space. */
export function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/** Stable identity across live project names and checkout metadata. */
export function firstTaskRepositoryIdentity(repo: RepoView): string {
  return (
    repo.repoId ??
    (repo.originUrl ||
      JSON.stringify([repo.machines?.[0]?.machineId ?? '', machinePathKey(repo.path)]))
  )
}

/** Projects the desktop composer can launch, most recent agent activity first. */
export function firstTaskRepositoryChoices(repos: GitRepositoryWire[]): RepoView[] {
  return reposToViews(repos).filter(
    (view) => checkoutForMachine(repos, view, undefined) !== undefined,
  )
}

export function rankFirstTaskRepositories(
  repos: GitRepositoryWire[],
  repositoryUsage: ReadonlyMap<string, number>,
  choices: readonly RepoView[] = firstTaskRepositoryChoices(repos),
): RepoView[] {
  const usage = new Map<string, number>()
  for (const repo of repos) usage.set(repo.path, indexedRepoUsageAt(repo, repositoryUsage))
  const usageFor = (view: RepoView): number =>
    Math.max(
      usage.get(view.path) ?? 0,
      ...(view.machines ?? []).map(({ path }) => usage.get(path) ?? 0),
    )
  return [...choices].sort(
    (a, b) =>
      usageFor(b) - usageFor(a) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  )
}

/** A project's aliases refer to one choice, even across machines. */
export function selectedFirstTaskRepository(
  choices: readonly RepoView[],
  path: string,
): RepoView | undefined {
  return (
    choices.find(
      (repo) => repo.path === path || repo.machines?.some((checkout) => checkout.path === path),
    ) ?? choices[0]
  )
}

export function firstTaskMachines(
  repo: RepoView | undefined,
  machines: MachineWire[],
): MachineWire[] {
  const ids = new Set(repo?.machines?.map((checkout) => checkout.machineId) ?? [])
  const preferred = preferredMachineChoices(machines)
  return ids.size ? preferred.filter((machine) => ids.has(machine.id)) : preferred
}

/** A pick in this opening wins; a remembered offline default does not. */
export function selectedFirstTaskMachine(
  candidates: readonly MachineWire[],
  remembered: string,
  picked?: string,
  machines: readonly MachineWire[] = candidates,
): MachineWire | undefined {
  const views = machineViewsFromWire(machines)
  const usable = new Set(usableMachines(views).map((machine) => machine.id))
  const authorized = new Set(
    views.filter((view) => view.availability !== 'unauthorized').map((view) => view.machine.id),
  )
  return (
    candidates.find((machine) => machine.id === picked) ??
    candidates.find((machine) => machine.id === remembered && usable.has(machine.id)) ??
    candidates.find((machine) => usable.has(machine.id)) ??
    candidates.find((machine) => machine.id === remembered) ??
    candidates.find((machine) => authorized.has(machine.id)) ??
    candidates[0]
  )
}

export function firstTaskMachineDenied(
  machine: MachineWire | undefined,
  machines: readonly MachineWire[],
): boolean {
  return (
    machine !== undefined &&
    machineViewsFromWire(machines).some(
      (view) => view.machine.id === machine.id && view.availability === 'unauthorized',
    )
  )
}

/** The desktop compose footnotes, in their existing precedence and wording. */
export function firstTaskLaunchNote(args: {
  machineDenied: boolean
  signInFirst: boolean
  ready: boolean
  hasCheckout: boolean
  readiness: ActivationAgentReadiness
  agentLabel: string
  projectLabel: string
  machineLabel: string
}): string | undefined {
  if (args.machineDenied)
    return 'You do not have access to run work on this machine. Ask its owner for access, or pick another machine.'
  if (args.signInFirst) return signInInTerminalCopy(args.readiness, args.agentLabel)
  if (args.ready) return undefined
  return args.hasCheckout
    ? AGENT_NOT_READY_COPY
    : `${args.projectLabel} is not checked out on ${args.machineLabel}. Pick another machine, or clone it there first.`
}
