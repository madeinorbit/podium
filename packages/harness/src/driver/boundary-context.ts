/** Context requested by a provider at an existing execution boundary. This is
 * not a turn: callers must return the text through the provider's hidden context
 * response, never send it as a user prompt. */
export type BoundaryContextEvent = 'start' | 'prompt' | 'before-compaction'
export interface BoundaryContextRequest {
  event: BoundaryContextEvent
  /** The provider response deadline/disconnect cancels the attempt. */
  signal?: AbortSignal
}
export type BoundaryContextOperation = (request: BoundaryContextRequest) => Promise<string | null>
export type BoundaryContextSource = () => Promise<{ ok: boolean; result?: unknown }>

/** One controller per session incarnation. A failed/expired fetch stays armed;
 * compaction or reset fences late results from the previous context. */
export function createBoundaryContext(source: BoundaryContextSource): {
  respond: BoundaryContextOperation
  reset(): void
} {
  let generation = 0
  let primed = false
  let pending: object | undefined
  const reset = () => {
    generation++
    primed = false
    pending = undefined
  }
  return {
    reset,
    async respond({ event, signal }) {
      if (event === 'before-compaction') {
        reset()
        return null
      }
      if (signal?.aborted || primed || pending) return null
      const attempt = {}
      const epoch = generation
      pending = attempt
      const cancel = () => {
        if (pending === attempt) pending = undefined
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        const result = await source()
        if (signal?.aborted || epoch !== generation || pending !== attempt) return null
        if (!result.ok || typeof result.result !== 'string' || result.result.length === 0)
          return null
        primed = true
        return result.result
      } catch {
        return null
      } finally {
        cancel()
        signal?.removeEventListener('abort', cancel)
      }
    },
  }
}
