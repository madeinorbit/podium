import { createAtom, type IAtom, runInAction } from 'mobx'
import type { MobxPool } from './pool'

export interface IssueSearchInput {
  text: string
  repoPath?: string
  /** The previous page's `next`; absent for the first page. */
  cursor?: string
}
/** One server page (POD-7108): the page's hits and the cursor that continues
 * it, `null` once the answer is complete. */
export interface IssueSearchPage {
  readonly hits: readonly { id: string }[]
  readonly next: string | null
}
export type IssueSearchQuery = (input: IssueSearchInput) => Promise<IssueSearchPage>

export interface IssueSearchResult {
  /** Device order first, followed by distinct server identities. */
  readonly ids: readonly string[]
  readonly serverIds: readonly string[]
  readonly pending: boolean
  /** A successful server answer covers history; offline results cover this device only. */
  readonly complete: boolean
  /** The server holds more hits than these; a larger `want` asks for them. */
  readonly more: boolean
}

const EMPTY: readonly string[] = Object.freeze([])
export const ISSUE_SEARCH_DEBOUNCE_MS = 150
export const ISSUE_SEARCH_MIN_LENGTH = 2
/** Server hits a view gets unless it asks for more: one server page (the
 * server's default page size). */
export const ISSUE_SEARCH_PAGE = 50

/** Demand-bound request answers shared by all issue search surfaces. Records
 * belong to the loader; only identities live here. Changing a query releases
 * its demand, cancels its debounce and makes any late reply inert.
 *
 * A request holds the server pages it was asked for, in order. A view that
 * scrolls past them reads with a larger `want`, and only then is the next
 * page requested. The view holds every loaded page's hits while it reads
 * them (POD-7158). */
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

  /** `want`: how many server hits the view can show (one page by default). */
  read(
    text: string,
    deviceIds: Iterable<string>,
    repoPath?: string,
    want = ISSUE_SEARCH_PAGE,
  ): IssueSearchResult {
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
      answer.want(want)
    }
    const serverIds = answer?.ids ?? EMPTY
    // The hits the view reads are held while it reads them (POD-7158).
    this.pool.collections.holdRecords('issue', serverIds)
    return {
      ids: [...new Set([...deviceIds, ...serverIds])],
      serverIds,
      pending: answer?.pending ?? false,
      complete: answer?.complete ?? !this.pool.collections.available,
      more: answer?.next != null,
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
  /** The cursor of the page after the loaded ones; `null` once complete,
   * `undefined` before the first page answered. */
  next: string | null | undefined = undefined
  private wanted = 0
  private loading = false
  /** A failed page stops paging, so a re-read cannot retry it in a loop. */
  private failed = false
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
        this.timer = setTimeout(() => void this.load(undefined), ISSUE_SEARCH_DEBOUNCE_MS)
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

  /** The next page loads only when a view wants more than the loaded pages
   * and the previous page has answered. */
  want(count: number): void {
    this.wanted = Math.max(this.wanted, count)
    const next = this.wantedNext()
    if (next) void this.load(next)
  }

  /** The cursor to load now, when a view wants hits past the loaded pages. */
  private wantedNext(): string | undefined {
    const ready = this.observed && !this.disposed && !this.loading && !this.failed
    return ready && typeof this.next === 'string' && this.ids.length < this.wanted
      ? this.next
      : undefined
  }

  private async load(cursor: string | undefined): Promise<void> {
    if (this.disposed || this.loading || !this.pool.collections.online) return
    this.loading = true
    try {
      const page = await this.query({ ...this.input, ...(cursor ? { cursor } : {}) })
      if (this.disposed || !this.pool.collections.online) return
      runInAction(() => {
        const held = new Set(this.ids)
        const added = [...new Set(page.hits.map((hit) => hit.id))].filter((id) => !held.has(id))
        this.ids = [...this.ids, ...added]
        this.next = page.next
        this.complete = true
        this.pending = false
        this.atom.reportChanged()
      })
    } catch {
      // A failed/offline request leaves the device's answer usable.
      this.failed = true
      if (!this.disposed)
        runInAction(() => {
          this.pending = false
          this.atom.reportChanged()
        })
    } finally {
      this.loading = false
    }
    // A view that asked for more while this page was loading gets the next one.
    const next = this.wantedNext()
    if (next) void this.load(next)
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
