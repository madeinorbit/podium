import { createContentEncoder, type ContentCoding } from './content-coding'

export const SYNC_BODY_HIGH_WATER_MARK = 64 * 1024
/** abort interrupts a pending next(); return alone cannot interrupt an async generator. */
export interface SyncBodySource extends AsyncIterable<Uint8Array> {
  abort?(reason: unknown): void
}

/** Bounded byte queues plus at most one caller-owned source batch, never two. */
export function pipeSyncBody(
  source: SyncBodySource,
  coding: ContentCoding,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  const lifetime = new AbortController()
  let stopped = false
  let pending: Uint8Array | undefined
  let offset = 0
  const stop = (reason: unknown) => {
    if (stopped) return
    stopped = true
    pending = undefined
    signal.removeEventListener('abort', abort)
    lifetime.abort(reason)
    try { source.abort?.(reason) } finally {
      void Promise.resolve(iterator.return?.()).catch(() => {})
    }
  }
  let fail: (reason: unknown) => void
  const abort = () => { stop(signal.reason); fail(signal.reason) }
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      fail = (reason) => controller.error(reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      if (stopped) return
      try {
        if (!pending) {
          const next = await iterator.next()
          if (stopped) return
          if (next.done) {
            controller.close()
            return
          }
          pending = next.value
          offset = 0
        }
        const end = Math.min(offset + SYNC_BODY_HIGH_WATER_MARK, pending.byteLength)
        // Copy so queued slices cannot retain an entire large source batch.
        controller.enqueue(pending.slice(offset, end))
        offset = end
        if (offset === pending.byteLength) pending = undefined
      } catch (error) { stop(error); controller.error(error) }
    },
    cancel(reason) { stop(reason) },
  }, { highWaterMark: 0 })
  const encoder = createContentEncoder(coding)
  const encoded = encoder ? input.pipeThrough(encoder, { signal: lifetime.signal }) : input
  const reader = encoded.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          stopped = true
          signal.removeEventListener('abort', abort)
          controller.close()
        }
        else controller.enqueue(next.value)
      } catch (error) { stop(error); controller.error(error) }
    },
    async cancel(reason) { stop(reason); await reader.cancel(reason) },
  }, {
    highWaterMark: SYNC_BODY_HIGH_WATER_MARK,
    // Charge a full slot even for highly compressed bytes: a stalled reader
    // must not turn a small output queue into unbounded source read-ahead.
    size: (chunk) => Math.max(chunk?.byteLength ?? 0, SYNC_BODY_HIGH_WATER_MARK),
  })
}
