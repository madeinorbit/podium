/**
 * TESTS AND HARNESSES ONLY: machines and repositories written the way a test
 * thinks of them (a machine listing, a repository with its worktrees) turned
 * into the synced records the app receives (POD-6644): one `machine` record and
 * my own `machineAccess` row per machine, and one `checkout` record per
 * registered root and per worktree. Online and presence are not records; a
 * fixture that needs them sets them on the LiveStore.
 */
import {
  asMachineId,
  asUserId,
  type CheckoutWire,
  checkoutRowId,
  type GitRepositoryWire,
  type MachineAccessWire,
  machineAccessRowId,
  type MachineProjection,
} from '@podium/model'

/** The machine a repository lands on when the test gave it none. */
export const FIXTURE_MACHINE_ID = 'synthetic-machine'

export interface FixtureRecord {
  readonly entity: 'machine' | 'machineAccess' | 'checkout'
  readonly entityId: string
  readonly value: Record<string, unknown>
}

const PROJECTION_FIELDS = new Set<string>([
  'id',
  'name',
  'loggedOutHarnesses',
  'custodian',
  'appVersion',
  'updateChannel',
  'updateChannelOverride',
  'targetVersion',
  'versionState',
  'installKind',
])
/** Listing facts that are conditions now, never record fields. */
const CONDITION_FIELDS = new Set<string>([
  'online',
  'lastSeenAt',
  'presenceSource',
  'availability',
  'daemonReadiness',
  'serverMoveEligibility',
])

/** One machine as its two records: the shared `machine` row and my access row. */
export function machineRecords(
  userId: string,
  machine: { readonly id: string; readonly name?: string } & Record<string, unknown>,
): FixtureRecord[] {
  const projection: Record<string, unknown> = { loggedOutHarnesses: [], name: machine.id }
  const access: Record<string, unknown> = {
    use: 'granted',
    owned: true,
    transferable: true,
    unowned: false,
    adoptable: false,
    supersedable: false,
    hostname: String(machine.id),
  }
  for (const [key, value] of Object.entries(machine)) {
    if (CONDITION_FIELDS.has(key) || value === undefined) continue
    if (PROJECTION_FIELDS.has(key)) projection[key] = value
    else access[key] = value
  }
  const machineId = asMachineId(String(machine.id))
  return [
    { entity: 'machine', entityId: machineId, value: projection as MachineProjection },
    {
      entity: 'machineAccess',
      entityId: machineAccessRowId(asUserId(userId), machineId),
      value: { ...access, userId, machineId } as MachineAccessWire,
    },
  ]
}

/** One registered repository as its checkout records: the root, then each worktree. */
export function repositoryCheckouts(
  repo: Pick<GitRepositoryWire, 'path' | 'kind'> & Partial<GitRepositoryWire>,
  machineId: string = repo.machineId ?? FIXTURE_MACHINE_ID,
): FixtureRecord[] {
  const machine = asMachineId(machineId)
  const root: CheckoutWire = {
    machineId: machine,
    path: repo.path,
    root: repo.path,
    kind: repo.kind,
    ...(repo.repoId ? { repoId: repo.repoId } : {}),
    ...(repo.branch !== undefined ? { branch: repo.branch } : {}),
    ...(repo.originUrl !== undefined ? { originUrl: repo.originUrl } : {}),
  }
  const out: FixtureRecord[] = [
    { entity: 'checkout', entityId: checkoutRowId(machine, repo.path), value: root },
  ]
  for (const worktree of repo.worktrees ?? []) {
    if (worktree.path === repo.path) continue
    const row: CheckoutWire = {
      machineId: machine,
      path: worktree.path,
      root: repo.path,
      kind: 'worktree',
      ...(repo.repoId ? { repoId: repo.repoId } : {}),
      ...(worktree.branch !== undefined ? { branch: worktree.branch } : {}),
      ...(worktree.locked ? { locked: true } : {}),
      ...(worktree.prunable ? { prunable: true } : {}),
    }
    out.push({ entity: 'checkout', entityId: checkoutRowId(machine, worktree.path), value: row })
  }
  return out
}

/**
 * Several repositories as their checkout records, the way the server records a
 * scan: one record per path, and a registered root that a main repository
 * lists as its worktree is that worktree (not a second repository).
 */
export function repositoriesAsCheckouts(
  repos: readonly (Pick<GitRepositoryWire, 'path' | 'kind'> & Partial<GitRepositoryWire>)[],
  machineOf: (repo: Partial<GitRepositoryWire>) => string = (repo) => repo.machineId ?? FIXTURE_MACHINE_ID,
): FixtureRecord[] {
  const linked = new Set<string>()
  for (const repo of repos) {
    if (repo.kind === 'worktree') continue
    for (const tree of repo.worktrees ?? [])
      if (tree.path !== repo.path) linked.add(`${machineOf(repo)}\n${tree.path}`)
  }
  const out = new Map<string, FixtureRecord>()
  for (const repo of repos) {
    const machine = machineOf(repo)
    for (const record of repositoryCheckouts(repo, machine)) {
      const value = record.value as { path: string; root: string }
      const isRoot = value.path === value.root
      // A demoted root yields to its parent's worktree record; a root's own
      // listing of its main repository never replaces that root.
      if (isRoot && linked.has(`${machine}\n${value.path}`)) continue
      const held = out.get(record.entityId)
      if (held && (held.value as { path: string; root: string }).path === (held.value as { root: string }).root) continue
      out.set(record.entityId, record)
    }
  }
  return [...out.values()]
}

/** Every record for `machines` and `repos`, for a fixture's record map. */
export function machineAndRepoRecords(input: {
  readonly userId: string
  readonly machines?: readonly ({ readonly id: string } & Record<string, unknown>)[]
  readonly repos?: readonly (Pick<GitRepositoryWire, 'path' | 'kind'> & Partial<GitRepositoryWire>)[]
}): FixtureRecord[] {
  return [
    ...(input.machines ?? []).flatMap((machine) => machineRecords(input.userId, machine)),
    ...repositoriesAsCheckouts(input.repos ?? []),
  ]
}
