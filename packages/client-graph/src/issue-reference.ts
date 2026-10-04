import {
  canonicalIssueRef,
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/values'
import { parseAnyRef } from '@podium/protocol'
import {
  compareStructural,
  computed,
  type IComputedValue,
  type ObservableMap,
  observable,
  observe,
  onBecomeUnobserved,
  reaction,
  runInAction,
} from 'mobx'
import { seedIssueReferences } from './enumerate'
import type { RelationReader } from './shared/relation-reader'
import type { StoredRow } from './tables'
import { LOADING, type Loaded } from './worklist/rollup'

export function issueRefKey(token: string): string {
  if (/^#\d+$/.test(token.trim())) return `#${Number(token.trim().slice(1))}`
  const parsed = parseAnyRef(token.trim())
  return parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : token.trim()
}

/** Only the existing pool supplies rows and relations. No viewmodel list,
 * replica, old-record read or mutation owner is accepted by this seam. */
export interface IssueReferenceHost {
  row(entity: 'issue' | 'repo', id: string): Loaded<object>
  readonly tables: { readonly issue: ObservableMap<string, StoredRow> }
  readonly relations: Pick<RelationReader, 'one'>
}

export interface IssueReferenceReader {
  read(token: string): Loaded<IssueReferenceModel | null>
  id(token: string): Loaded<string | null>
}

/** One resident-only key index per pool. Each resident row tracks only its
 * own identity and declared repo relation. Cold rows never enter this index.
 * Unresolved keys use the pool's load window, not a list scan or a peek. */
export class IssueReferences implements IssueReferenceReader {
  private readonly resident = observable.map<string, readonly string[]>(undefined, { deep: false })
  // Demand responses exist only for keys asked for by readers. This is not an
  // index over cold rows or their summaries. A loaded key wins immediately.
  private readonly requests = observable.map<string, string | null | typeof LOADING>(undefined, {
    deep: false,
  })
  private readonly stops = new Map<string, () => void>()
  private readonly values = new Map<string, IComputedValue<Loaded<IssueReferenceModel | null>>>()
  private readonly stopTable: () => void
  private orderedBareAliases = false

  /** Enabled once by the phone source before its readers mount. A resident
   * claimant can have an earlier cold twin, so bare aliases demand the same
   * batched authority lookup instead of borrowing the warmed row's position. */
  requireOrderedBareAliases(): void {
    this.orderedBareAliases = true
  }
  /** A replacement changes the visible scope. Only unresolved demand keys
   * need a fresh replica answer; resident subscriptions stay untouched. */
  resetUnresolved(): void {
    runInAction(() => {
      // Preserve the value atoms an already-loading chip observes. Replacing
      // the map entry with another LOADING entry would leave that derivation
      // observing the removed atom until its displayed value changes.
      for (const key of this.requests.keys()) {
        this.requests.set(key, LOADING)
        this.queue(key)
      }
    })
  }

  /** An arriving cold row can satisfy a previously missing demand key.
   * Refresh only that key inside the pool's publication action. */
  arrived(
    row: Pick<IssueReferenceSource, 'prefix' | 'displayRef' | 'seq'> & { repoId?: string | null },
  ): void {
    // Normalized projections carry repoId and seq, not a derived prefix.
    // Use the same resident repo join as source(), without warming this issue.
    const repo = row.repoId ? this.host.row('repo', row.repoId) : undefined
    if (repo === LOADING) return
    const prefix = (repo as { prefix?: string | null } | undefined)?.prefix ?? row.prefix
    const ref = row.repoId
      ? prefix
        ? `${prefix}-${row.seq}`
        : `#${row.seq}`
      : canonicalIssueRef(row)
    const key = issueRefKey(ref)
    if (!this.requests.has(key)) return
    this.requests.set(key, LOADING)
    this.queue(key)
  }

  constructor(
    private readonly host: IssueReferenceHost,
    private readonly queue: (ref: string) => void,
  ) {
    this.stopTable = observe(host.tables.issue, (change) => {
      if (change.type === 'add') this.track(change.name)
      if (change.type === 'delete') this.untrack(change.name)
    })
    // The only enumeration, when attaching to an already seeded pool. All
    // subsequent maintenance follows one changed resident table slot.
    seedIssueReferences(host.tables, (id) => this.track(id))
  }

  private source(id: string): Loaded<IssueReferenceSource> {
    const row = this.host.row('issue', id)
    if (row === LOADING || row === undefined) return row
    const issue = row as IssueReferenceSource
    const repoId = this.host.relations.one('issue', id, 'repo')
    const repo = repoId === null ? undefined : this.host.row('repo', repoId)
    if (repo === LOADING) return LOADING
    const prefix = (repo as { prefix?: string | null } | undefined)?.prefix ?? issue.prefix
    return {
      id: issue.id,
      seq: issue.seq,
      title: issue.title,
      stage: issue.stage,
      archived: issue.archived,
      deletedAt: issue.deletedAt,
      ...(prefix ? { prefix } : {}),
      // The repo relation owns canonical identity after normalization. A
      // temporary pre-projection input can still carry a real displayRef.
      displayRef:
        repoId !== null ? (prefix ? `${prefix}-${issue.seq}` : `#${issue.seq}`) : issue.displayRef,
    }
  }

  private track(id: string): void {
    if (this.stops.has(id)) return
    let previous: string | undefined
    const stop = reaction(
      () => {
        const row = this.source(id)
        return row === LOADING || row === undefined
          ? undefined
          : issueRefKey(canonicalIssueRef(row))
      },
      (key) =>
        runInAction(() => {
          if (previous !== undefined) this.release(previous, id)
          previous = key
          if (key !== undefined) {
            // Replica.rows() orders by row ID. Keep all resident claimants in
            // the same index so a load arriving late cannot steal an earlier
            // alias, and eviction hands it to the next owner without a scan.
            const owners = [...(this.resident.get(key) ?? []), id].sort((a, b) =>
              a < b ? -1 : a > b ? 1 : 0,
            )
            this.resident.set(key, owners)
            this.requests.delete(key)
          }
        }),
      { fireImmediately: true },
    )
    this.stops.set(id, () => {
      stop()
      if (previous !== undefined) this.release(previous, id)
    })
  }

  private release(key: string, id: string): void {
    const owners = (this.resident.get(key) ?? []).filter((owner) => owner !== id)
    if (owners.length) this.resident.set(key, owners)
    else this.resident.delete(key)
    if (this.orderedBareAliases && key.startsWith('#')) this.requests.delete(key)
  }

  private untrack(id: string): void {
    this.stops.get(id)?.()
    this.stops.delete(id)
    this.values.delete(id)
  }

  id(token: string): Loaded<string | null> {
    if (parseAnyRef(token.trim())?.kind !== 'issue' && !/^#\d+$/.test(token.trim())) return null
    const key = issueRefKey(token)
    const resident = this.resident.get(key)?.[0]
    const orderedBare = this.orderedBareAliases && key.startsWith('#')
    if (resident !== undefined && !orderedBare) return resident
    const pending = this.requests.get(key)
    if (pending !== undefined) {
      if (typeof pending !== 'string')
        return pending === null && orderedBare ? (resident ?? null) : pending
      const model = this.readById(pending)
      // A prefix change cannot bind an old token to the row's new identity.
      if (model === LOADING) return LOADING
      if (model && issueRefKey(model.ref) === key)
        return orderedBare && resident !== undefined && resident < pending ? resident : pending
      return orderedBare ? (resident ?? null) : null
    }
    // A read never blocks. Repeated chips of the same token enqueue it once.
    runInAction(() => this.requests.set(key, LOADING))
    this.queue(key)
    // Track the value atom created above too. A reference that becomes
    // unresolved during a reaction must observe its later batch response.
    return this.requests.get(key)
  }

  read(token: string): Loaded<IssueReferenceModel | null> {
    const id = this.id(token)
    if (id === LOADING || id === null || id === undefined) return id
    return this.readById(id)
  }

  readById(id: string): Loaded<IssueReferenceModel | null> {
    let value = this.values.get(id)
    if (!value) {
      value = computed(
        () => {
          const row = this.source(id)
          return row === LOADING ? LOADING : row === undefined ? null : issueReferenceModel(row)
        },
        { equals: compareStructural },
      )
      this.values.set(id, value)
      onBecomeUnobserved(value, () => this.values.delete(id))
    }
    return value.get()
  }

  /** The local replica supplies opaque ids. Displayed fields still come
   * through the ONE pool row reader and its cold-row load window. */
  resolved(ref: string, id: string | null): void {
    runInAction(() => this.requests.set(issueRefKey(ref), id))
  }

  dispose(): void {
    this.stopTable()
    runInAction(() => {
      for (const stop of this.stops.values()) stop()
      this.stops.clear()
      this.resident.clear()
      this.requests.clear()
      this.values.clear()
    })
  }
}
