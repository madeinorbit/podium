/**
 * EACH MACHINE'S CHECKOUTS AS SYNCED RECORDS (POD-6644; design POD-5620 §1.12,
 * plan section A).
 *
 * The worktree list of a machine used to reach the apps only in the
 * `discovery.refreshRepos` reply, which scanned every online machine whenever a
 * client booted, a machine reconnected or a worktree changed. It is now the
 * `checkout` record: one per registered repository root and per worktree of
 * one, keyed `(machine, path)`, carrying the path, its root, its branch, its
 * repo and git's locked/prunable flags. Nothing that moves on every commit
 * (head, ahead/behind, dirty) is on it.
 *
 * WHEN A MACHINE IS SCANNED. When its daemon connects, when the server itself
 * creates, removes or moves a worktree there (an issue start, a handoff import,
 * a superagent tool), when a repository is registered or removed, and when a
 * person asks (`discovery.refreshRepos`). Each scan is compared with the stored
 * rows, and only the differences are written, with their change rows, in one
 * transaction: a scan that finds nothing new writes nothing.
 *
 * A SCAN THAT DID NOT ANSWER TELLS NOTHING. `scanRepos` resolves with no
 * repositories on its timeout, so a root the scan did not report keeps its
 * stored rows as they are. Absence is only ever read from a root the machine
 * did report (POD-1704: reading a missing answer as "none" once offered to
 * destroy live sessions).
 */

import { createLogger } from '@podium/logger'
import {
  type CheckoutWire,
  checkoutRowId,
  type GitDiscoveryDiagnosticWire,
  type GitRepositoryWire,
  type MachineId,
  machinePathKey,
  type RepoId,
} from '@podium/model'
import type { SessionStore } from '../../store'
import { type CheckoutRow, checkoutWireOf } from '../../store/checkouts'
import { normalizeRepoPath } from '../../store/repos'
import type { MachineRecordWriter } from '../machines/service'

const log = createLogger('server:checkouts')

export interface CheckoutsDeps {
  readonly store: {
    readonly checkouts: SessionStore['checkouts']
    readonly repos: Pick<SessionStore['repos'], 'listRepos' | 'updateRepoOrigin'>
    transact: SessionStore['transact']
  }
  /** Ask the machine's daemon for these roots and their worktrees. */
  scan(
    machineId: MachineId,
    roots: string[],
  ): Promise<{ repositories: GitRepositoryWire[]; diagnostics: GitDiscoveryDiagnosticWire[] }>
  /** Whether the machine's daemon is connected now (a scan asks it). */
  online(machineId: MachineId): boolean
  /** The server's own writer for the change rows. */
  writer(): MachineRecordWriter
  /** Publish the logical repos after scanned origins moved one (POD-6246). */
  publishRepos(): Promise<void>
  now(): string
}

type Spec = Parameters<MachineRecordWriter['capture']>[0][number]

/** The fields a change compares: everything on the record. */
const sameCheckout = (a: CheckoutRow, b: CheckoutRow): boolean =>
  a.root === b.root &&
  a.kind === b.kind &&
  (a.repoId ?? null) === (b.repoId ?? null) &&
  (a.branch ?? null) === (b.branch ?? null) &&
  (a.originUrl ?? null) === (b.originUrl ?? null) &&
  a.locked === b.locked &&
  a.prunable === b.prunable

/** Registered roots as the scan should see them. */
interface Registered {
  readonly path: string
  readonly repoId: RepoId | null
  readonly originUrl: string | null
}

/**
 * The checkouts one scan says a machine holds under the roots it reported, and
 * the roots it reported. Pure: `service.test.ts` drives it with fixtures.
 */
