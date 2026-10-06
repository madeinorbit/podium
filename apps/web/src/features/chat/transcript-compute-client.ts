import {
  computeTranscript,
  type TranscriptComputeInput,
  type TranscriptComputeResult,
  transcriptSearchState,
  type ChatVerbosity,
  type TranscriptSearchState,
} from '@podium/client-core/values'
import type { TranscriptGraph, TranscriptGraphChange } from '@podium/client-core/conversation'
import type {
  TranscriptComputeWorkerError,
  TranscriptComputeWorkerRequest,
  TranscriptWorkerResponse,
  TranscriptModelWorkerRequest,
} from './transcript-compute.worker'

export interface TranscriptGraphSource {
  readonly graph: TranscriptGraph
  readonly version: number
  readonly needsReset: boolean
  snapshot(): TranscriptComputeInput['items']
  pending(): TranscriptGraphChange
  sent(): void
}

export interface WebTranscriptGraphResult {
  search: TranscriptSearchState
  markdownHtml: ReadonlyMap<string, string>
}

interface GraphPending {
  kind: 'graph'
  source: TranscriptGraphSource
  query: string
  cursor: number
  verbosity: ChatVerbosity
  resolve: (result: WebTranscriptGraphResult) => void
  reject: (error: Error) => void
  release?: () => void
}

export interface WebTranscriptComputeResult extends TranscriptComputeResult {
  /** Unsafe worker HTML keyed by source Markdown. Sanitize before DOM use. */
  markdownHtml: ReadonlyMap<string, string>
}

interface TranscriptPending {
  delta?: TranscriptComputeOptions['delta']
  kind: 'transcript'
  input: TranscriptComputeInput
  resolve: (result: WebTranscriptComputeResult) => void
  reject: (error: Error) => void
  release?: () => void
}

export interface TranscriptComputeOptions {
  /** The model's atomic changed-items/order seam; use it only against its base. */
  delta?: { baseItems: TranscriptComputeInput['items']; changed: TranscriptComputeInput['items']; order: string[] }
  /** Each mounted pane owns its latest job, including panes of one session. */
  owner?: object
  signal?: AbortSignal
}

interface MarkdownPending {
  kind: 'markdown'
  text: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

type Pending = TranscriptPending | GraphPending | MarkdownPending

interface StableGraph {
  items: TranscriptComputeInput['items']
  verbosity: TranscriptComputeInput['verbosity']
  blocks: WebTranscriptComputeResult['blocks']
  rows: WebTranscriptComputeResult['rows']
}

// The loaded search window tops out at 1,000 transcript items. Leave room for
// split answers and message-envelope bodies too, otherwise appending one item
// to a deep window can churn the entire cache and put old visible rows back on
// the main-thread parser path.
const MARKDOWN_CACHE_LIMIT = 2_048

/**
 * One shared compute worker for all mounted chat panes. Transcript shaping and
 * search are pure client-core work; Markdown is rendered to unsafe HTML beside
 * them. The only value returned to React is structured data plus strings. A
 * missing Worker (tests, older embedded hosts, or worker construction failure)
 * falls back to the same pure index on the caller without changing behavior.
 */
export class TranscriptComputeClient {
  private worker: Worker | undefined
  private nextId = 0
  private nextIndexKey = 0
  private readonly pending = new Map<number, Pending>()
  private readonly queued = new Map<object, TranscriptPending | GraphPending>()
  private nextOwnerKey = 0
  private readonly modelSources = new Map<TranscriptGraphSource, { ownerKey: number; key: number | undefined; version: number }>()
  private readonly defaultOwner = {}
  private transcriptFlight: number | undefined
  private modelFlightSource: TranscriptGraphSource | undefined
  private readonly markdownHtml = new Map<string, string>()
  private stableGraph: StableGraph | undefined
  private indexedSource:
    | {
        items: TranscriptComputeInput['items']
        verbosity: TranscriptComputeInput['verbosity']
        key: number
      }
    | undefined
  private workerUnavailable = false

