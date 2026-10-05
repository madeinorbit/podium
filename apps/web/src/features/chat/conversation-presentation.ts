import type { TranscriptChange, TranscriptLog } from '@podium/client-core/conversation'
import { type ChatBlock, type ChatRow, type TranscriptSearchState } from '@podium/client-core/values'
import { action, actionBound, compareStructural, computed, makeObservable, observable, observableRef, runInAction, type IComputedValue } from 'mobx'
import { transcriptComputeClient, type WebTranscriptComputeResult } from './transcript-compute-client'
import { rowIdentity } from './use-feed-arrivals'

export const RENDER_WINDOW = 300
export const INITIAL_LIMIT = 200
export const PAGE_LIMIT = 400
const EMPTY_SEARCH: TranscriptSearchState = { matches: [], activeMatch: undefined, activeRow: undefined, position: 0, total: 0, filtering: false }
const EMPTY_BLOCKS: ChatBlock[] = []
const EMPTY_ROWS: ChatRow[] = []

function blockShape(block: ChatBlock) {
  const { item } = block
  return [item.id, item.cursor, item.role, item.answer, item.systemKind, item.ts, item.toolName]
}
function sameRows(left: ChatRow[], right: ChatRow[]): boolean {
  return compareStructural(left.map(row => row.kind === 'tools'
    ? [rowIdentity(row), row.blockIndices, row.blocks.map(blockShape)]
    : [rowIdentity(row), row.blockIndex, blockShape(row.block)]), right.map(row => row.kind === 'tools'
    ? [rowIdentity(row), row.blockIndices, row.blocks.map(blockShape)]
    : [rowIdentity(row), row.blockIndex, blockShape(row.block)]))
}

/** Worker state belongs to the warm conversation, never to a mounted panel. */
export class ConversationPresentation {
  result: WebTranscriptComputeResult | null = null
  query = ''
  cursor = 0
  renderCount = RENDER_WINDOW
  followTail = true
  deepeningSearch = false
  private log: TranscriptLog | undefined
  private readonly client = transcriptComputeClient()
  private request: AbortController | undefined
  private lastItems: TranscriptLog['items'] = []
  private disposed = false
  private deepened = false
  private heldHead: string | null = null
  private readonly blockValues = new Map<string, IComputedValue<ChatBlock | undefined>>()

  constructor() {
    makeObservable<this, 'heldHead'>(this, {
      result: observableRef,
      query: observable, observableRef,
      cursor: observable, observableRef,
      renderCount: observable, observableRef,
      followTail: observable, observableRef,
      heldHead: observable, observableRef,
      deepeningSearch: observable, observableRef,
      changed: action,
      blocks: computed({ equals: (a: ChatBlock[], b: ChatBlock[]) => compareStructural(a.map(blockShape), b.map(blockShape)) }),
      rows: computed({ equals: sameRows }),
      blocksById: computed,
      computeReady: computed,
      markdownHtml: computed,
      search: computed({ equals: compareStructural }),
      renderStart: computed,
      visibleRows: computed({ equals: sameRows }),
      setQuery: actionBound,
      moveCursor: actionBound,
      setRenderCount: actionBound,
      setFollowTail: actionBound,
    })
  }

  bind(log: TranscriptLog): void {
    this.log = log
    this.refresh()
  }
  get blocks(): ChatBlock[] { return this.result?.blocks ?? EMPTY_BLOCKS }
  get rows(): ChatRow[] { return this.result?.rows ?? EMPTY_ROWS }
  get blocksById(): ReadonlyMap<string, ChatBlock> {
    return new Map((this.result?.blocks ?? EMPTY_BLOCKS).map(block => [block.item.id, block]))
  }
  get search(): TranscriptSearchState { return this.result?.search ?? EMPTY_SEARCH }
  get renderStart(): number {
    const tail = Math.max(0, this.rows.length - this.renderCount)
    const held = !this.followTail && this.heldHead ? this.rows.findIndex(row => rowIdentity(row) === this.heldHead) : -1
    return held >= 0 ? Math.min(tail, held) : tail
  }
  get visibleRows(): ChatRow[] { return this.renderStart ? this.rows.slice(this.renderStart) : this.rows }
  get retainHistory(): boolean { return !this.followTail || this.query.trim() !== '' }
  get computeReady(): boolean { return this.result !== null }
  get markdownHtml(): ReadonlyMap<string, string> { return this.result?.markdownHtml ?? new Map() }

