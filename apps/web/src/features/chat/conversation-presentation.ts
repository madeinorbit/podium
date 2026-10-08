import { type TranscriptChange, type TranscriptLog, type TranscriptGraphInsertion } from '@podium/client-core/conversation'
import { type ChatBlock, type ChatRow, type RenderableRow, type TranscriptSearchState } from '@podium/client-core/values'
import { action, actionBound, compareShallow, observable, observableRef, runInAction } from 'mobx'
import { companion, lazy } from '@podium/mobx-helpers'
import { TranscriptGraph } from '@podium/client-core/conversation'
import { transcriptComputeClient, type TranscriptGraphSource, type WebTranscriptGraphResult } from './transcript-compute-client'
import { rowIdentity } from './use-feed-arrivals'

export const RENDER_WINDOW = 300
export const INITIAL_LIMIT = 200
export const PAGE_LIMIT = 400
const EMPTY_SEARCH: TranscriptSearchState = { matches: [], activeMatch: undefined, activeRow: undefined, position: 0, total: 0, filtering: false }
const EMPTY_BLOCKS: ChatBlock[] = []
const EMPTY_ROWS: ChatRow[] = []

/** A source-owned transport journal survives coalesced and cancelled requests. */
class PresentationSource implements TranscriptGraphSource {
  version = 0
  needsReset = true
  private readonly changed = new Map<string, TranscriptLog['items'][number]>()
  private readonly insertions = new Map<string, TranscriptGraphInsertion>()
  private readonly removed = new Set<string>()
  constructor(readonly graph: TranscriptGraph, private readonly log: TranscriptLog) {}
  snapshot(): TranscriptLog['items'] { return this.log.items }
  record(change: TranscriptChange): void {
    if (!change.rebuild && !change.changed.length && !change.insertions?.length && !change.removed?.length) return
    this.version++
    if (change.rebuild) { this.clear(); this.needsReset = true; return }
    if (this.needsReset) return
    for (const item of change.changed) { this.changed.set(item.id, item); this.removed.delete(item.id) }
    for (const insertion of change.insertions ?? []) this.insertions.set(insertion.id, insertion)
    for (const id of change.removed ?? []) {
      this.changed.delete(id)
      this.insertions.delete(id)
      this.removed.add(id)
    }
  }
  pending() { return { changed: [...this.changed.values()], insertions: [...this.insertions.values()], removed: [...this.removed] } }
  sent(): void { this.clear(); this.needsReset = false }
  private clear(): void { this.changed.clear(); this.insertions.clear(); this.removed.clear() }
}

/** A mounted reader owns its worker demand, search and reading window. */
export class ConversationPresentation {
  @observableRef accessor result: WebTranscriptGraphResult | null = null
  @observable accessor query = ''
  @observable accessor cursor = 0
  @observable accessor renderCount = RENDER_WINDOW
  @observable accessor followTail = true
  @observable accessor deepeningSearch = false
  private log: TranscriptLog | undefined
  private graph: TranscriptGraph | undefined
  private ownsGraph = false
  private source: PresentationSource | undefined
  readonly renderedRow = companion((row: ChatRow) => new RenderedTranscriptRow(row, this))
  private readonly emptyMarkdown = new Map<string, string>()
  private request: AbortController | undefined
  private disposed = false
  private deepened = false
  @observable accessor heldHead: string | null = null

  constructor(private readonly client = transcriptComputeClient()) {
  }

  bind(log: TranscriptLog, graph?: TranscriptGraph): void {
    this.disposed = false
    this.log = log
    this.graph = graph ?? new TranscriptGraph(log.items)
    this.ownsGraph = graph === undefined
    this.source = new PresentationSource(this.graph, log)
    this.refresh()
  }
  /** Cold structural readers retained for explicit snapshot demands. */
  @lazy({ equals: compareShallow }) get blocks(): ChatBlock[] { return this.computeReady ? this.graph!.structuralBlocks : EMPTY_BLOCKS }
  @lazy({ equals: compareShallow }) get rows(): ChatRow[] { return this.computeReady ? this.graph!.structuralRows : EMPTY_ROWS }
  @lazy get blockCount(): number { return this.computeReady ? this.graph!.blockIds.length : 0 }
  @lazy get rowCount(): number { return this.computeReady ? this.graph!.rowIds.length : 0 }
  @lazy get rowVersion(): number { return this.graph?.version ?? 0 }
  @lazy get lastAnswer() { return this.computeReady ? this.graph!.lastAnswer : { blockIndex: -1, text: '' } }
  @lazy get headKey(): string {
    const id = this.log?.ids[0]
    return id === undefined ? '' : this.log?.byId.get(id)?.cursor ?? id
  }
  @lazy get pendingAskIndex(): number {
    if (!this.computeReady) return -1
    const id = this.graph?.pendingQuestionId
    return id === undefined ? -1 : this.graph!.blockPosition(id) ?? -1
  }
  @lazy({ equals: compareShallow }) get matches(): readonly string[] {
    return this.computeReady ? this.graph!.matches(this.query) : []
  }
  @lazy get search(): TranscriptSearchState {
    return this.computeReady ? this.graph!.positionSearch(this.matches, this.cursor, this.query.trim() !== '') : EMPTY_SEARCH
  }
  @lazy get renderStart(): number {
    const tail = Math.max(0, this.rowCount - this.renderCount)
    const held = !this.followTail && this.heldHead ? this.graph?.rowPosition(this.heldHead) : undefined
    return held === undefined ? tail : Math.min(tail, held)
  }
  @lazy({ equals: compareShallow }) get visibleRows(): ChatRow[] {
    if (!this.computeReady) return EMPTY_ROWS
    return this.graph!.rowIds.slice(this.renderStart).map(id => this.graph!.structuralRow(id)!)
  }
  @lazy get retainHistory(): boolean { return !this.followTail || this.query.trim() !== '' }
  @lazy get computeReady(): boolean { return this.result !== null }
  @lazy get markdownHtml(): ReadonlyMap<string, string> { return this.result?.markdownHtml ?? this.emptyMarkdown }