  get usesWorker(): boolean {
    return !this.workerUnavailable && typeof Worker === 'function'
  }

  private ensureWorker(): Worker | undefined {
    if (this.worker) return this.worker
    if (this.workerUnavailable || typeof Worker !== 'function') return undefined
    try {
      const worker = new Worker(new URL('./transcript-compute.worker.ts', import.meta.url), {
        type: 'module',
      })
      worker.onmessage = (
        event: MessageEvent<TranscriptWorkerResponse | TranscriptComputeWorkerError>,
      ) => {
        const message = event.data
        if (message.ok && (message.kind === 'transcript' || message.kind === 'model')) {
          for (const [text, html] of message.markdown) this.cacheMarkdown(text, html)
        }
        const pending = this.pending.get(message.id)
        if (this.transcriptFlight === message.id) {
          this.transcriptFlight = undefined
          if (!message.ok) {
            this.indexedSource = undefined
            const model = this.modelFlightSource ? this.modelSources.get(this.modelFlightSource) : undefined
            if (model) model.key = undefined
          }
          this.modelFlightSource = undefined
        }
        if (!pending) {
          this.dispatchNext()
          return
        }
        this.pending.delete(message.id)
        if (pending.kind !== 'markdown') pending.release?.()
        if (!message.ok) {
          if (pending.kind === 'graph') {
            const model = this.modelSources.get(pending.source)
            if (model) model.key = undefined
          }
          pending.reject(new Error(message.error))
          this.dispatchNext()
          return
        }
        if (message.kind === 'markdown') {
          if (pending.kind === 'markdown') {
            this.cacheMarkdown(pending.text, message.html)
            pending.resolve(message.html)
          }
          return
        }
        if (pending.kind === 'graph') {
          if (message.kind === 'model') pending.resolve({ search: message.search, markdownHtml: this.markdownHtml })
          else pending.reject(new Error('invalid transcript model response'))
          this.dispatchNext()
          return
        }
        if (pending.kind !== 'transcript') return
        if (message.kind !== 'transcript') {
          pending.reject(new Error('invalid transcript response'))
          this.dispatchNext()
          return
        }
        pending.resolve(this.stabilize(pending.input, message.result))
        this.dispatchNext()
      }
      worker.onerror = (event) => {
        const error = new Error(event.message || 'transcript compute worker failed')
        for (const pending of this.pending.values()) {
          if (pending.kind !== 'markdown') pending.release?.()
          pending.reject(error)
        }
        for (const job of this.queued.values()) {
          job.release?.()
          job.reject(error)
        }
        this.queued.clear()
        this.pending.clear()
        this.transcriptFlight = undefined
        this.modelFlightSource = undefined
        this.indexedSource = undefined
        this.modelSources.clear()
        worker.terminate()
        this.worker = undefined
        this.workerUnavailable = true
      }
      this.worker = worker
      return worker
    } catch {
      this.workerUnavailable = true
      return undefined
    }
  }

  computeOnMain(input: TranscriptComputeInput): WebTranscriptComputeResult {
    if (this.stableGraph?.items === input.items && this.stableGraph.verbosity === input.verbosity) {
      const { blocks, rows } = this.stableGraph
      return {
        blocks,
        rows,
        search: transcriptSearchState({
          blocks,
          rows,
          query: input.query,
          cursor: input.cursor,
        }),
        markdownHtml: this.markdownHtml,
      }
    }
    return this.stabilize(input, computeTranscript(input))
  }

  private cacheMarkdown(text: string, html: string): void {
    // Mirror the worker's insertion-ordered cache. Cache hits do not move either
    // side, keeping eviction deterministic even when streaming and transcript
    // requests interleave.
    if (this.markdownHtml.has(text)) return
    this.markdownHtml.set(text, html)
    while (this.markdownHtml.size > MARKDOWN_CACHE_LIMIT) {
      const oldest = this.markdownHtml.keys().next().value
      if (oldest === undefined) break
      this.markdownHtml.delete(oldest)
    }
  }