  /** Each observed row tracks its own frozen item and worker folding metadata. */
  block(id: string): ChatBlock | undefined {
    let value = this.blockValues.get(id)
    if (!value) {
      value = computed(() => {
        const item = this.log?.byId.get(id)
        const indexed = this.blocksById.get(id)
        if (!item || !indexed) return undefined
        return {
          ...indexed,
          item: {
            ...item,
            ...(indexed.item.toolPaths?.length ? { toolPaths: indexed.item.toolPaths } : {}),
            ...(indexed.item.tags?.length ? { tags: indexed.item.tags } : {}),
            ...(indexed.item.toolEffects ? { toolEffects: indexed.item.toolEffects } : {}),
          },
        }
      }, { equals: compareStructural })
      this.blockValues.set(id, value)
    }
    return value.get()
  }

  changed(change: TranscriptChange): void { this.refresh(change) }
  setQuery(query: string): void {
    this.query = query
    this.cursor = 0
    if (query.trim()) void this.ensureSearchDepth()
    this.refresh()
  }
  moveCursor(delta: number): void {
    const total = Math.max(1, this.search.total)
    this.cursor = (this.cursor + delta + total) % total
    this.refresh()
  }
  setRenderCount(value: number | ((count: number) => number)): void {
    this.renderCount = typeof value === 'function' ? value(this.renderCount) : value
  }
  setFollowTail(follow: boolean): void {
    if (follow === this.followTail) return
    this.heldHead = follow ? null : this.visibleRows[0] ? rowIdentity(this.visibleRows[0]) : null
    this.followTail = follow
    if (follow) this.renderCount = RENDER_WINDOW
  }
  async loadOlder(): Promise<void> {
    if (this.renderStart > 0) { this.setRenderCount(count => count + RENDER_WINDOW); return }
    const log = this.log
    if (!log || log.loadingOlder || !log.hasMoreOlder || log.head === undefined) return
    const before = log.ids.length
    if (await log.loadOlder()) this.setRenderCount(count => count + Math.max(1, log.ids.length - before))
  }
  private async ensureSearchDepth(): Promise<void> {
    if (this.deepened || !this.log) return
    this.deepened = true
    runInAction(() => { this.deepeningSearch = true })
    try {
      const log = this.log
      while (!this.disposed && log.ids.length < 1000 && log.hasMoreOlder && !log.loadingOlder && log.head !== undefined)
        if (!(await log.loadOlder())) break
    } catch { this.deepened = false }
    finally { runInAction(() => { this.deepeningSearch = false }) }
  }

  private refresh(change?: TranscriptChange): void {
    if (!this.log || this.disposed) return
    this.request?.abort()
    const request = this.request = new AbortController()
    const input = { items: this.log.items, verbosity: 'normal' as const, query: this.query, cursor: this.cursor }
    const delta = change ? { baseItems: this.lastItems, changed: change.changed, order: this.log.ids.slice() } : undefined
    this.lastItems = input.items
    const accept = (result: WebTranscriptComputeResult) => {
      if (this.disposed || request.signal.aborted || this.request !== request) return
      runInAction(() => {
        this.result = result
        this.log?.markRendered()
      })
      for (const id of this.blockValues.keys()) if (!this.log?.byId.has(id)) this.blockValues.delete(id)
    }
    if (!this.client.usesWorker) { accept(this.client.computeOnMain(input)); return }
    void this.client.compute(input, { owner: this, signal: request.signal, delta }).then(accept, () => {
      if (!request.signal.aborted) accept(this.client.computeOnMain(input))
    })
  }
  dispose(): void {
    this.disposed = true
    this.request?.abort()
    this.blockValues.clear()
  }
}
