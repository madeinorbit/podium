import './synced-models'
import type { ClientRuntime } from '@podium/client-core/engine'
import type { ReplicaAddressedBatch } from '@podium/client-core/replica'
import { createDemandAtoms } from '@podium/mobx-helpers'
import { parseMachineAccessRowId } from '@podium/model'
import { compareStructural, runInAction } from 'mobx'
import { here } from './lookup'
import type { MobxPool } from './pool'
import {
  isSettingsEntity,
  SETTINGS_SCHEMA,
  type SettingsEntity,
  type SettingsRows,
} from './settings-schema'
import {
  type CheckoutRepository,
  checkoutRepositoryId,
  repositoriesFromCheckouts,
} from './shared/checkout-repositories'
import { defineSource } from './source-registry'
import { LOADING, type Loaded } from './worklist/rollup'

export type SettingsOwner = Pick<ClientRuntime, 'ui' | 'replica'>

/** Machines are feed records; repositories are derived from the `checkout`
 *  records (POD-6644). Both follow the replica's addressed batches. */
type Discovery = 'machines' | 'repos'
const ENTITY = { machines: 'settingsMachine', repos: 'settingsRepository' } as const
const KINDS: Record<Discovery, ReadonlySet<string>> = {
  machines: new Set(['machines', 'machineAccess']),
  repos: new Set(['checkouts']),
}
type Reading = Loaded<SettingsRows[SettingsEntity]>
/** The catalog's machines as a set, built once per catalog answer. */
const MEMBERSHIP = new WeakMap<readonly string[], ReadonlySet<string>>()
function membershipOf(ids: readonly string[]): ReadonlySet<string> {
  let set = MEMBERSHIP.get(ids)
  if (!set) {
    set = new Set(ids)
    MEMBERSHIP.set(ids, set)
  }
  return set
}
const REPOSITORY_INDEX = new WeakMap<
  readonly CheckoutRepository[],
  ReadonlyMap<string, CheckoutRepository>
>()
function machineIdOfAccess(id: string): string | undefined {
  try {
    return parseMachineAccessRowId(id).machineId
  } catch {
    return undefined
  }
}
type Entry = {
  entity: SettingsEntity
  id: string
  value: Reading
  release: () => void
}

/** Declared source rows load independently. Catalog demand names ids only;
 * named row and window demand never installs the other discovery payloads.
 * Observed rows follow their keys, and release their channel on unmount. */
export class SettingsSource {
  private pool: MobxPool | undefined
  private readonly rows = new Map<string, Entry>()
  private readonly atoms = createDemandAtoms<string>((key) => `settingsSource.${key}`, {
    onObserved: (key) => {
      const at = key.indexOf(':')
      const entry: Entry = {
        entity: key.slice(0, at) as SettingsEntity,
        id: key.slice(at + 1),
        value: LOADING,
        release: () => {},
      }
      this.rows.set(key, entry)
      entry.release = this.follow(entry)
      this.pending.add(key)
      this.schedule()
    },
    onUnobserved: (key) => {
      this.rows.get(key)?.release()
      this.rows.delete(key)
      this.pending.delete(key)
    },
  })
  private readonly pending = new Set<string>()
  private readonly lists = new Map<Discovery, { readers: number; stop: () => void }>()
  private window: { readers: number; stop: () => void } | undefined
  private readonly source = defineSource({
    readById: this.readById.bind(this),
    refresh: this.refresh.bind(this),
    release: this.release.bind(this),
  })
  private get disposed(): boolean {
    return this.source.disposed
  }

  constructor(private readonly owner: SettingsOwner) {}

  /** The pool whose machine rows (records joined with my access) settings reads. */
  attach(pool: MobxPool): void {
    this.pool = pool
  }

  read(entity: SettingsEntity, id: string): Reading {
    return this.source.read(entity, id) as Reading
  }

  private readById(entity: SettingsEntity, id: string): Reading {
    if (entity === 'settingsWindow') return id === 'window' ? this.owner.ui : undefined
    // Imperative questions read the runtime's existing keyed inputs directly;
    // only an observed question needs a stored source row and subscription.
    const key = `${entity}:${id}`
    if (!this.atoms.observe(key)) return this.lookup(entity, id)
    return this.rows.get(key)!.value
  }

  private follow(entry: Entry): () => void {
    switch (entry.entity) {
      case 'settingsMachine':
        return this.followList('machines')
      case 'settingsRepository':
        return this.followList('repos')
      case 'settingsCatalog': {
        if (entry.id !== 'catalog') return () => {}
        const machine = this.followList('machines'),
          repo = this.followList('repos')
        return () => {
          machine()
          repo()
        }
      }
      case 'settingsWindow':
        return () => {}
    }
  }

  private followList(name: Discovery): () => void {
    let list = this.lists.get(name)
    if (!list) {
      const stop =
        this.owner.replica.subscribeAddressedBatch?.((batch) => this.changed(name, batch)) ??
        (() => {})
      list = { readers: 0, stop }
      this.lists.set(name, list)
    }
    list.readers++
    const current = list
    return () => {
      if (--current.readers === 0) {
        current.stop()
        this.lists.delete(name)
      }
    }
  }

