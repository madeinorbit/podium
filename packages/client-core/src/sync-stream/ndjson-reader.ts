import { SYNC_LINE_MAX_BYTES } from '@podium/protocol'
import { SyncCancelledError, SyncCorruptContentError, SyncLineTooLargeError, SyncNetworkError } from './errors'

/** No read-ahead: even a transport chunk containing many lines is decoded one line per pull. */
export async function* NdjsonLineReader(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let partial = ''
  let bytes = 0
  let ended = false
  const cancel = (): void => { void reader.cancel().catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  const checkAbort = (): void => { if (signal?.aborted) throw new SyncCancelledError() }
  const decode = (value?: Uint8Array, stream = false): string => {
    try { return decoder.decode(value, { stream }) }
    catch (cause) { throw new SyncCorruptContentError('invalid-utf8', { cause }) }
  }
  try {
    for (;;) {
      checkAbort()
      let next: ReadableStreamReadResult<Uint8Array>
      try { next = await reader.read() }
      catch (cause) {
        checkAbort()
        throw new SyncNetworkError('body-read-failed', { cause })
      }
      checkAbort()
      if (next.done) {
        ended = true
        partial += decode()
        if (bytes !== 0 || partial !== '') throw new SyncCorruptContentError('unterminated-line')
        return
      }
      const value = next.value
      let start = 0
      while (start < value.byteLength) {
        checkAbort()
        const lf = value.indexOf(10, start)
        const end = lf === -1 ? value.byteLength : lf
        const size = end - start
        // Check raw bytes BEFORE decoding, slicing or concatenating the partial line.
        if (size > SYNC_LINE_MAX_BYTES - bytes) throw new SyncLineTooLargeError()
        bytes += size
        partial += decode(value.subarray(start, end), true)
        if (lf === -1) break
        partial += decode()
        if (partial.includes('\r')) throw new SyncCorruptContentError('crlf-not-accepted')
        const line = partial
        partial = ''
        bytes = 0
        start = lf + 1
        yield line
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (!ended) cancel()
    reader.releaseLock()
  }
}
