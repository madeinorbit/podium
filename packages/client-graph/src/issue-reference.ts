import { type Lookup, omitGone } from './lookup'
import type { MobxPool } from './pool'
import { keyedComputed } from '@podium/mobx-helpers'
import {
  type IssueReferenceModel,
  type IssueReferenceSource,
  issueReferenceModel,
} from '@podium/client-core/values'
import { issueRefText, parseAnyRef } from '@podium/protocol'
import {
  compareStructural,
  createAtom,
  type IAtom,
  observable,
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
  row(entity: 'issue' | 'repo', id: string): Lookup<object>
  readonly queries: { issueReferenceId(token: string): string | undefined }
  readonly relations: Pick<RelationReader, 'one'>
}

export interface IssueReferenceReader {
  read(token: string): Loaded<IssueReferenceModel | null>
  id(token: string): Loaded<string | null>
}

/** The source owns canonical identity and alias precedence.
 * Each displayed token observes that keyed answer and one named model. No
 * resident table is enumerated or watched when this reader is constructed. */
export class IssueReferences implements IssueReferenceReader {
  private readonly requests = observable.map<string, string | null | typeof LOADING>(undefined, { deep: false })
  // side-state: signal: the demand atoms readers observe; a request answer is the observable requests map
  private readonly demand = new Map<string, { atom: IAtom; observed: boolean }>()
  private disposed = false
  // Reference projections construct a new record when their row changes.
  private readonly values = keyedComputed(() => undefined, (id: string): Loaded<IssueReferenceModel | null> => {
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

  constructor(
    private readonly host: IssueReferenceHost,
    private readonly queue: (ref: string) => void,
  ) {
    // Identity maintenance already belongs to the source's addressed index.
  }

  private source(id: string): Loaded<IssueReferenceSource> {
    const row = omitGone(this.host.row('issue', id))
    if (row === LOADING) return LOADING
    if (row === undefined) return undefined
    const issue = row as IssueReferenceSource
    const repoId = this.host.relations.one('issue', id, 'repo')
    const repo = repoId === null ? undefined : omitGone(this.host.row('repo', repoId))
    if (repo === LOADING) return LOADING
    const prefix = (repo as { prefix?: string | null } | undefined)?.prefix ?? issue.prefix
    return {
      id: issue.id,
      seq: issue.seq,
      title: issue.title,
      stage: issue.stage,
      closedReason: issue.closedReason,
      archived: issue.archived,
      deletedAt: issue.deletedAt,
      ...(prefix ? { prefix } : {}),
      // The repo relation owns canonical identity after normalization. A
      // temporary pre-projection input can still carry a real displayRef.
      displayRef:
        repoId !== null ? issueRefText(issue.seq, prefix) : issue.displayRef,
    }
  }

  id(token: string): Loaded<string | null> {
    if (parseAnyRef(token.trim())?.kind !== 'issue' && !/^#\d+$/.test(token.trim())) return null
    const key = issueRefKey(token)
    const known = this.host.queries.issueReferenceId(key)
    if (known !== undefined) return known
    let demand = this.demand.get(key)
    if (!demand) {
      const created = {
        observed: false,
        atom: createAtom(`pool.reference.${key}`, () => {
          created.observed = true
          // Demand is established by observation, never by an untracked read.
          // The microtask also lets a chip disappear before any load is queued.
          queueMicrotask(() => {
            if (!created.observed || this.disposed) return
            runInAction(() => this.requests.set(key, LOADING))
            this.queue(key)
          })
        }, () => {
          created.observed = false
          this.demand.delete(key)
          runInAction(() => this.requests.delete(key))
        }),
      }
      this.demand.set(key, created)
      demand = created
    }
    if (!demand.atom.reportObserved() && !demand.observed) this.demand.delete(key)
    const pending = this.requests.get(key)
    if (pending !== undefined) {
      if (typeof pending !== 'string') return pending
      const model = this.readById(pending)
      if (model === LOADING) return LOADING
      return model && issueRefKey(model.ref) === key ? pending : null
    }
    return LOADING
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
   * through the ONE pool row reader. */
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
    this.disposed = true
    runInAction(() => {
      for (const demand of this.demand.values()) demand.observed = false
      this.demand.clear()
      this.requests.clear()
      this.values.clear()
    })
  }
}

/** Reference chips and navigation share the screen-owned addressed view. */
export function referenceView(pool: MobxPool): IssueReferences {
  return pool.sources.view('references', () => new IssueReferences(pool, ref => pool.requestReference(ref)))
}
export function referenceViewIfPresent(pool: MobxPool): IssueReferences | undefined {
  return pool.sources.peekView<IssueReferences>('references')
}