export function checkoutsFromScan(
  machineId: MachineId,
  registered: readonly Registered[],
  repositories: readonly GitRepositoryWire[],
): { rows: CheckoutRow[]; reported: Set<string> } {
  const rootKeys = new Map(registered.map((root) => [machinePathKey(root.path), root]))
  const reported = new Set<string>()
  const rows = new Map<string, CheckoutRow>()
  // A registered root that another registered root's scan lists as one of its
  // worktrees is that worktree: one path is one checkout, and the apps show it
  // under its parent (the old client dropped such standalone duplicates).
  const linked = new Set<string>()
  for (const repo of repositories) {
    const parent = machinePathKey(normalizeRepoPath(repo.path))
    // Only a main repository's listing demotes a root: a linked worktree's own
    // listing names its main repository too, which stays a root.
    if (!rootKeys.has(parent) || repo.kind === 'worktree') continue
    for (const worktree of repo.worktrees ?? []) {
      const key = machinePathKey(normalizeRepoPath(worktree.path))
      if (key !== parent) linked.add(key)
    }
  }
  for (const repo of repositories) {
    const rootPath = normalizeRepoPath(repo.path)
    const root = rootKeys.get(machinePathKey(rootPath))
    if (!root) continue
    reported.add(machinePathKey(rootPath))
    if (linked.has(machinePathKey(rootPath))) continue
    rows.set(machinePathKey(rootPath), {
      machineId,
      path: root.path,
      root: root.path,
      kind: repo.kind,
      repoId: root.repoId,
      branch: repo.branch ?? null,
      originUrl: repo.originUrl ?? root.originUrl,
      locked: false,
      prunable: false,
    })
  }
  for (const repo of repositories) {
    const root = rootKeys.get(machinePathKey(normalizeRepoPath(repo.path)))
    if (!root) continue
    for (const worktree of repo.worktrees ?? []) {
      const path = normalizeRepoPath(worktree.path)
      const key = machinePathKey(path)
      // The main worktree is the root itself; a registered root that is linked
      // here is recorded as this worktree (above).
      if (rows.has(key) || key === machinePathKey(root.path)) continue
      rows.set(key, {
        machineId,
        path,
        root: root.path,
        kind: 'worktree',
        repoId: root.repoId,
        branch: worktree.branch ?? null,
        originUrl: null,
        locked: worktree.locked === true,
        prunable: worktree.prunable === true,
      })
    }
  }
  return { rows: [...rows.values()], reported }
}

/**
 * The writes that bring `stored` to what the scan found. Roots the scan did not
 * report keep their rows; a registered root with no row gets one; a row under
 * no registered root goes.
 */
export function checkoutDiff(
  machineId: MachineId,
  registered: readonly Registered[],
  stored: readonly CheckoutRow[],
  scanned: { rows: readonly CheckoutRow[]; reported: ReadonlySet<string> },
): { upserts: CheckoutRow[]; removes: CheckoutRow[] } {
  const storedByKey = new Map(stored.map((row) => [machinePathKey(row.path), row]))
  const desired = new Map(scanned.rows.map((row) => [machinePathKey(row.path), row]))
  const registeredKeys = new Set(registered.map((root) => machinePathKey(root.path)))
  // A registered root the scan did not report still exists as a registration.
  for (const root of registered) {
    const key = machinePathKey(root.path)
    if (scanned.reported.has(key) || storedByKey.has(key)) continue
    desired.set(key, {
      machineId,
      path: root.path,
      root: root.path,
      kind: 'repository',
      repoId: root.repoId,
      branch: null,
      originUrl: root.originUrl,
      locked: false,
      prunable: false,
    })
  }
  const upserts: CheckoutRow[] = []
  const removes: CheckoutRow[] = []
  for (const [key, row] of desired) {
    const before = storedByKey.get(key)
    if (before === undefined || !sameCheckout(before, row)) upserts.push(row)
  }
  for (const [key, row] of storedByKey) {
    if (desired.has(key)) continue
    const rootKey = machinePathKey(row.root)
    // Under a root the scan answered for, or under no registered root at all.
    if (scanned.reported.has(rootKey) || !registeredKeys.has(rootKey)) removes.push(row)
  }
  return { upserts, removes }
}

export class CheckoutsService {
  /** One scan per machine at a time; a request during one runs once after it. */
  private readonly running = new Map<MachineId, Promise<GitDiscoveryDiagnosticWire[]>>()
  private readonly trailing = new Map<MachineId, Promise<GitDiscoveryDiagnosticWire[]>>()

  constructor(private readonly deps: CheckoutsDeps) {}

  /**
   * Scan the machine's registered roots and write what moved. Answers the
   * scan's diagnostics. Coalesced: a request while one runs joins one follow-up.
   */
  async rescan(machineId: MachineId): Promise<GitDiscoveryDiagnosticWire[]> {
    const current = this.running.get(machineId)
    if (current) {
      let next = this.trailing.get(machineId)
      if (!next) {
        next = current
          .catch(() => [])
          .then(async () => {
            this.trailing.delete(machineId)
            return await this.start(machineId)
          })
        this.trailing.set(machineId, next)
      }
      return await next
    }
    return await this.start(machineId)
  }