  /**
   * A batch touching this list's kinds re-reads the observed rows it can have
   * moved; the comparison in {@link load} keeps unchanged ones still. A machine
   * batch names its machines, so only those rows are re-read, and the catalog
   * only when one of them appeared or left. A checkout batch cannot name its
   * repository (a worktree's id does not carry its root), so it re-reads the
   * observed repositories; checkouts move rarely.
   */
  private changed(name: Discovery, batch: ReplicaAddressedBatch): void {
    if (batch.type === 'replace') {
      for (const key of this.rows.keys())
        if (key.startsWith(`${ENTITY[name]}:`) || key === 'settingsCatalog:catalog')
          this.pending.add(key)
    } else if (name === 'repos') {
      if (!batch.rows.some((row) => KINDS.repos.has(row.kind))) return
      // Re-read only the repositories whose derived facts moved, and the
      // catalog only when one appeared or left.
      const { changed, membership } = this.diffRepositories()
      for (const id of changed)
        if (this.rows.has(`settingsRepository:${id}`)) this.pending.add(`settingsRepository:${id}`)
      if (membership && this.rows.has('settingsCatalog:catalog'))
        this.pending.add('settingsCatalog:catalog')
    } else {
      const catalog = this.rows.get('settingsCatalog:catalog')
      const listed =
        catalog && catalog.value !== LOADING && catalog.value
          ? membershipOf((catalog.value as SettingsRows['settingsCatalog']).machines)
          : undefined
      for (const row of batch.rows) {
        if (!KINDS.machines.has(row.kind)) continue
        const id = row.kind === 'machineAccess' ? machineIdOfAccess(row.id) : row.id
        if (id === undefined) continue
        if (this.rows.has(`settingsMachine:${id}`)) this.pending.add(`settingsMachine:${id}`)
        if (
          catalog &&
          row.kind === 'machines' &&
          (!listed || listed.has(id) !== (this.owner.replica.row?.('machines', id) !== undefined))
        )
          this.pending.add('settingsCatalog:catalog')
      }
    }
    if (this.pending.size) this.schedule()
  }

  private repositories() {
    return repositoriesFromCheckouts(this.owner.replica.rows('checkouts'))
  }

  /** The repositories by id, built once per replica answer. */
  private repositoryIndex(): ReadonlyMap<string, CheckoutRepository> {
    const list = this.repositories()
    let index = REPOSITORY_INDEX.get(list)
    if (!index) {
      index = new Map(list.map((repo) => [checkoutRepositoryId(repo), repo]))
      REPOSITORY_INDEX.set(list, index)
    }
    return index
  }

  /** The derived repository facts last seen, as one string per repository. */
  private repositoryShapes: Map<string, string> | undefined

  /** Which repositories a checkout change moved, by comparing derived facts. */
  private diffRepositories(): { changed: string[]; membership: boolean } {
    const next = new Map(
      [...this.repositoryIndex()].map(([id, repo]) => [id, JSON.stringify(repo)]),
    )
    const previous = this.repositoryShapes
    this.repositoryShapes = next
    if (!previous) return { changed: [...next.keys()], membership: true }
    const changed: string[] = []
    let membership = previous.size !== next.size
    for (const [id, shape] of next) {
      const before = previous.get(id)
      if (before === undefined) membership = true
      if (before !== shape) changed.push(id)
    }
    for (const id of previous.keys())
      if (!next.has(id)) {
        membership = true
        changed.push(id)
      }
    return { changed, membership }
  }

  private lookup(entity: SettingsEntity, id: string): Reading {
    switch (entity) {
      case 'settingsMachine':
        return this.pool
          ? (here(this.pool.row('machine', id)) as Reading)
          : (this.owner.replica.row?.('machines', id) as Reading)
      case 'settingsRepository':
        return this.repositoryIndex().get(id)
      case 'settingsCatalog':
        return id === 'catalog'
          ? {
              machines: this.owner.replica.rows('machines').map((machine) => machine.id),
              repositories: this.repositories().map(checkoutRepositoryId),
            }
          : undefined
      case 'settingsWindow':
        return id === 'window' ? this.owner.ui : undefined
    }
  }

  private load(entry: Entry): void {
    const next = this.lookup(entry.entity, entry.id)
    // The catalog's membership, built with the catalog (a later batch reads it).
    if (entry.entity === 'settingsCatalog' && next && next !== LOADING)
      membershipOf((next as SettingsRows['settingsCatalog']).machines)
    if (compareStructural(entry.value, next)) return
    entry.value = next
    this.atoms.get(`${entry.entity}:${entry.id}`)?.reportChanged()
  }

  private schedule(): void {
    this.source.schedule()
  }

  private refresh(): void {
    runInAction(() => {
      const keys = [...this.pending]
      this.pending.clear()
      for (const key of keys) {
        const entry = this.rows.get(key)
        if (entry) this.load(entry)
      }
    })
  }

  dispose(): void {
    this.source.dispose()
  }

  private release(): void {
    const entries = [...this.rows.values()]
    const atoms = [...this.atoms.values()]
    for (const entry of entries) {
      entry.release()
      entry.release = () => {}
    }
    this.window = undefined
    this.atoms.clear()
    this.rows.clear()
    this.pending.clear()
    queueMicrotask(() =>
      runInAction(() => {
        for (const atom of atoms) atom.reportChanged()
      }),
    )
  }
}

/** Settings owns its source declaration and factory; the pool only registers it. */
export function attachSettingsSource(pool: MobxPool, owner: SettingsOwner): void {
  const source = new SettingsSource(owner)
  source.attach(pool)
  pool.sources.register(Object.keys(SETTINGS_SCHEMA).filter(isSettingsEntity), source)
}
