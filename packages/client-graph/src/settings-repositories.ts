/**
 * SETTINGS → REPOSITORIES, ONE ROW PER REPOSITORY [POD-6267].
 *
 * The machines report one scan row per registered PATH, and a registered path
 * may be a root clone, a bare clone or a linked worktree. Listing those rows
 * as they arrived made the page a list of worktrees: a repository with forty
 * task worktrees read as forty repositories, each repeating the same prefix.
 *
 * This view groups the scans by the logical repository they belong to (the
 * server-stamped `repoId`; a scan without one stands alone), and inside a
 * repository separates its CHECKOUTS (the root clones, as a rule one per
 * machine) from the WORKTREES those checkouts have out. A registered worktree
 * whose root is not registered still shows, as a checkout, so nothing a
 * machine reports disappears from the page.
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

/** A worktree as the page lists it: the scan's own entry, or a registered worktree row. */
export type SettingsWorktree = Pick<GitWorktreeWire, 'path' | 'branch' | 'locked' | 'prunable'>

/** What a row is keyed by: the logical repository, or a scan that has none. */
type RowOwner = ModelOf['repo'] | RepositoryModel

const byName = (a: SettingsRepository, b: SettingsRepository) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.key.localeCompare(b.key)
const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)
const placeKey = (machineId: string | undefined, path: string) =>
  `${machineId ?? ''}\u0000${machinePathKey(path)}`

/** One checkout of a repository on one machine, and the worktrees it has out. */
export class SettingsCheckout {
  constructor(
    readonly scan: RepositoryModel,
    private readonly repository: SettingsRepository,
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
  /** A registered worktree standing in for a root no machine registered. */
  @lazy get linked(): boolean {
    return this.scan.kind === 'worktree'
  }

  // Machine
  @lazy get machineName(): string | null {
    const id = this.machineId
    return id ? (here(this.repository.pool.model('machine', id))?.name ?? null) : null
  }
  /** `null` while the machine record is not resident. */
  @lazy get machineOnline(): boolean | null {
    const id = this.machineId
    const machine = id ? here(this.repository.pool.model('machine', id)) : undefined
    return machine ? machine.online === true : null
  }

  // Worktrees
  /** The linked worktrees git lists for this checkout, plus registered worktree
   *  rows on its machine that no checkout lists (the first checkout there takes them). */
  @lazy({ equals: compareShallow }) get worktrees(): readonly SettingsWorktree[] {
    const listed = this.scan.kind === 'worktree' ? [] : (this.scan.worktrees ?? [])
    const strays = this.repository.straysFor(this)
    if (!strays.length) return [...listed].sort(byPath)
    const seen = new Set(listed.map((worktree) => machinePathKey(worktree.path)))
    const extra = strays.flatMap((scan) =>
      seen.has(machinePathKey(scan.path)) ? [] : [{ path: scan.path, branch: scan.branch }],
    )
    return [...listed, ...extra].sort(byPath)
  }
  /** Worktrees whose directory is gone (`git worktree prune` would drop them). */
  @lazy get missingWorktreeCount(): number {
    return this.worktrees.reduce((count, worktree) => count + (worktree.prunable ? 1 : 0), 0)
  }
}

/** One logical repository: its prefix, its base branch and every checkout of it. */
export class SettingsRepository {
  readonly checkout = companion((scan: RepositoryModel) => new SettingsCheckout(scan, this))
  constructor(
    readonly owner: RowOwner,
    private readonly section: SettingsRepositories,
    readonly pool: MobxPool,
  ) {}

  // Identity
  /** Stable React key: the repo id, else the lone scan's id. */
  @lazy get key(): string {
    return `${this.owner.entity}:${this.owner.id}`
  }
  /** The logical repository; `null` for a scan the server has not given one yet. */
  @lazy get repoId(): string | null {
    return this.owner.entity === 'repo'
      ? this.owner.id
      : ((this.owner as RepositoryModel).repoId ?? null)
  }
  /** Every scan the machines report for this repository. */
  @lazy({ equals: compareShallow }) get scans(): RepositoryModel[] {
    return this.section.scans.filter((scan) => this.section.ownerOf(scan) === this.owner)
  }
  /** The repository's name as the server decided it [POD-6246]. A scan's own
   *  guess stands in only while no name has arrived (an older server, or a
   *  scan the server has not given a repo id yet). */
  @lazy get name(): string {
    const id = this.repoId
    const named = id ? here(this.pool.model('repo', id))?.name : null
    return named || ((this.checkouts[0]?.scan ?? this.scans[0])?.name ?? '')
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
    const id = this.repoId
    return id ? (here(this.pool.model('repo', id))?.prefix ?? null) : null
  }
  /** The repo's base branch [POD-2065]; `null` defers to the Podium default. */
  @lazy get defaultParentBranch(): string | null {
    const id = this.repoId
    return id ? (here(this.pool.model('repo', id))?.defaultParentBranch ?? null) : null
  }