  block(id: string): ChatBlock | undefined { return this.computeReady ? this.graph?.block(id) : undefined }
  run(id: string) { return this.computeReady ? this.graph?.run(id) : undefined }
  @lazy get matchingRows(): ReadonlySet<string> {
    return new Set(this.computeReady ? this.matches
      .map(id => this.graph!.rowIdForBlock(id)!).filter(Boolean) : [])
  }
  rowMatches(id: string): boolean { return this.matchingRows.has(id) }
  revealRow = (key: string): number | undefined => this.computeReady ? this.graph?.revealRow(key) : undefined
  anchorRow = (key: string): number | undefined => {
    const id = this.graph?.rowIdForBlock(key)
    return id === undefined ? this.revealRow(key) : this.graph?.rowPosition(id)
  }
  tailRow(row: ChatRow | undefined): ChatRow | undefined {
    if (row?.kind !== 'tools') return row
    const run = this.run(row.blocks[0]!.item.id)
    const last = run?.lastBlock
    return last ? { kind: 'tools', blocks: [last], blockIndices: [], title: run.title } : row
  }

  renderRows(sticky: boolean, collapseContext: boolean): RenderableRow[] {
    return sticky ? collapseContext ? this.stickyContextRows : this.stickyRows : this.plainRows
  }
  @lazy({ equals: compareShallow }) private get plainRows(): RenderableRow[] { return this.buildRenderRows(false, false) }
  @lazy({ equals: compareShallow }) private get stickyRows(): RenderableRow[] { return this.buildRenderRows(true, false) }
  @lazy({ equals: compareShallow }) private get stickyContextRows(): RenderableRow[] { return this.buildRenderRows(true, true) }
  private buildRenderRows(sticky: boolean, collapseContext: boolean): RenderableRow[] {
    const rows: RenderableRow[] = []
    const start = this.renderStart
    const prompt = sticky && start > 0 ? this.graph?.operatorBefore(start, collapseContext) : undefined
    const rowId = prompt === undefined ? undefined : this.graph?.rowIdForBlock(prompt)
    if (rowId !== undefined) {
      const row = this.graph!.structuralRow(rowId)
      const index = this.graph!.rowPosition(rowId)
      if (row && index !== undefined) rows.push(this.renderedRow(row).value!)
    }
    this.visibleRows.forEach(row => rows.push(this.renderedRow(row).value!))
    return rows
  }

  @action changed(change: TranscriptChange): void {
    if (!this.source || !this.graph || !this.log || this.disposed) return
    if (this.ownsGraph) {
      if (change.rebuild) this.graph.reset(this.log.items)
      else this.graph.apply(change)
    }
    this.source.record(change)
    this.refresh()
  }
  @actionBound setQuery(query: string): void {
    this.query = query
    this.cursor = 0
    if (query.trim()) void this.ensureSearchDepth()
    this.refresh()
  }
  @actionBound moveCursor(delta: number): void {
    const total = Math.max(1, this.search.total)
    this.cursor = (this.cursor + delta + total) % total
    this.refresh()
  }
  @actionBound setRenderCount(value: number | ((count: number) => number)): void {
    this.renderCount = typeof value === 'function' ? value(this.renderCount) : value
  }
  @actionBound setFollowTail(follow: boolean): void {
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

  private refresh(): void {
    if (!this.source || this.disposed) return
    this.request?.abort()
    const request = this.request = new AbortController()
    const source = this.source
    const accept = (result: WebTranscriptGraphResult) => {
      if (this.disposed || request.signal.aborted || this.request !== request) return
      runInAction(() => { this.result = result; this.log?.markRendered() })
    }
    if (!this.client.usesWorker) { accept(this.client.computeGraphOnMain(source, this.query, this.cursor)); return }
    void this.client.computeGraph(source, this.query, this.cursor, { owner: this, signal: request.signal }).then(accept, () => {
      if (!request.signal.aborted) accept(this.client.computeGraphOnMain(source, this.query, this.cursor))
    })
  }
  dispose(): void {
    this.disposed = true
    this.request?.abort()
    if (this.source) this.client.forgetGraph(this.source)
    if (this.ownsGraph) this.graph?.dispose()
  }
}

class RenderedTranscriptRow {
  constructor(readonly row: ChatRow, private readonly presentation: ConversationPresentation) {}
  @lazy({ equals: (a: RenderableRow | undefined, b: RenderableRow | undefined) => a?.row === b?.row && a?.index === b?.index }) get value(): RenderableRow | undefined {
    const index = this.presentation.anchorRow(rowIdentity(this.row))
    return index === undefined ? undefined : { row: this.row, index }
  }
}