  private stabilize(
    input: TranscriptComputeInput,
    result: TranscriptComputeResult,
  ): WebTranscriptComputeResult {
    if (this.stableGraph?.items === input.items && this.stableGraph.verbosity === input.verbosity) {
      return {
        ...result,
        blocks: this.stableGraph.blocks,
        rows: this.stableGraph.rows,
        markdownHtml: this.markdownHtml,
      }
    }
    this.stableGraph = {
      items: input.items,
      verbosity: input.verbosity,
      blocks: result.blocks,
      rows: result.rows,
    }
    return { ...result, markdownHtml: this.markdownHtml }
  }

  private indexRequestFor(input: TranscriptComputeInput): { key: number; needsIndex: boolean } {
    if (
      this.indexedSource?.items === input.items &&
      this.indexedSource.verbosity === input.verbosity
    ) {
      return { key: this.indexedSource.key, needsIndex: false }
    }
    const key = ++this.nextIndexKey
    this.indexedSource = { items: input.items, verbosity: input.verbosity, key }
    return { key, needsIndex: true }
  }

  compute(
    input: TranscriptComputeInput,
    options: TranscriptComputeOptions = {},
  ): Promise<WebTranscriptComputeResult> {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(this.computeOnMain(input))
    return new Promise<WebTranscriptComputeResult>((resolve, reject) => {
      const owner = options.owner ?? this.defaultOwner
      const previous = this.queued.get(owner)
      if (previous) {
        previous.release?.()
        previous.reject(new DOMException('Superseded', 'AbortError'))
      }
      const job: TranscriptPending = { kind: 'transcript', input, delta: options.delta, resolve, reject }
      const abort = () => {
        if (this.queued.get(owner) === job) this.queued.delete(owner)
        for (const [id, pending] of this.pending) if (pending === job) this.pending.delete(id)
        job.release?.()
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      job.release = () => options.signal?.removeEventListener('abort', abort)
      this.queued.set(owner, job)
      this.dispatchNext()
    })
  }

  computeGraphOnMain(source: TranscriptGraphSource, query: string, cursor: number,
    verbosity: ChatVerbosity = 'normal'): WebTranscriptGraphResult {
    const search = source.graph.search(query, cursor, verbosity)
    source.sent()
    return { search, markdownHtml: this.markdownHtml }
  }

  computeGraph(source: TranscriptGraphSource, query: string, cursor: number,
    options: Pick<TranscriptComputeOptions, 'owner' | 'signal'> & { verbosity?: ChatVerbosity } = {},
  ): Promise<WebTranscriptGraphResult> {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'))
    const worker = this.ensureWorker()
    const verbosity = options.verbosity ?? 'normal'
    if (!worker) return Promise.resolve(this.computeGraphOnMain(source, query, cursor, verbosity))
    return new Promise<WebTranscriptGraphResult>((resolve, reject) => {
      const owner = options.owner ?? source
      const previous = this.queued.get(owner)
      if (previous) {
        previous.release?.()
        previous.reject(new DOMException('Superseded', 'AbortError'))
      }
      const job: GraphPending = { kind: 'graph', source, query, cursor, verbosity, resolve, reject }
      const abort = () => {
        if (this.queued.get(owner) === job) this.queued.delete(owner)
        for (const [id, pending] of this.pending) if (pending === job) this.pending.delete(id)
        job.release?.()
        reject(new DOMException('Cancelled', 'AbortError'))
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      job.release = () => options.signal?.removeEventListener('abort', abort)
      this.queued.set(owner, job)
      this.dispatchNext()
    })
  }

  forgetGraph(source: TranscriptGraphSource): void {
    const model = this.modelSources.get(source)
    this.modelSources.delete(source)
    if (model) this.worker?.postMessage({ id: 0, kind: 'forget-model', ownerKey: model.ownerKey })
  }

  private dispatchNext(): void {
    if (!this.worker || this.transcriptFlight !== undefined) return
    const entry = this.queued.entries().next().value
    if (!entry) return
    const [owner, job] = entry
    this.queued.delete(owner)
    const id = ++this.nextId
    if (job.kind === 'graph') {
      this.transcriptFlight = id
      this.modelFlightSource = job.source
      this.pending.set(id, job)
      let model = this.modelSources.get(job.source)
      if (!model) {
        model = { ownerKey: ++this.nextOwnerKey, key: undefined, version: -1 }
        this.modelSources.set(job.source, model)
      }
      try {
        const needsIndex = model.key === undefined || job.source.needsReset
        const changed = model.version !== job.source.version
        const key = needsIndex || changed ? ++this.nextIndexKey : model.key!
        const request: TranscriptModelWorkerRequest = {
          id, kind: 'model', ownerKey: model.ownerKey, indexKey: key,
          query: job.query, cursor: job.cursor, verbosity: job.verbosity,
          ...(needsIndex ? { items: job.source.snapshot() }
            : { baseIndexKey: model.key!, ...(changed ? { change: job.source.pending() } : {}) }),
        }
        this.worker.postMessage(request)
        model.key = key
        model.version = job.source.version
        job.source.sent()
      } catch (error) {
        this.pending.delete(id)
        this.transcriptFlight = undefined
        this.modelFlightSource = undefined
        model.key = undefined
        job.release?.()
        job.reject(error instanceof Error ? error : new Error(String(error)))
        this.dispatchNext()
      }
      return
    }
    const previous = this.indexedSource
    const index = this.indexRequestFor(job.input)
    this.transcriptFlight = id
    this.modelFlightSource = undefined
    this.pending.set(id, job)
    try {
      let request: TranscriptComputeWorkerRequest
      if (!index.needsIndex) {
        request = {
          id,
          kind: 'search',
          indexKey: index.key,
          query: job.input.query,
          cursor: job.input.cursor,
        }
      } else if (previous && previous.verbosity === job.input.verbosity) {
        const held = new Map(previous.items.map((item) => [item.id, item]))
        const { items, ...input } = job.input
        request = {
          id,
          kind: 'delta',
          baseIndexKey: previous.key,
          indexKey: index.key,
          changed: job.delta?.baseItems === previous.items ? [...job.delta.changed] : items.filter((item) => held.get(item.id) !== item),
          order: job.delta?.baseItems === previous.items ? job.delta.order : items.map((item) => item.id),
          input,
        }
      } else request = { id, kind: 'index', indexKey: index.key, input: job.input }
      this.worker.postMessage(request)
    } catch (error) {
      this.pending.delete(id)
      this.transcriptFlight = undefined
      this.indexedSource = undefined
      job.release?.()
      job.reject(error instanceof Error ? error : new Error(String(error)))
      this.dispatchNext()
    }
  }

  computeMarkdown(text: string, renderOnMain: (text: string) => string): Promise<string> {
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(renderOnMain(text))
    const id = ++this.nextId
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { kind: 'markdown', text, resolve, reject })
      worker.postMessage({ id, kind: 'markdown', text })
    })
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      if (pending.kind !== 'markdown') pending.release?.()
      pending.reject(new Error('disposed'))
    }
    for (const job of this.queued.values()) {
      job.release?.()
      job.reject(new Error('disposed'))
    }
    this.queued.clear()
    this.pending.clear()
    this.transcriptFlight = undefined
    this.modelFlightSource = undefined
    this.indexedSource = undefined
    this.modelSources.clear()
    this.worker?.terminate()
    this.worker = undefined
    this.stableGraph = undefined
  }
}

let sharedClient: TranscriptComputeClient | undefined

export function transcriptComputeClient(): TranscriptComputeClient {
  sharedClient ??= new TranscriptComputeClient()
  return sharedClient
}

export function resetTranscriptComputeClientForTests(): void {
  sharedClient?.dispose()
  sharedClient = undefined
}
