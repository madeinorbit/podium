import { keyedComputed } from '@podium/mobx-helpers'
import {
  canonicalIssueRef,
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/values'
import { parseAnyRef } from '@podium/protocol'
import {
  compareStructural,
  observable,
  onBecomeUnobserved,
  runInAction,
} from 'mobx'
import type { RelationReader } from './shared/relation-reader'
import { LOADING, type Loaded } from './worklist/rollup'

export function issueRefKey(token: string): string {
  if (/^#\d+$/.test(token.trim())) return `#${Number(token.trim().slice(1))}`
  const parsed = parseAnyRef(token.trim())
  return parsed?.kind === 'issue' ? `${parsed.prefix}-${parsed.seq}` : token.trim()
}

/** Only the existing pool supplies rows and relations. No viewmodel list,
 * replica, old-record read or mutation owner is accepted by this seam. */
export interface IssueReferenceHost {
  row(entity: 'issue' | 'repo', id: string, mode?: 'summary-fields' | 'load'): Loaded<object>
  readonly queries: { issueReferenceId(token: string): string | undefined }
  readonly relations: Pick<RelationReader, 'one'>
}

export interface IssueReferenceReader {
  read(token: string): Loaded<IssueReferenceModel | null>
  id(token: string): Loaded<string | null>
}

/** The source owns canonical identity and cold/resident alias precedence.
 * Each displayed token observes that keyed answer and one named model. No
 * resident table is enumerated or watched when this reader is constructed. */
export class IssueReferences implements IssueReferenceReader {
  private readonly requests = observable.map<string, string | null | typeof LOADING>(undefined, { deep: false })
  private readonly requestStops = new Map<string, () => void>()
  // Reference projections construct a new record when their row changes.
  private readonly values = keyedComputed('issueReference', (id: string): Loaded<IssueReferenceModel | null> => {
    const row = this.source(id)
    return row === LOADING ? LOADING : row === undefined ? null : issueReferenceModel(row)
  }, { equals: compareStructural })

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
    if (this.requests.size === 0) return
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
    // Identity maintenance already belongs to the source's addressed index.
  }

  private source(id: string): Loaded<IssueReferenceSource> {
    const summary = this.host.row('issue', id, 'summary-fields')
    // A pool may declare only stage/residency fields for cold issues. A
    // reference needs identity and label fields too; load this named row
    // through the existing window when its declared summary is incomplete.
    const row = summary === LOADING || (summary && !['id', 'seq', 'title', 'stage'].every(field => Object.hasOwn(summary, field)))
      ? this.host.row('issue', id, 'load') : summary
    if (row === LOADING) return LOADING
    if (row === undefined) return undefined
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

  id(token: string): Loaded<string | null> {
    if (parseAnyRef(token.trim())?.kind !== 'issue' && !/^#\d+$/.test(token.trim())) return null
    const key = issueRefKey(token)
    const known = this.host.queries.issueReferenceId(key)
    if (known !== undefined) return known
    const pending = this.requests.get(key)
    if (pending !== undefined) {
      if (typeof pending !== 'string') return pending
      const model = this.readById(pending)
      if (model === LOADING) return LOADING
      return model && issueRefKey(model.ref) === key ? pending : null
    }
    runInAction(() => this.requests.set(key, LOADING))
    this.requestStops.set(key, onBecomeUnobserved(this.requests, key, () => {
      const stop = this.requestStops.get(key)
      this.requestStops.delete(key)
      stop?.()
      runInAction(() => this.requests.delete(key))
    }))
    this.queue(key)
    return this.requests.get(key)
  }

  read(token: string): Loaded<IssueReferenceModel | null> {
    const id = this.id(token)
    if (id === LOADING || id === null || id === undefined) return id
    return this.readById(id)
  }

  readById(id: string): Loaded<IssueReferenceModel | null> {
    return this.values(id)
  }

  /** The local replica supplies opaque ids. Displayed fields still come
   * through the ONE pool row reader and its cold-row load window. */
  resolved(ref: string, id: string | null): void {
    const key = issueRefKey(ref)
    // A queued window may finish after its chip disappeared. Its response
    // must not recreate offscreen demand that the last observer released.
    if (this.requests.has(key)) runInAction(() => this.requests.set(key, id))
  }

  hasRequest(ref: string): boolean {
    return this.requests.has(issueRefKey(ref))
  }

  dispose(): void {
    runInAction(() => {
      for (const stop of this.requestStops.values()) stop()
      this.requestStops.clear()
      this.requests.clear()
      this.values.clear()
    })
  }
}