  /** {@link rescan} for a caller that does not wait (a socket attach, an event). */
  rescanSoon(machineId: MachineId): void {
    void this.rescan(machineId).catch((err: unknown) => {
      log.warn('checkout scan failed', { err, machineId })
    })
  }

  private start(machineId: MachineId): Promise<GitDiscoveryDiagnosticWire[]> {
    const run = this.scanOnce(machineId).finally(() => {
      if (this.running.get(machineId) === run) this.running.delete(machineId)
    })
    this.running.set(machineId, run)
    return run
  }

  private async registeredOn(machineId: MachineId): Promise<Registered[]> {
    return (await this.deps.store.repos.listRepos(machineId)).map((root) => ({
      path: normalizeRepoPath(root.path),
      repoId: root.repoId,
      originUrl: root.originUrl,
    }))
  }

  private async scanOnce(machineId: MachineId): Promise<GitDiscoveryDiagnosticWire[]> {
    let registered = await this.registeredOn(machineId)
    const result =
      registered.length === 0 || !this.deps.online(machineId)
        ? { repositories: [], diagnostics: [] }
        : await this.deps.scan(
            machineId,
            registered.map((root) => root.path),
          )
    // A recorded origin can move a root's repo id: the rows carry the new one.
    if (await this.recordOrigins(machineId, registered, result.repositories)) {
      registered = await this.registeredOn(machineId)
    }
    await this.reconcile(
      machineId,
      registered,
      checkoutsFromScan(machineId, registered, result.repositories),
    )
    return result.diagnostics
  }

  /**
   * The origins a scan reported for registered roots are recorded: a late or
   * changed remote upgrades a path-derived repo id, and can rename the logical
   * repo (POD-6246), which is then republished. An unchanged one does nothing.
   */
  private async recordOrigins(
    machineId: MachineId,
    registered: readonly Registered[],
    repositories: readonly GitRepositoryWire[],
  ): Promise<boolean> {
    const stored = new Map(registered.map((root) => [machinePathKey(root.path), root.originUrl]))
    let moved = false
    for (const repo of repositories) {
      if (!repo.originUrl) continue
      const key = machinePathKey(normalizeRepoPath(repo.path))
      if (!stored.has(key) || stored.get(key) === repo.originUrl) continue
      await this.deps.store.repos.updateRepoOrigin(machineId, repo.path, repo.originUrl)
      moved = true
    }
    if (moved) await this.deps.publishRepos()
    return moved
  }

  /** The registrations moved (a repo added or removed): write the roots without scanning. */
  async registrationsChanged(machineId: MachineId): Promise<void> {
    await this.reconcile(machineId, await this.registeredOn(machineId), {
      rows: [],
      reported: new Set(),
    })
  }

  private async reconcile(
    machineId: MachineId,
    registered: readonly Registered[],
    scanned: { rows: readonly CheckoutRow[]; reported: ReadonlySet<string> },
  ): Promise<void> {
    await this.deps.store.transact(async () => {
      const stored = await this.deps.store.checkouts.ofMachine(machineId)
      const { upserts, removes } = checkoutDiff(machineId, registered, stored, scanned)
      if (upserts.length === 0 && removes.length === 0) return
      await this.deps.store.checkouts.apply(upserts, removes, this.deps.now())
      const specs: Spec[] = [
        ...upserts.map(
          (row): Spec => ({
            entity: 'checkout',
            id: checkoutRowId(machineId, row.path),
            op: 'upsert',
            value: checkoutWireOf(row) satisfies CheckoutWire,
          }),
        ),
        ...removes.map(
          (row): Spec => ({ entity: 'checkout', id: checkoutRowId(machineId, row.path), op: 'remove' }),
        ),
      ]
      await this.deps.writer().capture(specs)
    })
  }

  /** Every stored checkout as the `checkout` kind's full truth (the boot reconcile). */
  async allRows(): Promise<{ id: string; value: CheckoutWire }[]> {
    return (await this.deps.store.checkouts.all()).map((row) => ({
      id: checkoutRowId(row.machineId, row.path),
      value: checkoutWireOf(row),
    }))
  }
}
