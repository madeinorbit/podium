/**
 * MACHINES SLICE — the three VERBS (POD-330).
 *
 * THREE VERBS, NOT A BOOLEAN (`docs/multi-user-readiness.md` §3.1.4 M1). `see`,
 * `use` and `manage` are separable, and `use` is a CODE-EXECUTION boundary
 * rather than a privacy one (M2) — running an agent on someone's machine is
 * arbitrary execution on their hardware, with their SSH keys, git identity and
 * checkouts. It must never be published as the same flag as visibility.
 *
 * UNAUTHORIZED IS NOT UNREACHABLE (M5). Both produce an empty machine list, and
 * collapsing them is the defect: "you may not run here" and "it is offline" need
 * different words in the UI and different recovery. So a refusal carries a
 * REASON, and liveness is decided once, as availability, rather than folded into
 * the population.
 *
 * The Replica never arbitrates (ADR 1 D1): nothing here DECIDES a grant. The
 * grants arrive as data from the authority and this file publishes them
 * separately instead of collapsing them into one flag.
 *
 * Depends on `@podium/model` only.
 * Platform-neutral: no DOM, no storage.
 */
import {
  machinesWithRepo,
  resolveTargetMachine,
  type RecentSession,
  type RepoMachines,
  type SelectableMachine,
} from '@podium/model'

// ---------------------------------------------------------------------------
// The three verbs.
// ---------------------------------------------------------------------------

/** §3.1.4 M1. Kept as three independent booleans on purpose: any collapse to a
 *  single flag re-creates the bug M2 exists to prevent. */
export interface MachineGrants {
  /** It exists; health/liveness; "your session ran there". */
  readonly see: boolean
  /** Spawn, reattach, attach a PTY, run harness commands, read/write files,
   *  take a worktree. A CODE-EXECUTION boundary. Owner only until granted. */
  readonly use: boolean
  /** Rename, unpair, rotate pairing token, remove from fleet. */
  readonly manage: boolean
}

/** Default-closed, per §3.1.1's rule that a missing classification must fail
 *  toward privacy. An unknown machine grants nothing. */
export const NO_MACHINE_GRANTS: MachineGrants = { see: false, use: false, manage: false }

/**
 * Why you cannot spawn on a machine right now. `unauthorized` and `unreachable`
 * are deliberately different values: they produce the same empty list and mean
 * completely different things (M5).
 */
export type MachineAvailability =
  /** Visible, `use` granted, online. */
  | 'available'
  /** Visible and `use` granted, but the host is not connected. Retry later. */
  | 'unreachable'
  /** Visible but `use` NOT granted. Waiting will not help; ask the owner. */
  | 'unauthorized'

export interface MachineView<M extends SelectableMachine = SelectableMachine> {
  readonly machine: M
  readonly grants: MachineGrants
  readonly availability: MachineAvailability
}

/**
 * Publish each machine with its verbs and its availability, keeping the two
 * separate. Machines the principal cannot even `see` are absent entirely — that
 * is the privacy boundary, and it is the only one that removes a row.
 */
export function machineViews<M extends SelectableMachine>(
  machines: readonly M[],
  grantsOf: (machine: M) => MachineGrants,
): MachineView<M>[] {
  const out: MachineView<M>[] = []
  for (const machine of machines) {
    const grants = grantsOf(machine)
    if (!grants.see) continue
    out.push({
      machine,
      grants,
      availability: !grants.use ? 'unauthorized' : machine.online ? 'available' : 'unreachable',
    })
  }
  return out
}

/** The machines a spawn/handoff may actually target. */
export function usableMachines<M extends SelectableMachine>(
  views: readonly MachineView<M>[],
): M[] {
  return views.filter((v) => v.availability === 'available').map((v) => v.machine)
}

/** Why a spawn target could not be resolved — never a bare `undefined`, so the
 *  caller can say which of the three things went wrong. */
export type SpawnTargetRefusal =
  /** No visible machine holds this repo. */
  | 'no-repo'
  /** Machines hold the repo, but the principal lacks `use` on all of them. */
  | 'unauthorized'
  /** The principal may use them; none is online. */
  | 'unreachable'

export interface SpawnTargetResolution {
  readonly machineId?: string
  readonly refusal?: SpawnTargetRefusal
}

/**
 * Recommended spawn machine, gated on `use`.
 *
 * The acceptance property: this NEVER returns a machine the principal lacks
 * `use` on. The gate is applied to the candidate set BEFORE
 * `resolveTargetMachine` sees it, rather than filtered afterwards, so there is
 * no path on which an unauthorized id is chosen and then has to be caught.
 *
 * When it refuses, it says which refusal it is — M5's "denied and offline
 * produce the same empty list otherwise".
 */
export function resolveSpawnTargetMachine<
  S extends RecentSession,
  M extends SelectableMachine,
>(
  repo: RepoMachines,
  sessions: readonly S[],
  views: readonly MachineView<M>[],
): SpawnTargetResolution {
  // Everything the principal can SEE that holds this repo — the population the
  // two refusals are distinguished within.
  //
  // `machinesWithRepo`, NOT `machinesForRepo`: the latter also filters on
  // `online`, which would fold liveness into the population and collapse
  // "unreachable" into "unauthorized" — precisely the M5 distinction this
  // function exists to preserve. Liveness is decided below, once, as
  // availability.
  const visibleWithRepo = machinesWithRepo(
    repo,
    views.map((v) => v.machine),
  )
  if (visibleWithRepo.length === 0) return { refusal: 'no-repo' }

  const byId = new Map(views.map((v) => [v.machine.id, v]))
  const withRepoViews = visibleWithRepo
    .map((m) => byId.get(m.id))
    .filter((v): v is MachineView<M> => v !== undefined)

  const useGranted = withRepoViews.filter((v) => v.grants.use)
  if (useGranted.length === 0) return { refusal: 'unauthorized' }

  const online = useGranted.filter((v) => v.availability === 'available').map((v) => v.machine)
  if (online.length === 0) return { refusal: 'unreachable' }

  const machineId = resolveTargetMachine(repo, [...sessions], online)
  return machineId === undefined ? { refusal: 'unreachable' } : { machineId }
}
