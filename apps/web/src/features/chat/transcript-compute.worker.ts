import {
  computeTranscript,
  parseEnvelopeBatch,
  transcriptSearchState,
  type TranscriptComputeInput,
  type TranscriptComputeResult,
} from '@podium/client-core/viewmodels'
import { renderMarkdownUnsafe } from '@/lib/markdown-renderer'

export interface TranscriptIndexWorkerRequest {
  id: number
  kind: 'index'
  indexKey: number
  input: TranscriptComputeInput
}

export interface TranscriptSearchWorkerRequest {
  id: number
  kind: 'search'
  indexKey: number
  query: string
  cursor: number
}

export interface TranscriptMarkdownWorkerRequest {
  id: number
  kind: 'markdown'
  text: string
}

export type TranscriptComputeWorkerRequest =
  | TranscriptIndexWorkerRequest
  | TranscriptSearchWorkerRequest
  | TranscriptMarkdownWorkerRequest

export interface TranscriptComputeWorkerResponse {
  id: number
  kind: 'transcript'
  ok: true
  result: TranscriptComputeResult
  /** Unsafe HTML only. The browser sanitizes it after it crosses back. */
  markdown: Array<[text: string, html: string]>
}

export interface TranscriptMarkdownWorkerResponse {
  id: number
  kind: 'markdown'
  ok: true
  /** Unsafe HTML only. The browser sanitizes it after it crosses back. */
  html: string
}

export type TranscriptWorkerResponse =
  | TranscriptComputeWorkerResponse
  | TranscriptMarkdownWorkerResponse

export interface TranscriptComputeWorkerError {
  id: number
  kind: 'markdown' | 'transcript'
  ok: false
  error: string
}

interface TranscriptWorkerScope {
  onmessage: (event: MessageEvent<TranscriptComputeWorkerRequest>) => void
  postMessage: (message: unknown) => void
}

const scope = self as unknown as TranscriptWorkerScope
const MARKDOWN_CACHE_LIMIT = 2_048
const markdownCache = new Map<string, string>()
let indexed:
  | {
      indexKey: number
      verbosity: TranscriptComputeInput['verbosity']
      result: Pick<TranscriptComputeResult, 'blocks' | 'rows'>
    }
  | undefined

function renderCachedMarkdown(text: string): { html: string; rendered: boolean } {
  const cached = markdownCache.get(text)
  if (cached !== undefined) {
    return { html: cached, rendered: false }
  }
  const html = renderMarkdownUnsafe(text)
  markdownCache.set(text, html)
  while (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value
    if (oldest === undefined) break
    markdownCache.delete(oldest)
  }
  return { html, rendered: true }
}

function markdownSources(input: TranscriptComputeInput): string[] {
  const sources = new Set<string>()
  for (const item of input.items) {
    if (item.text) sources.add(item.text)
    if (item.role === 'assistant' && item.answer) {
      const lines = item.text.trimEnd().split('\n')
      const last = lines[lines.length - 1]?.trim() ?? ''
      if (/^(?:→|->)\s*next:/i.test(last)) sources.add(lines.slice(0, -1).join('\n'))
    }
    if (item.role !== 'user') continue
    const batch = parseEnvelopeBatch(item.text)
    if (!batch) continue
    if (batch.operatorText) sources.add(batch.operatorText)
    for (const envelope of batch.envelopes) {
      if (envelope.body) sources.add(envelope.body)
    }
  }
  return [...sources]
}

scope.onmessage = (event: MessageEvent<TranscriptComputeWorkerRequest>) => {
  const request = event.data
  try {
    if ('kind' in request && request.kind === 'markdown') {
      scope.postMessage({
        id: request.id,
        kind: 'markdown',
        ok: true,
        html: renderCachedMarkdown(request.text).html,
      } satisfies TranscriptMarkdownWorkerResponse)
      return
    }
    const indexKey = request.indexKey
    if (request.kind === 'index') {
      indexed = {
        indexKey,
        verbosity: request.input.verbosity,
        result: computeTranscript({ ...request.input, query: '', cursor: 0 }),
      }
    } else if (!indexed || indexed.indexKey !== indexKey) {
      throw new Error('transcript search requested before its index was ready')
    }
    const input = request.kind === 'index' ? request.input : undefined
    const query = request.kind === 'index' ? request.input.query : request.query
    const cursor = request.kind === 'index' ? request.input.cursor : request.cursor
    const base = indexed?.indexKey === indexKey ? indexed.result : undefined
    if (!base) throw new Error('transcript index unavailable')
    const result: TranscriptComputeResult = {
      ...base,
      search: transcriptSearchState({
        blocks: base.blocks,
        rows: base.rows,
        query,
        cursor,
      }),
    }
    const markdown: Array<[string, string]> = []
    if (input) {
      for (const text of markdownSources(input)) {
        const rendered = renderCachedMarkdown(text)
        // The client mirrors every newly rendered cache entry. Cached entries
        // were already delivered by the response that created them, so sending
        // them again would structured-clone the whole transcript on each append.
        if (rendered.rendered) markdown.push([text, rendered.html])
      }
    }
    scope.postMessage({
      id: request.id,
      kind: 'transcript',
      ok: true,
      result,
      markdown,
    } satisfies TranscriptComputeWorkerResponse)
  } catch (error) {
    scope.postMessage({
      id: request.id,
      kind: request.kind === 'markdown' ? 'markdown' : 'transcript',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies TranscriptComputeWorkerError)
  }
}
