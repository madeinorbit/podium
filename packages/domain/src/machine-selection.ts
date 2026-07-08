/**
 * Pure machine-affinity selection for a repo: which online machine an agent
 * for this repo should spawn on. Structural types (not @podium/protocol's
 * MachineWire/SessionMeta) — domain is a zero-dependency leaf.
 */

export interface RepoMachines {
  machines?: { machineId: string; path: string }[]
}

export interface SelectableMachine {
  id: string
  online: boolean
}

export interface RecentSession {
  machineId?: string
  createdAt: string
}

/** Machines that have this repo, regardless of online status. */
export function machinesWithRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  const repoMachineIds = new Set((repo.machines ?? []).map((m) => m.machineId))
  return machines.filter((m) => repoMachineIds.has(m.id))
}

/** Online machines that have this repo (intersection of repo.machines and online machines). */
export function machinesForRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  return machinesWithRepo(repo, machines).filter((m) => m.online)
}

/** The machineId of the most recently created session among the given machines;
 *  undefined if none of the sessions belong to those machines. */
export function lastUsedMachine<S extends RecentSession, M extends SelectableMachine>(
  sessions: S[],
  machines: M[],
): string | undefined {
  const machineIds = new Set(machines.map((m) => m.id))
  let best: S | undefined
  for (const s of sessions) {
    if (s.machineId !== undefined && machineIds.has(s.machineId)) {
      if (best === undefined || s.createdAt > best.createdAt) {
        best = s
      }
    }
  }
  return best?.machineId
}

/** The recommended machine to open an agent on for this repo.
 *  Prefers the most-recently-used machine that also has the repo;
 *  falls back to the first online machine that has the repo; else undefined. */
export function resolveTargetMachine<S extends RecentSession, M extends SelectableMachine>(
  repo: RepoMachines,
  sessions: S[],
  machines: M[],
): string | undefined {
  const eligible = machinesForRepo(repo, machines)
  if (eligible.length === 0) return undefined
  const mru = lastUsedMachine(sessions, eligible)
  if (mru !== undefined) return mru
  return eligible[0]?.id
}
