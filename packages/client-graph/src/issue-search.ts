import { createAtom, type IAtom, runInAction } from 'mobx'
import type { MobxPool } from './pool'

export interface IssueSearchInput {
  text: string
  repoPath?: string
}
export type IssueSearchQuery = (input: IssueSearchInput) => Promise<readonly { id: string }[]>

export interface IssueSearchResult {
  /** Device order first, followed by distinct server identities. */
  readonly ids: readonly string[]
  readonly serverIds: readonly string[]
  readonly pending: boolean
  /** A successful server answer covers history; offline results cover this device only. */
  readonly complete: boolean
}

const EMPTY: readonly string[] = Object.freeze([])
export const ISSUE_SEARCH_DEBOUNCE_MS = 150
export const ISSUE_SEARCH_MIN_LENGTH = 2

/** Demand-bound request answers shared by all issue search surfaces. Records
 * belong to the loader; only identities live here. Changing a query releases
 * its demand, cancels its debounce and makes any late reply inert. */
export class IssueSearch {
  private query: IssueSearchQuery | undefined
  private readonly requests = new Map<string, SearchRequest>()
  private readonly connection = createAtom('issueSearch.source')
  private disposed = false

  constructor(private readonly pool: MobxPool) {}

  bind(query: IssueSearchQuery): void {
    for (const request of this.requests.values()) request.dispose()
    this.requests.clear()
    this.query = query
    this.connection.reportChanged()
  }

  read(text: string, deviceIds: Iterable<string>, repoPath?: string): IssueSearchResult {
    this.connection.reportObserved()
    text = text.trim()
    const online = this.pool.collections.online
    const eligible = text.length >= ISSUE_SEARCH_MIN_LENGTH
    let answer: SearchRequest | undefined
    if (eligible && online && this.query && !this.disposed) {
      const input = { text, ...(repoPath !== undefined ? { repoPath } : {}) }
      const key = JSON.stringify(input)
      answer = this.requests.get(key)
      if (!answer) {
        answer = new SearchRequest(this.pool, input, this.query, () => this.requests.delete(key))
        this.requests.set(key, answer)
      }
      answer.observe()
    }
    const serverIds = answer?.ids ?? EMPTY
    return {
      ids: [...new Set([...deviceIds, ...serverIds])],
      serverIds,
      pending: answer?.pending ?? false,
      complete: answer?.complete ?? !this.pool.collections.available,
    }
  }

  dispose(): void {
    this.disposed = true
    for (const request of this.requests.values()) request.dispose()
    this.requests.clear()
    this.query = undefined
  }
}

/** The data layer owns request lifetime through the same observation boundary
 * as its local queries. Unobserved reads do no network work. */
class SearchRequest {
  readonly atom: IAtom
  ids: readonly string[] = EMPTY
  pending = true
  complete = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private observed = false
  private disposed = false

  constructor(
    private readonly pool: MobxPool,
    private readonly input: IssueSearchInput,
    private readonly query: IssueSearchQuery,
    private readonly released: () => void,
  ) {
    this.atom = createAtom(
      `issueSearch:${JSON.stringify(input)}`,
      () => {
        this.observed = true
        this.timer = setTimeout(() => void this.load(), ISSUE_SEARCH_DEBOUNCE_MS)
      },
      () => this.dispose(),
    )
  }

  observe(): void {
    if (!this.atom.reportObserved() && !this.observed) {
      // An imperative snapshot must not retain a request nobody watches.
      this.released()
    }
  }

  private async load(): Promise<void> {
    if (this.disposed || !this.pool.collections.online) return
    try {
      const hits = await this.query(this.input)
      if (this.disposed || !this.pool.collections.online) return
      runInAction(() => {
        this.ids = [...new Set(hits.map((hit) => hit.id))]
        this.pool.collections.adopt('issue', this.ids)
        this.complete = true
        this.pending = false
        this.atom.reportChanged()
      })
    } catch {
      // A failed/offline request leaves the device's answer usable.
      if (!this.disposed)
        runInAction(() => {
          this.pending = false
          this.atom.reportChanged()
        })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearTimeout(this.timer)
    this.released()
  }
}

export function issueSearch(pool: MobxPool): IssueSearch {
  return pool.sources.view('issueSearch', () => new IssueSearch(pool))
}
