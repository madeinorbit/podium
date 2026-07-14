/** Pure machine-affinity and handoff target selection. */
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

/** Online machines that have this repo. */
export function machinesForRepo<M extends SelectableMachine>(
  repo: RepoMachines,
  machines: M[],
): M[] {
  return machinesWithRepo(repo, machines).filter((m) => m.online)
}

export interface HandoffSession {
  cwd: string
  machineId?: string
  agentKind: string
}
export interface HandoffRepo extends RepoMachines {
  repoId?: string
  worktrees: { path: string; isMain: boolean; machineId?: string }[]
}
export interface HandoffMachine extends SelectableMachine {
  inventory?: {
    agents: { kind: string; installed: boolean; login: { state: 'in' | 'out' | 'unknown' } }[]
  }
}

/** Eligible move targets for a worktree session ([spec:SP-3f7a]). */
export function handoffTargets<M extends HandoffMachine>(
  session: HandoffSession,
  repos: HandoffRepo[],
  machines: M[],
): M[] {
  if (session.agentKind !== 'claude-code' && session.agentKind !== 'codex') return []
  const repo = repos.find((candidate) =>
    candidate.worktrees.some(
      (worktree) =>
        worktree.path === session.cwd &&
        !worktree.isMain &&
        (session.machineId === undefined || worktree.machineId === session.machineId),
    ),
  )
  if (!repo?.repoId) return []
  return machinesWithRepo(repo, machines).filter((machine) => {
    if (!machine.online || machine.id === session.machineId) return false
    const harness = machine.inventory?.agents.find((agent) => agent.kind === session.agentKind)
    return harness?.installed === true && harness.login.state !== 'out'
  })
}

/** The machineId of the most recently created session among the given machines. */
export function lastUsedMachine<S extends RecentSession, M extends SelectableMachine>(
  sessions: S[],
  machines: M[],
): string | undefined {
  const machineIds = new Set(machines.map((m) => m.id))
  let best: S | undefined
  for (const s of sessions) {
    if (s.machineId !== undefined && machineIds.has(s.machineId)) {
      if (best === undefined || s.createdAt > best.createdAt) best = s
    }
  }
  return best?.machineId
}

/** Recommended machine: most recently used eligible machine, then first eligible. */
export function resolveTargetMachine<S extends RecentSession, M extends SelectableMachine>(
  repo: RepoMachines,
  sessions: S[],
  machines: M[],
): string | undefined {
  const eligible = machinesForRepo(repo, machines)
  if (eligible.length === 0) return undefined
  return lastUsedMachine(sessions, eligible) ?? eligible[0]?.id
}
