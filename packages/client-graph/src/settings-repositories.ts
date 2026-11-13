/**
 * SETTINGS → Projects [POD-6267].
 *
 * A row is a REPOSITORY RECORD: the logical repo the server publishes (one per
 * repo id, with its server-decided name, prefix and base branch). Nothing here
 * decides which paths belong together; the server already did.
 *
 * Its CHECKOUTS are the registered paths the machines report for it, read
 * through the pool's `repo → scans` relation. Only registered paths carry a
 * repo id: the scanner also reports every linked worktree of a registered root
 * as a scan of its own (harness discovery `withRegisteredWorktrees` →
 * `toWorktreeRepository`), with no id, so those never reach this page as
 * checkouts. A registered path that is itself a worktree of a registered root
 * on the same machine is shown inside that root, not beside it.
 *
 * A checkout's WORKTREES are what git lists for it (`worktrees` on its scan).
 */
import './requested-models'
import './synced-models'
import { companion, lazy } from '@podium/mobx-helpers'
import type { GitWorktreeWire, MachineId } from '@podium/model'
import { machinePathKey, normalizeOriginUrl } from '@podium/model/browser'
import { compareShallow } from 'mobx'
import { headerEntities } from './header-entities'
import { here } from './lookup'
import type { ModelOf } from './models'
import type { MobxPool } from './pool'
import type { RepositoryModel } from './requested-models'

/** A worktree as git lists it for a checkout. */
export type SettingsWorktree = Pick<GitWorktreeWire, 'path' | 'branch' | 'locked' | 'prunable'>

type RepoModel = ModelOf['repo']

const byName = (a: SettingsRepository, b: SettingsRepository) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key)
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)
const placeKey = (machineId: string | undefined, path: string) =>
  `${machineId ?? ''}\u0000${machinePathKey(path)}`

/** One checkout of a repository on one machine, and the worktrees git lists for it. */
export class SettingsCheckout {
  constructor(
    readonly scan: RepositoryModel,
    private readonly pool: MobxPool,
  ) {}

  // Place
  @lazy get path(): string {
    return this.scan.path
  }
  @lazy get machineId(): MachineId | null {
    return this.scan.machineId ?? null
  }
  /** The checked-out branch; absent for a detached HEAD or a bare clone. */
  @lazy get branch(): string | null {
    return this.scan.branch ?? null
  }
  @lazy get bare(): boolean {
    return this.scan.kind === 'bare'
  }
  /** A registered worktree whose root is not registered on its machine. */
  @lazy get linked(): boolean {
    return this.scan.kind === 'worktree'
  }

  // Machine
  @lazy get machineName(): string | null {
    const id = this.machineId
    return id ? (here(this.pool.model('machine', id))?.name ?? null) : null
  }
  /** `null` while the machine record is not resident. */
  @lazy get machineOnline(): boolean | null {
    const id = this.machineId
    const machine = id ? here(this.pool.model('machine', id)) : undefined
    return machine ? machine.online === true : null
  }

  // Worktrees
  /** The linked worktrees git lists for this checkout, by path. A worktree
   *  checkout's own scan repeats its siblings, so it lists none. */
  @lazy({ equals: compareShallow }) get worktrees(): readonly SettingsWorktree[] {
    return this.linked ? [] : [...(this.scan.worktrees ?? [])].sort(byPath)
  }
  /** Worktrees whose folder is gone (`git worktree prune` would drop them). */
  @lazy get missingWorktreeCount(): number {
    return this.worktrees.reduce((count, worktree) => count + (worktree.prunable ? 1 : 0), 0)
  }
}

/** One repository record: its prefix, its base branch and its checkouts. */
export class SettingsRepository {
  readonly checkout = companion((scan: RepositoryModel) => new SettingsCheckout(scan, this.pool))
  constructor(
    readonly repo: RepoModel,
    private readonly pool: MobxPool,
  ) {}

  // Identity
  @lazy get key(): string {
    return this.repo.id
  }
  @lazy get repoId(): string {
    return this.repo.id
  }
  /** Every registered path the machines report for this repository. */
  @lazy({ equals: compareShallow }) get scans(): RepositoryModel[] {
    return headerEntities(this.pool)
      .members('repo', this.repo.id, 'scans')
      .flatMap((id) => {
        const scan = here(this.pool.model('repository', id))
        return scan ? [scan] : []
      })
  }
  /** The server-decided name [POD-6246]; a checkout's own guess only until one arrives. */
  @lazy get name(): string {
    return this.repo.name || (this.checkouts[0]?.scan.name ?? '')
  }
  /** The remote as people say it (`github.com/owner/repo`); `null` for a local-only repo. */
  @lazy get origin(): string | null {
    for (const scan of this.scans) {
      const origin = normalizeOriginUrl(scan.originUrl)
      if (origin) return origin
    }
    return null
  }

  // Settings
  @lazy get prefix(): string | null {
    return this.repo.prefix ?? null
  }
  /** The repo's base branch [POD-2065]; `null` defers to the Podium default. */
  @lazy get defaultParentBranch(): string | null {
    return this.repo.defaultParentBranch ?? null
  }

  // Checkouts
  /** Registered paths, by machine then path, leaving out a registered worktree
   *  that a registered root on the same machine already lists. */
  @lazy({ equals: compareShallow }) get checkouts(): SettingsCheckout[] {
    const listed = new Set(
      this.scans.flatMap((scan) =>
        scan.kind === 'worktree'
          ? []
          : (scan.worktrees ?? []).map((tree) => placeKey(scan.machineId, tree.path)),
      ),
    )
    return this.scans
      .filter(
        (scan) => !(scan.kind === 'worktree' && listed.has(placeKey(scan.machineId, scan.path))),
      )
      .map((scan) => this.checkout(scan))
      .sort(
        (a, b) =>
          (a.machineName ?? '').localeCompare(b.machineName ?? '') || a.path.localeCompare(b.path),
      )
  }
  /** The checkout a settings write names (the server authorizes it against that
   *  checkout's machine): one on an online machine when there is one. */
  @lazy get writeCheckout(): SettingsCheckout | null {
    return (
      this.checkouts.find((checkout) => checkout.machineOnline !== false) ??
      this.checkouts[0] ??
      null
    )
  }
  @lazy get worktreeCount(): number {
    return this.checkouts.reduce((count, checkout) => count + checkout.worktrees.length, 0)
  }
}

/** The Repositories settings page: every repository a machine reports a checkout of, by name. */
export class SettingsRepositories {
  // Typed explicitly: the inferred companion type would make declaration emit
  // spell out the repo model's internal class, which it cannot name.
  readonly row: (repo: RepoModel) => SettingsRepository = companion(
    (repo: RepoModel) => new SettingsRepository(repo, this.pool),
  )
  constructor(private readonly pool: MobxPool) {}

  /** Whether the machines' repository list has arrived. Before it has, an
   *  empty list means "not yet", never "none". */
  @lazy get loaded(): boolean {
    return (
      headerEntities(this.pool).orders.has('repository') || this.pool.tables.repository.size > 0
    )
  }
  /** One row per repository record that has a checkout, by name. */
  @lazy({ equals: compareShallow }) get rows(): SettingsRepository[] {
    return [...this.pool.tables.repo.keys()]
      .flatMap((id) => {
        const repo = here(this.pool.model('repo', id))
        return repo ? [this.row(repo)] : []
      })
      .filter((row) => row.checkouts.length > 0)
      .sort(byName)
  }
  dispose() {}
}
