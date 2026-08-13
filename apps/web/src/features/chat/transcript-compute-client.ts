import {
  computeTranscript,
  transcriptSearchState,
  type TranscriptComputeInput,
  type TranscriptComputeResult,
} from '@podium/client-core/viewmodels'
import type {
  TranscriptComputeWorkerError,
  TranscriptComputeWorkerRequest,
  TranscriptWorkerResponse,
} from './transcript-compute.worker'
import { renderMarkdownUnsafe } from '@/lib/markdown-renderer'

export interface WebTranscriptComputeResult extends TranscriptComputeResult {
  /** Unsafe worker HTML keyed by source Markdown. Sanitize before DOM use. */
  markdownHtml: ReadonlyMap<string, string>
}

interface TranscriptPending {
  kind: 'transcript'
  input: TranscriptComputeInput
  resolve: (result: WebTranscriptComputeResult) => void
  reject: (error: Error) => void
}

interface MarkdownPending {
  kind: 'markdown'
  text: string
  resolve: (html: string) => void
  reject: (error: Error) => void
}

type Pending = TranscriptPending | MarkdownPending

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
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        if (!message.ok) {
          pending.reject(new Error(message.error))
          return
        }
        if (message.kind === 'markdown') {
          if (pending.kind === 'markdown') {
            this.cacheMarkdown(pending.text, message.html)
            pending.resolve(message.html)
          }
          return
        }
        if (pending.kind !== 'transcript') return
        for (const [text, html] of message.markdown) {
          this.cacheMarkdown(text, html)
        }
        pending.resolve(this.stabilize(pending.input, message.result))
      }
      worker.onerror = (event) => {
        const error = new Error(event.message || 'transcript compute worker failed')
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
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
    if (
      this.stableGraph?.items === input.items &&
      this.stableGraph.verbosity === input.verbosity
    ) {
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

  computeMarkdownOnMain(text: string): string {
    return renderMarkdownUnsafe(text)
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

  compute(input: TranscriptComputeInput): Promise<WebTranscriptComputeResult> {
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(this.computeOnMain(input))
    const id = ++this.nextId
    const index = this.indexRequestFor(input)
    return new Promise<WebTranscriptComputeResult>((resolve, reject) => {
      this.pending.set(id, { kind: 'transcript', input, resolve, reject })
      if (index.needsIndex) {
        worker.postMessage({
          id,
          kind: 'index',
          indexKey: index.key,
          input,
        } satisfies TranscriptComputeWorkerRequest)
      } else {
        worker.postMessage({
          id,
          kind: 'search',
          indexKey: index.key,
          query: input.query,
          cursor: input.cursor,
        } satisfies TranscriptComputeWorkerRequest)
      }
    })
  }

  computeMarkdown(text: string): Promise<string> {
    const worker = this.ensureWorker()
    if (!worker) return Promise.resolve(this.computeMarkdownOnMain(text))
    const id = ++this.nextId
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { kind: 'markdown', text, resolve, reject })
      worker.postMessage({ id, kind: 'markdown', text })
    })
  }

  dispose(): void {
    for (const pending of this.pending.values()) pending.reject(new Error('disposed'))
    this.pending.clear()
    this.worker?.terminate()
    this.worker = undefined
    this.indexedSource = undefined
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