  // Checkouts
  /** Paths some scan of this repository lists as a linked worktree, per machine. */
  @lazy({ equals: compareShallow }) get listedWorktrees(): string[] {
    return this.scans.flatMap((scan) =>
      scan.kind === 'worktree'
        ? []
        : (scan.worktrees ?? []).map((worktree) => placeKey(scan.machineId, worktree.path)),
    )
  }
  /** Root and bare clones, by machine then path. A registered worktree on a
   *  machine where no root of this repository is registered has nowhere to
   *  nest, so it stands as a checkout itself. */
  @lazy({ equals: compareShallow }) get checkouts(): SettingsCheckout[] {
    const roots = this.scans.filter((scan) => scan.kind !== 'worktree')
    const rooted = new Set(roots.map((scan) => scan.machineId ?? null))
    const listed = new Set(this.listedWorktrees)
    const loose = this.scans.filter(
      (scan) =>
        scan.kind === 'worktree' &&
        !rooted.has(scan.machineId ?? null) &&
        !listed.has(placeKey(scan.machineId, scan.path)),
    )
    return [...roots, ...loose]
      .map((scan) => this.checkout(scan))
      .sort(
        (a, b) =>
          (a.machineName ?? '').localeCompare(b.machineName ?? '') || a.path.localeCompare(b.path),
      )
  }
  /** Registered worktree rows on `checkout`'s machine that are not themselves a
   *  checkout. Only the first checkout on that machine takes them. */
  straysFor(checkout: SettingsCheckout): RepositoryModel[] {
    const first = this.checkouts.find((row) => row.machineId === checkout.machineId)
    if (first !== checkout) return []
    const shown = new Set(this.checkouts.map((row) => row.scan))
    return this.scans.filter(
      (scan) =>
        scan.kind === 'worktree' &&
        !shown.has(scan) &&
        (scan.machineId ?? null) === checkout.machineId,
    )
  }
  /** The checkout a settings write names (the server resolves its repository
   *  from it): one on an online machine when there is one. */
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

/** The Repositories settings page: every repository any machine reports, by name. */
export class SettingsRepositories {
  readonly row = companion((owner: RowOwner) => new SettingsRepository(owner, this, this.pool))
  constructor(private readonly pool: MobxPool) {}

  /** Every scan row, in the feed's order. */
  @lazy({ equals: compareShallow }) get scans(): RepositoryModel[] {
    return (
      headerEntities(this.pool).orders.get('repository') ?? [...this.pool.tables.repository.keys()]
    ).flatMap((id) => {
      const model = here(this.pool.model('repository', id))
      return model ? [model] : []
    })
  }
  /** Whether the machines' repository list has arrived. Before it has, an
   *  empty list means "not yet", never "none". */
  @lazy get loaded(): boolean {
    return (
      headerEntities(this.pool).orders.has('repository') || this.pool.tables.repository.size > 0
    )
  }
  /** The row a scan belongs to: its logical repository when that record is
   *  resident, else the first scan reporting the same repo id, else itself. */
  ownerOf(scan: RepositoryModel): RowOwner {
    const id = scan.repoId
    if (!id) return scan
    return (
      here(this.pool.model('repo', id)) ?? this.scans.find((other) => other.repoId === id) ?? scan
    )
  }
  /** One row per repository, by name. */
  @lazy({ equals: compareShallow }) get rows(): SettingsRepository[] {
    const owners = new Set<RowOwner>()
    for (const scan of this.scans) owners.add(this.ownerOf(scan))
    return [...owners].map((owner) => this.row(owner)).sort(byName)
  }
  dispose() {}
}
