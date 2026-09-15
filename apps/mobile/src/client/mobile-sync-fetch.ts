import type { StreamingFetchPort } from '@podium/client-core/sync-stream'
import type { WorkspaceSelector } from '@podium/client-core/transport'
import { fetch as expoFetch } from 'expo/fetch'
import { Platform } from 'react-native'
import { MobileAuthExpiredError } from './auth'
import { bearerHeaders } from './trpc'

export const MOBILE_SYNC_BUFFER_CAP = 512 * 1024

/** Only small identity responses can safely use a non-streaming implementation.
 * Compressed Content-Length bounds encoded bytes, not the allocation after decode. */
export async function requireMobileSyncStream(response: Response): Promise<Response> {
  if (response.body && typeof response.body.getReader === 'function') return response
  const length = response.headers.get('content-length')?.trim()
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  if (
    !length || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) ||
    Number(length) > MOBILE_SYNC_BUFFER_CAP || (encoding && encoding !== 'identity')
  ) {
    throw new Error('Sync requires streaming fetch; this response cannot be buffered safely.')
  }
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MOBILE_SYNC_BUFFER_CAP || bytes.byteLength !== Number(length)) {
    throw new Error('Sync response exceeded its declared size.')
  }
  const buffered = new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // RN's global Response need not expose a stream, even for a bounded body.
  Object.defineProperty(buffered, 'body', { value: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close() },
  }) })
  return buffered
}

export function createMobileSyncFetch(
  bearer: string | null,
  onAuthExpired?: (error: MobileAuthExpiredError) => void,
  selector?: WorkspaceSelector,
): StreamingFetchPort {
  return {
    async fetch(input, init) {
      const fetchImpl = Platform.OS === 'web' ? globalThis.fetch : expoFetch
      const response = await fetchImpl(input, {
        ...init,
        credentials: Platform.OS === 'web' ? 'include' : 'omit',
        headers: bearerHeaders(bearer, init.headers, selector),
      })
      // Preserve status so the shared source maps the refusal to SyncAuthExpiredError.
      if (response.status === 401) onAuthExpired?.(new MobileAuthExpiredError())
      if (!response.ok && response.status !== 409) return response
      // Never set Accept-Encoding: the native HTTP stack owns gzip negotiation.
      return requireMobileSyncStream(response)
    },
  }
}
